//! Buying briefs, durable search execution, and observed host scheduling.
//! All mutations use the workspace's writer transaction; reads only project expiry.
use crate::{
    contracts,
    error::{Error, Result},
    storage::Workspace,
    util::{canonical, hash, id, iso, time},
};
use chrono::{DateTime, Duration, LocalResult, NaiveTime, TimeZone, Timelike};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub const SEARCH_LEASE_MS: i64 = 300_000;
pub const ACTIONS: &[&str] = &[
    "request_search_run",
    "update_search_run",
    "claim_search_run",
    "renew_search_lease",
    "cancel_search_run",
    "set_monitoring",
    "report_host_schedule",
    "report_dispatcher_schedule",
    "request_scheduled_batch",
    "get_dispatcher_context",
    "check_scheduled_search",
    "list_search_runs",
];
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn equal(left: &Value, right: &Value) -> bool {
    if let (Some(a), Some(b)) = (left.as_f64(), right.as_f64()) {
        a == b
    } else {
        left == right
    }
}
fn n(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}
fn b(v: &Value) -> bool {
    v.as_bool().unwrap_or(false)
}
fn strings(v: &Value) -> Vec<String> {
    a(v).iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(Error::validation(message.into()))
}
fn active(run: &Value) -> bool {
    ["requested", "discovering", "verifying"].contains(&s(&run["phase"]))
}
fn resumable(run: &Value) -> bool {
    active(run) || ["partial", "blocked", "deferred"].contains(&s(&run["phase"]))
}
fn bump(run: &mut Value, now: i64) {
    run["version"] = json!(n(&run["version"]) + 1);
    run["updated_at"] = json!(iso(now));
}
fn search<'a>(config: &'a Value, id: &str) -> Option<&'a Value> {
    a(&config["searches"]).iter().find(|v| s(&v["id"]) == id)
}
fn monitoring<'a>(config: &'a Value, id: &str) -> Option<&'a Value> {
    a(&config["monitoring"])
        .iter()
        .find(|v| s(&v["search_id"]) == id)
}
fn dispatcher<'a>(config: &'a Value, id: &str) -> Option<&'a Value> {
    a(&config["dispatchers"])
        .iter()
        .find(|v| a(&v["search_ids"]).iter().any(|x| s(x) == id))
}

pub fn validate_definition(input: &Value) -> Result<Value> {
    let d = contracts::parse("searchDefinitionSchema", input)?;
    for value in std::iter::once(&d["category"]).chain(a(&d["comparison_attributes"])) {
        if ["constructor", "prototype"].contains(&s(value)) {
            return invalid("Choose a different field ID");
        }
    }
    let mut seen = HashSet::new();
    let mut decisions = HashSet::new();
    for field in a(&d["fields"]) {
        let fid = s(&field["id"]);
        let kind = s(&field["type"]);
        let label = s(&field["label"]);
        if ["constructor", "prototype"].contains(&fid) {
            return invalid("Choose a different field ID");
        }
        if !field["decision_id"].is_null() && !decisions.insert(s(&field["decision_id"])) {
            return invalid("Questions must resolve distinct decisions");
        }
        if !field["visible_when"].is_null() && !seen.contains(s(&field["visible_when"]["field"])) {
            return invalid("Conditional fields must refer to an earlier field");
        }
        if !seen.insert(fid) {
            return invalid("Field IDs must be unique");
        }
        if b(&field["required"]) && s(&field["question_stage"]) == "refinement" {
            return invalid(format!("{label}: required answers belong in setup"));
        }
        if let (Some(lo), Some(hi)) = (field["minimum"].as_f64(), field["maximum"].as_f64())
            && lo > hi
        {
            return invalid(format!("{label}: minimum exceeds maximum"));
        }
        if ["single_choice", "multiple_choice"].contains(&kind) && field["options"].is_null() {
            return invalid(format!("{label} needs choices"));
        }
        if !field["options"].is_null() {
            if ["text", "location", "range"].contains(&kind) {
                return invalid(format!("{label}: use a choice field for options"));
            }
            let mut choices = HashSet::new();
            for option in a(&field["options"]) {
                let value = &option["value"];
                if !choices.insert(canonical(value)) || s(value).starts_with("__") {
                    return invalid(format!("{label} needs unique, nonreserved choices"));
                }
                if kind == "boolean" && !value.is_boolean() {
                    return invalid("Boolean choices must use true or false");
                }
                if kind == "multiple_choice" && !value.is_string() {
                    return invalid("Multiple choices must use string values");
                }
                if ["integer", "number"].contains(&kind) && !value.is_number() {
                    return invalid("Numeric choices must use numbers");
                }
            }
        }
        if ["constructor", "prototype"].contains(&s(&field["match"]["attribute"]))
            || ["constructor", "prototype"].contains(&s(&field["decision_id"]))
        {
            return invalid("Choose a different field ID");
        }
        let op = s(&field["match"]["operator"]);
        if !op.is_empty()
            && ((["gte", "lte"].contains(&op) && !["integer", "number"].contains(&kind))
                || (["in", "contains_any"].contains(&op) && kind != "multiple_choice")
                || (op == "range" && kind != "range")
                || (kind == "range" && op != "range")
                || (kind == "multiple_choice" && !["in", "contains_any"].contains(&op)))
        {
            return invalid(format!("{label}: matching operator does not fit its type"));
        }
    }
    if strings(&d["comparison_attributes"])
        .iter()
        .collect::<HashSet<_>>()
        .len()
        != a(&d["comparison_attributes"]).len()
    {
        return invalid("Comparison attributes must be unique");
    }
    Ok(d)
}
pub fn is_visible(field: &Value, answers: &Value, definition: &Value) -> bool {
    // Definitions require backward-only conditions; cap traversal for unvalidated callers.
    fn check(f: &Value, ans: &Value, d: &Value, depth: usize) -> bool {
        if depth > 30 {
            return false;
        }
        let c = &f["visible_when"];
        if c.is_null() {
            return true;
        }
        let parent = a(&d["fields"]).iter().find(|v| v["id"] == c["field"]);
        parent.is_none_or(|p| check(p, ans, d, depth + 1))
            && a(&c["one_of"])
                .iter()
                .any(|v| equal(v, &ans[s(&c["field"])]))
    }
    check(field, answers, definition, 0)
}
pub fn answer_error(field: &Value, value: Option<&Value>) -> Option<String> {
    let null = Value::Null;
    let value = value.unwrap_or(&null);
    let label = s(&field["label"]);
    if value.is_null() || value.as_str() == Some("") || value.as_array().is_some_and(Vec::is_empty)
    {
        return b(&field["required"]).then(|| format!("{label} is required"));
    }
    let numeric = |v: &Value| {
        v.as_f64().is_some_and(|x| {
            x.is_finite()
                && field["minimum"].as_f64().is_none_or(|m| x >= m)
                && field["maximum"].as_f64().is_none_or(|m| x <= m)
        })
    };
    let error = match s(&field["type"]) {
        "text" | "location" => value
            .as_str()
            .is_none_or(|v| v.trim().is_empty())
            .then(|| format!("{label} needs text")),
        "number" | "integer" => (!numeric(value)
            || (field["type"] == "integer" && !value.as_f64().is_some_and(|v| v.fract() == 0.0)))
        .then(|| {
            format!(
                "{label} needs a valid {}",
                if field["type"] == "integer" {
                    "whole number"
                } else {
                    "number"
                }
            )
        }),
        "boolean" => (!value.is_boolean()).then(|| format!("{label} needs Yes or No")),
        "single_choice" => (!a(&field["options"])
            .iter()
            .any(|v| equal(&v["value"], value)))
        .then(|| format!("Choose an option for {label}")),
        "multiple_choice" => (!value.is_array()
            || a(value).iter().map(canonical).collect::<HashSet<_>>().len() != a(value).len()
            || a(value)
                .iter()
                .any(|v| !a(&field["options"]).iter().any(|o| equal(&o["value"], v))))
        .then(|| format!("Choose valid options for {label}")),
        "range" => (!value.is_object()
            || (value.get("min").is_none() && value.get("max").is_none())
            || value.get("min").is_some_and(|v| !numeric(v))
            || value.get("max").is_some_and(|v| !numeric(v))
            || matches!((value["min"].as_f64(),value["max"].as_f64()),(Some(lo),Some(hi)) if lo>hi))
        .then(|| format!("{label} needs a valid range")),
        _ => None,
    };
    if error.is_some() {
        return error;
    }
    if field["match"]["attribute"] == "seller_listing_count" {
        let counts: Vec<&Value> = if let Some(o) = value.as_object() {
            o.values().collect()
        } else if let Some(v) = value.as_array() {
            v.iter().collect()
        } else {
            vec![value]
        };
        if counts.iter().any(|v| {
            !v.as_f64()
                .is_some_and(|x| x >= 0.0 && x.fract() == 0.0 && x <= 9_007_199_254_740_991.0)
        }) {
            return Some(format!("{label} needs whole numbers of zero or more"));
        }
    }
    None
}
pub fn clean_answers(definition: &Value, input: &Value, partial: bool) -> Result<Value> {
    let answers = contracts::parse("answersSchema", input)?;
    let fields = a(&definition["fields"]);
    let mut errors = Vec::new();
    let mut out = Map::new();
    for key in answers
        .as_object()
        .ok_or_else(|| Error::validation("Answers must be an object"))?
        .keys()
    {
        if !fields.iter().any(|f| s(&f["id"]) == key) {
            errors.push(format!("Unknown field: {key}"))
        }
    }
    for field in fields {
        let fid = s(&field["id"]);
        if !is_visible(field, &answers, definition) {
            continue;
        }
        let value = answers.get(fid);
        if !(partial && value.is_none())
            && let Some(e) = answer_error(field, value)
        {
            errors.push(e)
        }
        if let Some(v) = value {
            let cleaned = match v {
                Value::String(t) => {
                    if t.trim().is_empty() {
                        Value::Null
                    } else {
                        json!(t.trim())
                    }
                }
                Value::Array(x) if x.is_empty() => Value::Null,
                _ => v.clone(),
            };
            out.insert(fid.into(), cleaned);
        }
    }
    if !errors.is_empty() {
        return invalid(errors.join("; "));
    }
    Ok(Value::Object(out))
}
pub fn normalize_search(input: &Value) -> Result<Value> {
    if !input.is_object() {
        return invalid("Search must be an object");
    }
    let mut candidate = input.clone();
    if candidate["id"].is_null() {
        candidate["id"] = json!(format!("search-{}", &id()[..8]))
    }
    if candidate["enabled"].is_null() {
        candidate["enabled"] = json!(true)
    }
    let mut saved = contracts::parse("savedSearchSchema", &candidate)?;
    validate_definition(&saved["definition"])?;
    validate_discovery(&saved["discovery"])?;
    if !saved["cover"].is_null() {
        validate_cover(&saved["cover"])?;
    }
    if saved["product"] != saved["definition"]["category"] {
        return invalid("Search needs a matching category");
    }
    saved["values"] = clean_answers(&saved["definition"], &saved["values"], false)?;
    // Persist the validated caller definition, not UI defaults introduced while parsing.
    saved["definition"] = validate_definition(&input["definition"])?;
    let markets = strings(&saved["marketplaces"]);
    if markets.iter().collect::<HashSet<_>>().len() != markets.len() {
        return invalid("Marketplaces must be unique");
    }
    Ok(saved)
}
pub fn interview_fields(
    definition: &Value,
    answers: &Value,
    stage: &str,
    refinements: Option<&[String]>,
    uncertain: &[String],
) -> Vec<Value> {
    let fields: Vec<_> = a(&definition["fields"])
        .iter()
        .filter(|f| {
            is_visible(f, answers, definition)
                && answers.get(s(&f["id"])).is_none()
                && !uncertain.iter().any(|x| x == s(&f["id"]))
        })
        .collect();
    let setup = |f: &&Value| {
        s(&f["question_stage"]) == "setup" || (f["question_stage"].is_null() && b(&f["required"]))
    };
    let mut out: Vec<Value> = fields
        .iter()
        .filter(|f| setup(f))
        .map(|f| (*f).clone())
        .collect();
    if stage == "refinement" {
        out.extend(
            fields
                .iter()
                .filter(|f| {
                    !setup(f) && refinements.is_none_or(|r| r.iter().any(|x| x == s(&f["id"])))
                })
                .map(|f| (*f).clone()),
        )
    }
    out
}
pub fn native_question(field: &Value, custom: bool) -> Value {
    let fid = s(&field["id"]);
    let title = if field["unit"].is_string() {
        format!("{} ({})", s(&field["label"]), s(&field["unit"]))
    } else {
        s(&field["label"]).into()
    };
    let kind = s(&field["type"]);
    let required = b(&field["required"]);
    let divisor = field["display_divisor"].as_f64().unwrap_or(1.0);
    let mut props = Map::new();
    let mut mandatory = Vec::new();
    if !custom && (!field["options"].is_null() || kind == "boolean" || b(&field["allow_unsure"])) {
        if kind == "multiple_choice" {
            let mut choices: Vec<Value> = a(&field["options"])
                .iter()
                .map(|o| json!({"const":s(&o["value"]),"title":o["label"]}))
                .collect();
            if b(&field["allow_unsure"]) {
                choices.push(json!({"const":"__not_sure__","title":"Not sure — help me choose"}))
            }
            props.insert(fid.into(),json!({"type":"array","title":title,"items":{"anyOf":choices},"minItems":if required{1}else{0},"maxItems":if field["options"].is_array(){a(&field["options"]).len()}else{30}}));
            if required {
                mandatory.push(fid.to_owned())
            }
        } else {
            let opts = if !field["options"].is_null() {
                field["options"].clone()
            } else if kind == "boolean" {
                json!([{"value":true,"label":"Yes"},{"value":false,"label":"No"}])
            } else {
                json!([])
            };
            let mut choices: Vec<Value> = a(&opts)
                .iter()
                .map(|o| json!({"const":o["value"].to_string(),"title":o["label"]}))
                .collect();
            if ["number", "integer"].contains(&kind) || choices.is_empty() {
                choices.push(json!({"const":"__custom__","title":"Another value"}))
            }
            if b(&field["allow_unsure"]) {
                choices.push(json!({"const":"__not_sure__","title":"Not sure — help me choose"}))
            }
            if !required {
                choices.push(json!({"const":"__no_preference__","title":"No preference"}))
            }
            props.insert(
                fid.into(),
                json!({"type":"string","title":title,"oneOf":choices}),
            );
            mandatory.push(fid.into());
        }
    } else if kind == "range" {
        for bound in ["min", "max"] {
            let mut p = json!({"type":"number","title":format!("{title}: {}",if bound=="min"{"minimum"}else{"maximum"})});
            for k in ["minimum", "maximum"] {
                if let Some(v) = field[k].as_f64() {
                    p[k] = json!(v / divisor)
                }
            }
            props.insert(bound.into(), p);
        }
    } else if ["number", "integer"].contains(&kind) {
        let mut p =
            json!({"type":if kind=="integer"&&divisor==1.0{"integer"}else{"number"},"title":title});
        for k in ["minimum", "maximum"] {
            if let Some(v) = field[k].as_f64() {
                p[k] = json!(v / divisor)
            }
        }
        props.insert(fid.into(), p);
        if required || custom {
            mandatory.push(fid.into())
        }
    } else {
        props.insert(fid.into(),json!({"type":"string","title":title,"minLength":if required{1}else{0},"maxLength":500}));
        if required {
            mandatory.push(fid.into())
        }
    }
    json!({"mode":"form","message":format!("{title}{}{}",field["hint"].as_str().map(|h|format!(". {h}")).unwrap_or_default(),if !required&&field["options"].is_null(){". Leave blank for no preference."}else{""}),"requestedSchema":{"type":"object","properties":props,"required":mandatory}})
}
pub fn native_answer(field: &Value, content: &Value, custom: bool) -> Result<Value> {
    let divisor = field["display_divisor"].as_f64().unwrap_or(1.0);
    let kind = s(&field["type"]);
    if kind == "range" {
        let mut out = Map::new();
        for key in ["min", "max"] {
            if let Some(x) = content[key].as_f64() {
                out.insert(key.into(), json!(x * divisor));
            }
        }
        return Ok(if out.is_empty() {
            Value::Null
        } else {
            Value::Object(out)
        });
    }
    let value = &content[s(&field["id"])];
    if value.is_null() || s(value) == "__no_preference__" || value.as_str() == Some("") {
        return Ok(Value::Null);
    }
    if !custom && (!field["options"].is_null() || kind == "boolean") && kind != "multiple_choice" {
        return contracts::parse(
            "answerSchema",
            &serde_json::from_str::<Value>(
                value
                    .as_str()
                    .ok_or_else(|| Error::validation("The question returned an invalid choice"))?,
            )?,
        );
    }
    if ["integer", "number"].contains(&kind)
        && let Some(x) = value.as_f64()
    {
        return Ok(json!(if kind == "integer" && divisor == 100.0 {
            (x * divisor).round()
        } else {
            x * divisor
        }));
    }
    contracts::parse("answerSchema", value)
}

pub fn attribute(row: &Value, name: &str) -> Value {
    if name == "chip_generation" {
        let re = regex::Regex::new(r"(?i)^M([1-9]\d*)(?: (?:Pro|Max|Ultra))?$").unwrap();
        return re
            .captures(s(&row["chip"]))
            .and_then(|c| c[1].parse::<u64>().ok())
            .map(Value::from)
            .unwrap_or(Value::Null);
    }
    row["attributes"].get(name).unwrap_or(&row[name]).clone()
}
pub fn has_evidence(row: &Value, name: &str) -> bool {
    !s(&row["evidence"][if name == "chip_generation" {
        "chip"
    } else {
        name
    }])
    .trim()
    .is_empty()
}
pub fn criterion_matches(actual: &Value, expected: &Value, operator: &str) -> bool {
    match operator {
        "eq" => {
            if let (Some(x), Some(y)) = (actual.as_str(), expected.as_str()) {
                x.trim().to_lowercase() == y.trim().to_lowercase()
            } else {
                equal(actual, expected)
            }
        }
        "gte" => matches!((actual.as_f64(),expected.as_f64()),(Some(x),Some(y)) if x>=y),
        "lte" => matches!((actual.as_f64(),expected.as_f64()),(Some(x),Some(y)) if x<=y),
        "in" => {
            expected.is_array()
                && a(expected)
                    .iter()
                    .any(|e| criterion_matches(actual, e, "eq"))
        }
        "contains_any" => {
            actual.is_array()
                && expected.is_array()
                && a(actual)
                    .iter()
                    .any(|v| a(expected).iter().any(|e| criterion_matches(v, e, "eq")))
        }
        "range" => actual.as_f64().is_some_and(|v| {
            expected.is_object()
                && v >= expected["min"].as_f64().unwrap_or(f64::NEG_INFINITY)
                && v <= expected["max"].as_f64().unwrap_or(f64::INFINITY)
        }),
        _ => false,
    }
}
fn seller_count_matches(row: &Value, expected: &Value, operator: &str, now: i64) -> Option<bool> {
    let count = row["seller_listing_count"].as_f64()?;
    if count < 0.0
        || count.fract() != 0.0
        || count > 9_007_199_254_740_991.0
        || s(&row["seller_profile_url"]).is_empty()
        || !has_evidence(row, "seller_listing_count")
        || time(s(&row["seller_listings_checked_at"]))
            .ok()
            .is_none_or(|t| t > now || now - t > 30 * 86_400_000)
    {
        return None;
    }
    if row["seller_listing_count_precision"] == "exact" {
        return Some(criterion_matches(&json!(count), expected, operator));
    }
    if row["seller_listing_count_precision"] != "lower_bound" {
        return None;
    }
    match operator {
        "gte" if expected.as_f64().is_some_and(|v| count >= v) => Some(true),
        "lte" | "eq" if expected.as_f64().is_some_and(|v| count > v) => Some(false),
        "in" if expected.is_array()
            && a(expected)
                .iter()
                .all(|v| v.as_f64().is_some_and(|v| count > v)) =>
        {
            Some(false)
        }
        "range" if expected["max"].as_f64().is_some_and(|v| count > v) => Some(false),
        "range"
            if expected.get("max").is_none()
                && count >= expected["min"].as_f64().unwrap_or(0.0) =>
        {
            Some(true)
        }
        _ => None,
    }
}
fn setup_cost(row: &Value) -> (Option<f64>, &'static str) {
    let base = row["total_cash_cost_minor"]
        .as_f64()
        .or_else(|| row["price_minor"].as_f64());
    let costs = a(&row["setup_costs"]);
    if base.is_none()
        || (!costs.is_empty()
            && row
                .get("costs_complete")
                .is_some_and(|v| v.is_null() || v == false))
        || costs.iter().any(|v| {
            v["price_minor"].is_null()
                || s(&v["currency"]) != row["currency"].as_str().unwrap_or("GBP")
        })
    {
        return (None, "unknown");
    }
    (
        Some(
            base.unwrap()
                + costs
                    .iter()
                    .filter_map(|v| v["price_minor"].as_f64())
                    .sum::<f64>(),
        ),
        if costs.iter().any(|v| v["basis"] == "estimate") {
            "estimate"
        } else {
            "observed"
        },
    )
}
pub fn criteria(
    row: &Value,
    search: &Value,
    budget: bool,
    now: i64,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut rejected = Vec::new();
    let mut uncertain = Vec::new();
    let mut preferences = Vec::new();
    for field in a(&search["definition"]["fields"]) {
        let rule = &field["match"];
        let expected = &search["values"][s(&field["id"])];
        if rule.is_null()
            || expected.is_null()
            || !is_visible(field, &search["values"], &search["definition"])
        {
            continue;
        }
        let name = s(&rule["attribute"]);
        let op = s(&rule["operator"]);
        if !search["discovery"]["reference_model"].is_null()
            && name == s(&search["discovery"]["model_attribute"])
        {
            continue;
        }
        if !budget && (name == "seller_listing_count" || (name == "price_minor" && op == "lte")) {
            continue;
        }
        let costs = setup_cost(row);
        let actual = if name == "price_minor" && !a(&row["setup_costs"]).is_empty() {
            costs.0.map(Value::from).unwrap_or(Value::Null)
        } else {
            attribute(row, name)
        };
        let verified = ["price_minor", "drive_minutes"].contains(&name) || has_evidence(row, name);
        let approximate = name == "drive_minutes"
            && row["journey_estimate"]["precision"] == "town"
            && op == "lte"
            && matches!((actual.as_f64(),expected.as_f64()),(Some(x),Some(y)) if (x-y).abs()<=10.0);
        let matches = if approximate {
            None
        } else if name == "seller_listing_count" {
            seller_count_matches(row, expected, op, now)
        } else if name == "price_minor"
            && !a(&row["setup_costs"]).is_empty()
            && costs.1 != "observed"
        {
            let base = row["total_cash_cost_minor"]
                .as_f64()
                .or_else(|| row["price_minor"].as_f64());
            if op == "lte"
                && !row["price_minor"].is_null()
                && !criterion_matches(
                    &base.map(Value::from).unwrap_or(Value::Null),
                    expected,
                    "lte",
                )
            {
                Some(false)
            } else {
                None
            }
        } else if !actual.is_null() && verified {
            Some(criterion_matches(&actual, expected, op))
        } else {
            None
        };
        let required = rule["importance"].as_str().unwrap_or("required") == "required";
        let label = s(&field["label"]);
        if matches.is_none() {
            if required {
                &mut uncertain
            } else {
                &mut preferences
            }
            .push(format!("{label} needs verification"))
        } else if matches == Some(false) {
            if required {
                &mut rejected
            } else {
                &mut preferences
            }
            .push(format!(
                "{label} does not meet your {}",
                if required {
                    "requirement"
                } else {
                    "preference"
                }
            ))
        }
    }
    (rejected, uncertain, preferences)
}
pub fn normalize_name(value: &str) -> String {
    regex::Regex::new(r"[_\s-]+")
        .unwrap()
        .replace_all(&value.trim().to_lowercase(), " ")
        .into_owned()
}
pub fn canonical_model(value: &Value, search: &Value) -> Value {
    let Some(original) = value.as_str() else {
        return value.clone();
    };
    let found = a(&search["discovery"]["model_aliases"]).iter().find(|e| {
        std::iter::once(&e["canonical"])
            .chain(a(&e["aliases"]))
            .any(|v| normalize_name(s(v)) == normalize_name(original))
    });
    json!(normalize_name(
        found.map(|e| s(&e["canonical"])).unwrap_or(original)
    ))
}
pub fn search_cohort(row: &Value, search: &Value) -> Option<String> {
    let mut dimensions = strings(&search["definition"]["comparison_attributes"]);
    let model = search["discovery"]["model_attribute"]
        .as_str()
        .unwrap_or("model");
    if (!search["discovery"]["reference_model"].is_null()
        || !a(&search["discovery"]["research"]["candidates"]).is_empty())
        && !dimensions.iter().any(|s| s == model)
    {
        dimensions.push(model.into())
    }
    let mut values = Vec::new();
    for name in dimensions {
        let mut value = attribute(row, &name);
        if value.is_null() || value.as_str() == Some("") {
            return None;
        }
        if name == model {
            value = canonical_model(&value, search)
        } else if let Some(t) = value.as_str() {
            value = json!(normalize_name(t))
        } else if value.is_array() {
            let mut names: Vec<_> = a(&value).iter().map(|v| normalize_name(s(v))).collect();
            names.sort();
            value = json!(names)
        }
        values.push(value)
    }
    Some(canonical(&json!([
        row["product"],
        search["definition"]["price"],
        values
    ])))
}
pub fn applies_to_search(event: &Value, search: &Value) -> bool {
    !b(&event["undone"])
        && (event["scope"] == "global"
            || (event["scope"] == "category" && event["category"] == search["product"])
            || event["search_id"] == search["id"])
}
pub fn learned_criteria(
    row: &Value,
    search: &Value,
    config: &Value,
    budget: bool,
) -> (Vec<String>, Vec<String>, f64) {
    let mut rejected = Vec::new();
    let mut uncertain = Vec::new();
    let mut score = 0.0;
    let markets = search
        .get("marketplaces")
        .cloned()
        .unwrap_or(json!(["facebook_marketplace"]));
    if !a(&markets).contains(&row["source"]) {
        rejected.push("Marketplace is outside this search".into())
    }
    if config["platforms"][s(&row["source"])]["enabled"] == false {
        rejected.push("Marketplace is disabled".into())
    }
    let d = &search["discovery"];
    let model = d["model_attribute"].as_str().unwrap_or("model");
    if d["scope"] == "exact" {
        let actual = attribute(row, model);
        if actual.is_null() || !has_evidence(row, model) {
            uncertain.push("Exact model needs verification".into())
        } else if !criterion_matches(
            &canonical_model(&actual, search),
            &canonical_model(&d["reference_model"], search),
            "eq",
        ) {
            rejected.push("Different model from your exact requirement".into())
        }
    }
    if !budget {
        return (rejected, uncertain, score);
    }
    let feedback = a(&config["feedback"]);
    if let Some(latest) = feedback
        .iter()
        .rev()
        .find(|e| applies_to_search(e, search) && e["listing_key"] == row["key"])
    {
        if latest["action"] == "dismiss" {
            rejected.push("Dismissed for this search".into())
        }
        if latest["action"] == "shortlist" {
            score += 100.0
        }
    }
    let mut rules = BTreeMap::new();
    for e in feedback {
        if applies_to_search(e, search) && !e["rule"].is_null() {
            let r = &e["rule"];
            rules.insert(
                format!(
                    "{}:{}{}",
                    s(&r["attribute"]),
                    s(&r["operator"]),
                    if r["operator"] == "neq" {
                        format!(":{}", r["value"])
                    } else {
                        String::new()
                    }
                ),
                r,
            );
        }
    }
    for rule in rules.values() {
        let name = s(&rule["attribute"]);
        let actual = attribute(row, name);
        if actual.is_null()
            || (!["price_minor", "drive_minutes"].contains(&name) && !has_evidence(row, name))
        {
            if rule["importance"] == "required" {
                uncertain.push(format!("{} needs verification", s(&rule["label"])))
            }
            continue;
        }
        let av = if name == model {
            canonical_model(&actual, search)
        } else {
            actual
        };
        let ev = if name == model && rule["value"].is_string() {
            canonical_model(&rule["value"], search)
        } else {
            rule["value"].clone()
        };
        let matches = if rule["operator"] == "neq" {
            !criterion_matches(&av, &ev, "eq")
        } else {
            criterion_matches(&av, &ev, s(&rule["operator"]))
        };
        if matches {
            if rule["importance"] == "preferred" {
                score += 1.0
            }
        } else if rule["importance"] == "required" {
            rejected.push(s(&rule["label"]).into())
        }
    }
    if !d["reference_model"].is_null()
        && d["scope"] != "exact"
        && has_evidence(row, model)
        && criterion_matches(
            &canonical_model(&attribute(row, model), search),
            &canonical_model(&d["reference_model"], search),
            "eq",
        )
    {
        score += 1.0
    }
    for f in a(&search["definition"]["fields"]) {
        let expected = &search["values"][s(&f["id"])];
        let name = s(&f["match"]["attribute"]);
        if f["match"]["importance"] == "preferred"
            && !expected.is_null()
            && has_evidence(row, name)
            && criterion_matches(&attribute(row, name), expected, s(&f["match"]["operator"]))
        {
            score += 1.0
        }
    }
    (rejected, uncertain, score)
}
pub fn query_plan(search: &Value, feedback: &[Value]) -> Vec<Value> {
    let model = search["discovery"]["model_attribute"]
        .as_str()
        .unwrap_or("model");
    let excluded: HashSet<String> = feedback
        .iter()
        .filter(|e| {
            applies_to_search(e, search)
                && e["rule"]["attribute"] == model
                && e["rule"]["operator"] == "neq"
                && e["rule"]["importance"] == "required"
                && e["rule"]["value"].is_string()
        })
        .map(|e| canonical(&canonical_model(&e["rule"]["value"], search)))
        .collect();
    let d = &search["discovery"];
    let mut definitions = Vec::new();
    if let Some(reference) = d["reference_model"].as_str() {
        definitions.push(json!({"text":reference,"purpose":"exact"}))
    }
    let category = if d["category_terms"].is_array() {
        strings(&d["category_terms"])
    } else if ["espresso_machine", "coffee_machine"].contains(&s(&search["product"])) {
        vec!["coffee machine".into(), "espresso machine".into()]
    } else {
        vec![s(&search["product"]).replace('_', " ")]
    };
    definitions.extend(
        category
            .iter()
            .map(|t| json!({"text":t,"purpose":"category"})),
    );
    for e in a(&d["model_aliases"]) {
        definitions.extend(
            a(&e["aliases"])
                .iter()
                .map(|v| json!({"text":v,"purpose":"alias"})),
        )
    }
    definitions.extend(a(&d["query_plan"]).iter().cloned());
    definitions.extend(
        a(&d["research"]["queries"])
            .iter()
            .map(|v| json!({"text":v,"purpose":"feature"})),
    );
    definitions.extend(
        a(&d["research"]["candidates"])
            .iter()
            .map(|v| json!({"text":v["model"],"purpose":"alternative"})),
    );
    let markets = search
        .get("marketplaces")
        .cloned()
        .unwrap_or(json!(["facebook_marketplace"]));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for market in a(&markets) {
        let mut count = 0;
        for (i, d) in definitions.iter().enumerate() {
            if d["purpose"] != "category"
                && excluded.contains(&canonical(&canonical_model(&d["text"], search)))
            {
                continue;
            }
            let normalized = s(&d["text"])
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if !seen.insert(format!("{}:{normalized}", s(market))) {
                continue;
            }
            out.push(json!({"text":s(&d["text"]).trim(),"purpose":d["purpose"],"id":format!("{}-{i}",s(market)),"marketplace":market,"status":"planned","result_count":null,"unique_relevant_count":null,"reason":null}));
            count += 1;
            if count == 20 || out.len() == 120 {
                break;
            }
        }
        if out.len() == 120 {
            break;
        }
    }
    out
}

const RUN_SELECT: &str = "SELECT search_runs.document_json, search_run_workers.document_json FROM search_runs LEFT JOIN search_run_workers ON search_run_workers.run_id=search_runs.id";
fn decode_run(data: String, worker: Option<String>) -> Result<Value> {
    let mut run: Value = serde_json::from_str(&data)?;
    run["worker"] = worker
        .map(|v| serde_json::from_str(&v))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(run)
}
pub fn find_run(ws: &Workspace, run_id: &str) -> Result<Option<Value>> {
    let raw: Option<(String, Option<String>)> = ws
        .db
        .query_row(
            &format!("{RUN_SELECT} WHERE search_runs.id=?"),
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    raw.map(|(d, w)| decode_run(d, w)).transpose()
}
fn raw_runs(ws: &Workspace, search_id: Option<&str>, limit: bool) -> Result<Vec<Value>> {
    let sql = format!(
        "{RUN_SELECT}{} ORDER BY search_runs.updated_at DESC, search_runs.rowid DESC{}",
        if search_id.is_some() {
            " WHERE search_runs.search_id=?"
        } else {
            ""
        },
        if limit { " LIMIT 50" } else { "" }
    );
    let mut stmt = ws.db.prepare(&sql)?;
    let ids: Vec<&str> = search_id.into_iter().collect();
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    rows.map(|r| {
        let (d, w) = r?;
        decode_run(d, w)
    })
    .collect()
}
pub fn expired_run(run: &Value, now: i64) -> Value {
    let expires = time(s(&run["worker"]["lease_expires_at"]))
        .ok()
        .or_else(|| {
            time(s(&run["updated_at"]))
                .ok()
                .map(|t| t + SEARCH_LEASE_MS)
        })
        .unwrap_or(i64::MAX);
    if !active(run) || expires > now {
        return run.clone();
    }
    let mut out = run.clone();
    out["phase"] = json!(if a(&run["listing_keys"]).is_empty() {
        "blocked"
    } else {
        "partial"
    });
    bump(&mut out, now);
    out["interruption"] = json!(if run["worker"].is_null() {
        "The search did not start or stopped reporting progress. Saved results are preserved."
    } else {
        "The background agent stopped reporting progress. Saved results are preserved."
    });
    out["next_step"] = json!("Resume this search with a new background agent.");
    out
}
pub fn runs(ws: &Workspace, search_id: Option<&str>) -> Result<Vec<Value>> {
    Ok(raw_runs(ws, search_id, true)?
        .iter()
        .map(|v| expired_run(v, ws.now))
        .collect())
}
fn reconcile(ws: &mut Workspace) -> Result<()> {
    for run in raw_runs(ws, None, false)? {
        let projected = expired_run(&run, ws.now);
        if projected != run {
            let mut document = projected.clone();
            document.as_object_mut().unwrap().remove("worker");
            ws.db.execute("UPDATE search_runs SET document_json=?,updated_at=? WHERE id=? AND json_extract(document_json,'$.version')=?",params![document.to_string(),s(&projected["updated_at"]),s(&projected["id"]),n(&run["version"])])?;
        }
    }
    Ok(())
}
fn save_run(ws: &Workspace, run: &Value) -> Result<()> {
    let mut document = run.clone();
    document.as_object_mut().unwrap().remove("worker");
    ws.db.execute("INSERT INTO search_runs(id,search_id,document_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json,updated_at=excluded.updated_at",params![s(&run["id"]),s(&run["search_id"]),document.to_string(),s(&run["updated_at"])])?;
    if run["worker"].is_null() {
        ws.db.execute(
            "DELETE FROM search_run_workers WHERE run_id=?",
            [s(&run["id"])],
        )?;
    } else {
        ws.db.execute("INSERT INTO search_run_workers(run_id,document_json) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET document_json=excluded.document_json",params![s(&run["id"]),run["worker"].to_string()])?;
    }
    Ok(())
}
fn latest_scheduled(ws: &Workspace, search_id: &str) -> Result<Option<Value>> {
    let sql = format!(
        "{RUN_SELECT} WHERE search_id=? AND json_extract(search_runs.document_json,'$.scheduled_at') IS NOT NULL ORDER BY json_extract(search_runs.document_json,'$.scheduled_at') DESC, search_runs.rowid DESC LIMIT 1"
    );
    let raw: Option<(String, Option<String>)> = ws
        .db
        .query_row(&sql, [search_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    raw.map(|(d, w)| decode_run(d, w).map(|r| expired_run(&r, ws.now)))
        .transpose()
}
pub fn fulfilled_searches(ws: &Workspace) -> Result<HashSet<String>> {
    let mut stmt = ws
        .db
        .prepare("SELECT document_json FROM seller_conversations")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut result = HashSet::new();
    for row in rows {
        let v: Value = serde_json::from_str(&row?)?;
        if v["outcome"] == "bought" {
            result.extend(strings(&v["search_ids"]));
        }
    }
    Ok(result)
}
pub fn fulfil_goals(ws: &mut Workspace, ids: &[String]) -> Result<()> {
    for mut run in raw_runs(ws, None, false)? {
        if ids.iter().any(|v| v == s(&run["search_id"])) && resumable(&run) {
            stop_run(
                &mut run,
                ws.now,
                "Buying goal fulfilled. Saved listings and conversations are preserved.",
                false,
            );
            save_run(ws, &run)?
        }
    }
    Ok(())
}
fn touch_worker(run: &mut Value, now: i64) {
    if !run["worker"].is_null() {
        run["worker"]["last_heartbeat_at"] = json!(iso(now));
        run["worker"]["lease_expires_at"] = json!(iso(now + SEARCH_LEASE_MS));
    }
}
fn stop_run(run: &mut Value, now: i64, reason: &str, defer: bool) {
    if !resumable(run) {
        return;
    }
    run["phase"] = json!(if defer { "deferred" } else { "cancelled" });
    bump(run, now);
    run["next_step"] = json!(reason);
    if defer {
        run["interruption"] = Value::Null;
    }
}
fn update_event(phase: &str) -> &'static str {
    match phase {
        "cancelled" => "cancel",
        "completed" => "complete",
        "verifying" => "verify",
        "partial" | "blocked" | "deferred" => "interrupt",
        _ => "progress",
    }
}
fn blocker(code: &str, kind: &str) -> Value {
    let guards = contracts::data("searchGuards");
    json!({"code":code,"kind":kind,"message":guards[code]["message"],"recovery":guards[code]["recovery"]})
}
/// The same guard evaluator drives command enforcement and UI action descriptors.
fn blockers(run: Option<&Value>, event: &str, context: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if event == "inspect" {
        return out;
    }
    let mut add = |code: &str, kind: &str| out.push(blocker(code, kind));
    if ["request", "resume"].contains(&event) {
        if !b(&context["request_supplied"]) {
            add("request_input", "input")
        }
        if context["search_exists"] == false {
            add("search_missing", "blocked")
        } else if context["search_exists"].is_null() {
            add("search_missing", "input")
        }
        if context["fulfilled"] == true {
            add("goal_fulfilled", "blocked")
        } else if context["fulfilled"].is_null() {
            add("goal_fulfilled", "input")
        }
        if context["scheduled_allowed"] == false {
            add("scheduled_ineligible", "blocked")
        }
        if event == "resume" && context["search_current"] == false {
            add("search_changed", "blocked")
        }
        return out;
    }
    let Some(run) = run else {
        add("run_finished", "blocked");
        return out;
    };
    let definition = &contracts::data("searchEvents")[event];
    if !a(&definition["from"]).contains(&run["phase"]) {
        add(
            if active(run) {
                "transition_invalid"
            } else if ["completed", "cancelled"].contains(&s(&run["phase"])) {
                "run_finished"
            } else {
                "run_stopped"
            },
            "blocked",
        )
    }
    if event == "cancel" {
        if !context["candidate"].is_null() {
            if context["expected_version"] != run["version"] {
                add("revision_conflict", "blocked")
            }
            if context["search_current"] == false {
                add("search_changed", "blocked")
            }
        }
        return out;
    }
    if ["fulfil", "defer", "expire"].contains(&event) {
        return out;
    }
    if run["trigger"] == "scheduled" && context["scheduled_allowed"] == false {
        add("scheduled_ineligible", "blocked")
    }
    if event != "import" {
        if context["search_current"] == false {
            add("search_changed", "blocked")
        } else if context["search_current"].is_null() {
            add("search_changed", "input")
        }
    }
    if !["renew", "import"].contains(&event) && (event != "claim" || run["worker"].is_null()) {
        if context["expected_version"].is_null() {
            add("revision_conflict", "input")
        } else if context["expected_version"] != run["version"] {
            add("revision_conflict", "blocked")
        }
    }
    if event == "claim" && (s(&context["agent_id"]).is_empty() || context["worker_id"].is_null()) {
        add("claim_input", "input")
    }
    if context["candidate"]["phase"] != "cancelled" {
        if event != "claim" || !run["worker"].is_null() {
            if run["worker"].is_null() {
                if event == "renew" || !context["worker_id"].is_null() {
                    add("worker_required", "blocked")
                }
            } else if time(s(&run["worker"]["lease_expires_at"]))
                .ok()
                .is_some_and(|t| t <= n(&context["now"]))
            {
                add("lease_expired", "blocked")
            } else if context["worker_id"].is_null() {
                add("worker_mismatch", "input")
            } else if context["worker_id"] != run["worker"]["id"] {
                add("worker_mismatch", "blocked")
            }
        }
        if !run["worker"].is_null() && !active(run) {
            add("run_stopped", "blocked")
        }
    }
    if ["progress", "verify", "complete", "interrupt"].contains(&event) {
        let candidate = &context["candidate"];
        if candidate.is_null() {
            add("execution_input", "input")
        } else {
            if !a(&definition["to"]).contains(&candidate["phase"]) {
                add("transition_invalid", "blocked")
            }
            let category = a(&candidate["queries"])
                .iter()
                .any(|q| q["purpose"] == "category" && q["status"] == "completed");
            if ["verifying", "completed"].contains(&s(&candidate["phase"])) && !category {
                add("category_query_unchecked", "blocked")
            }
            if candidate["phase"] == "completed"
                && a(&candidate["queries"])
                    .iter()
                    .any(|q| ["planned", "running", "failed"].contains(&s(&q["status"])))
            {
                add("query_coverage_incomplete", "blocked")
            }
            if candidate["phase"] == "blocked" && s(&candidate["interruption"]).is_empty() {
                add("interruption_required", "blocked")
            }
        }
    }
    if event == "import" && context["candidate"].is_null() {
        add("execution_input", "input")
    }
    out
}
fn assert_guards(run: Option<&Value>, event: &str, context: &Value) -> Result<()> {
    let reasons = blockers(run, event, context);
    if let Some(first) = reasons.first() {
        let mut error = Error::validation(s(&first["message"]));
        error.blockers = Some(Box::new(json!(reasons)));
        return Err(error);
    }
    Ok(())
}
fn search_context(ws: &Workspace, run: &Value, args: &Value) -> Value {
    let current = search(&ws.config, s(&run["search_id"]))
        .is_some_and(|v| hash(v) == s(&run["search_revision"]));
    json!({"now":ws.now,"worker_id":args["worker_id"],"agent_id":args["agent_id"],"expected_version":args["expected_version"],"search_current":current})
}
pub fn run_action(ws: &mut Workspace, action: &str, input: &Value) -> Result<Value> {
    reconcile(ws)?;
    let schema = match action {
        "start" => "searchCommands.start",
        "claim" => "searchCommands.claim",
        "heartbeat" => "searchCommands.heartbeat",
        "cancel" => "searchCommands.cancel",
        _ => "searchCommands.update",
    };
    let args = contracts::parse(schema, input)?;
    if action == "start" {
        let saved = search(&ws.config, s(&args["search_id"]))
            .ok_or_else(|| Error::validation("Choose a saved search"))?
            .clone();
        assert_guards(
            None,
            "request",
            &json!({"now":ws.now,"search_exists":true,"fulfilled":fulfilled_searches(ws)?.contains(s(&saved["id"])),"request_supplied":true}),
        )?;
        if let Some(existing) = find_run(ws, s(&args["request_id"]))? {
            if existing["search_id"] != saved["id"] {
                return invalid("This request ID belongs to another search");
            }
            return Ok(existing);
        }
        if let Some(mut run) = runs(ws, Some(s(&saved["id"])))?
            .into_iter()
            .find(|r| resumable(r) && s(&r["search_revision"]) == hash(&saved))
            && (b(&args["resume"]) || active(&run))
        {
            if active(&run) {
                return Ok(run);
            }
            run["phase"] = json!("requested");
            bump(&mut run, ws.now);
            run["interruption"] = Value::Null;
            run["worker"] = Value::Null;
            run["trigger"] = args["trigger"].clone();
            if args["trigger"] == "scheduled" {
                run["scheduled_at"] = json!(iso(ws.now))
            }
            save_run(ws, &run)?;
            return Ok(run);
        }
        let run = json!({"id":args["request_id"],"search_id":saved["id"],"search_revision":hash(&saved),"trigger":args["trigger"],"scheduled_at":if args["trigger"]=="scheduled"{json!(iso(ws.now))}else{Value::Null},"version":0,"phase":"requested","queries":query_plan(&saved,a(&ws.config["feedback"])),"listing_keys":[],"verified_keys":[],"created_at":iso(ws.now),"updated_at":iso(ws.now),"first_result_at":null,"next_step":"Search the exact model and broad category queries before detailed verification.","interruption":null,"worker":null});
        let run = contracts::parse("searchRunSchema", &run)?;
        save_run(ws, &run)?;
        return Ok(run);
    }
    let mut run = find_run(ws, s(&args["run_id"]))?
        .ok_or_else(|| Error::validation("Choose an existing search run"))?;
    if action == "cancel" {
        if !["cancelled", "completed"].contains(&s(&run["phase"])) {
            stop_run(
                &mut run,
                ws.now,
                "Search stopped. Saved results are preserved.",
                false,
            );
            save_run(ws, &run)?
        }
        return Ok(run);
    }
    if ["claim", "heartbeat"].contains(&action) {
        assert_guards(
            Some(&run),
            if action == "claim" { "claim" } else { "renew" },
            &search_context(ws, &run, &args),
        )?;
        if action == "claim" && run["worker"].is_null() {
            run["worker"] = json!({"id":args["worker_id"],"agent_id":args["agent_id"],"parent_thread_id":args["parent_thread_id"],"claimed_at":iso(ws.now),"last_heartbeat_at":iso(ws.now),"lease_expires_at":iso(ws.now+SEARCH_LEASE_MS)});
            if let Some(execution) = args.get("execution") {
                run["worker"]["execution"] = execution.clone();
            }
        }
        if run["started_at"].is_null() {
            run["started_at"] = json!(iso(ws.now))
        }
        touch_worker(&mut run, ws.now);
        if run["phase"] == "requested" {
            run["phase"] = json!("discovering")
        }
        bump(&mut run, ws.now);
        save_run(ws, &run)?;
        return Ok(run);
    }
    let mut updated = run.clone();
    bump(&mut updated, ws.now);
    for key in ["phase", "next_step", "interruption"] {
        if let Some(v) = args.get(key) {
            updated[key] = v.clone()
        }
    }
    if let Some(query) = args.get("query") {
        validate_query(query)?;
        let index = a(&run["queries"])
            .iter()
            .position(|q| q["id"] == query["id"])
            .ok_or_else(|| {
                Error::validation("Update an existing planned query with its original identity")
            })?;
        if ["text", "marketplace", "purpose"]
            .iter()
            .any(|k| run["queries"][index][*k] != query[*k])
        {
            return invalid("Update an existing planned query with its original identity");
        }
        updated["queries"][index] = query.clone();
    }
    if !a(&args["add_queries"]).is_empty() {
        let mut ids: HashSet<String> = a(&updated["queries"])
            .iter()
            .map(|q| s(&q["id"]).into())
            .collect();
        let mut terms: HashSet<String> = a(&updated["queries"])
            .iter()
            .map(|q| {
                format!(
                    "{}:{}",
                    s(&q["marketplace"]),
                    s(&q["text"]).trim().to_lowercase()
                )
            })
            .collect();
        let markets = search(&ws.config, s(&run["search_id"]))
            .and_then(|v| v.get("marketplaces"))
            .cloned()
            .unwrap_or(json!(["facebook_marketplace"]));
        for q in a(&args["add_queries"]) {
            validate_query(q)?;
            if !ids.insert(s(&q["id"]).into())
                || !terms.insert(format!(
                    "{}:{}",
                    s(&q["marketplace"]),
                    s(&q["text"]).trim().to_lowercase()
                ))
                || q["status"] != "planned"
                || !a(&markets).contains(&q["marketplace"])
            {
                return invalid("Add unique planned queries on the selected marketplaces");
            }
        }
        if a(&updated["queries"]).len() + a(&args["add_queries"]).len() > 120 {
            return invalid("This query plan is full");
        }
        updated["queries"]
            .as_array_mut()
            .unwrap()
            .extend(a(&args["add_queries"]).iter().cloned());
    }
    let mut context = search_context(ws, &run, &args);
    context["candidate"] = updated.clone();
    assert_guards(Some(&run), update_event(s(&args["phase"])), &context)?;
    touch_worker(&mut updated, ws.now);
    save_run(ws, &updated)?;
    Ok(updated)
}
fn validate_query(query: &Value) -> Result<()> {
    if ["skipped", "failed"].contains(&s(&query["status"])) && s(&query["reason"]).trim().is_empty()
    {
        return invalid("Skipped and failed queries need a reason");
    }
    Ok(())
}
/// Checks eligibility before decoding an import batch, retaining the stop in the transaction.
pub fn scheduled_import_check(ws: &mut Workspace, run_id: &str) -> Result<Option<Value>> {
    reconcile(ws)?;
    let Some(mut run) = find_run(ws, run_id)? else {
        return Ok(None);
    };
    if run["trigger"] != "scheduled" {
        return Ok(None);
    }
    let hosts = host_observations(ws)?;
    let check = scheduled_check(
        &ws.config,
        s(&run["search_id"]),
        ws.now,
        &fulfilled_searches(ws)?,
        &[],
        false,
        host_for_search(&ws.config, &hosts, s(&run["search_id"])),
    );
    if b(&check["allowed"]) {
        return Ok(None);
    }
    if active(&run) {
        stop_run(
            &mut run,
            ws.now,
            s(&check["explanation"]),
            check["reason"] == "quiet_hours",
        );
        run["interruption"] = Value::Null;
        save_run(ws, &run)?;
    }
    Ok(Some(check))
}
pub fn record_import(
    ws: &mut Workspace,
    run_id: &str,
    rows: &[Value],
    worker_id: Option<&str>,
) -> Result<()> {
    reconcile(ws)?;
    let mut run =
        find_run(ws, run_id)?.ok_or_else(|| Error::validation("Choose an existing search run"))?;
    let saved = search(&ws.config, s(&run["search_id"])).ok_or_else(|| {
        Error::validation("Import observations for the current search run and buying brief")
    })?;
    if hash(saved) != s(&run["search_revision"])
        || rows.iter().any(|row| row["product"] != saved["product"])
    {
        return invalid("Import observations for the current search run and buying brief");
    }
    // Scheduled imports cannot bypass a changed monitoring choice or quiet-hour gate.
    if run["trigger"] == "scheduled" {
        let hosts = host_observations(ws)?;
        let check = scheduled_check(
            &ws.config,
            s(&run["search_id"]),
            ws.now,
            &fulfilled_searches(ws)?,
            &[],
            false,
            host_for_search(&ws.config, &hosts, s(&run["search_id"])),
        );
        if !b(&check["allowed"]) {
            return invalid(s(&check["explanation"]));
        }
    }
    assert_guards(
        Some(&run),
        "import",
        &json!({"now":ws.now,"worker_id":worker_id,"candidate":run}),
    )?;
    let mut keys = strings(&run["listing_keys"]);
    let mut verified = strings(&run["verified_keys"]);
    for row in rows {
        let key = s(&row["key"]).to_owned();
        if !keys.contains(&key) {
            keys.push(key.clone())
        }
        let videos = !a(&row["videos"]).is_empty()
            || n(&row["video_review"]["total_videos"]) > 0
            || n(&row["media_capture"]["expected_videos"]) > 0;
        if row["collection_stage"] == "verification"
            && b(&row["image_review"]["complete"])
            && (!videos || b(&row["video_review"]["complete"]))
            && !verified.contains(&key)
        {
            verified.push(key)
        }
    }
    run["listing_keys"] = json!(keys);
    run["verified_keys"] = json!(verified);
    if !rows.is_empty() {
        if run["started_at"].is_null() {
            run["started_at"] = json!(iso(ws.now))
        }
        if run["first_result_at"].is_null() {
            run["first_result_at"] = json!(iso(ws.now))
        }
    }
    bump(&mut run, ws.now);
    touch_worker(&mut run, ws.now);
    contracts::parse("searchRunSchema", &run)?;
    save_run(ws, &run)?;
    for key in rows.iter().map(|v| s(&v["key"])).collect::<HashSet<_>>() {
        ws.db.execute("INSERT INTO listing_search_discoveries(listing_key,search_id,run_id,run_started_at,recorded_at) VALUES (?,?,?,?,?) ON CONFLICT(listing_key,search_id) DO UPDATE SET run_id=excluded.run_id,run_started_at=excluded.run_started_at,recorded_at=excluded.recorded_at WHERE julianday(excluded.run_started_at)<julianday(listing_search_discoveries.run_started_at)",params![key,s(&run["search_id"]),run_id,s(&run["created_at"]),iso(ws.now)])?;
    }
    Ok(())
}
pub fn search_progress(run: &Value) -> Value {
    json!({"checked_queries":a(&run["queries"]).iter().filter(|q|q["status"]=="completed").count(),"total_queries":a(&run["queries"]).len(),"discovered":a(&run["listing_keys"]).len(),"verified":a(&run["verified_keys"]).len(),"category_checked":a(&run["queries"]).iter().any(|q|q["purpose"]=="category"&&q["status"]=="completed"),"first_result_seconds":match(time(s(&run["first_result_at"])),time(s(&run["created_at"]))){(Ok(x),Ok(y))=>json!((x-y) as f64/1000.0),_=>Value::Null}})
}
pub fn workflow_views(
    config: &Value,
    runs: &[Value],
    fulfilled: &HashSet<String>,
    now: i64,
) -> Value {
    let context = |sid: &str, run: Option<&Value>| json!({"now":now,"search_exists":search(config,sid).is_some(),"search_current":search(config,sid).is_some_and(|s|run.is_none_or(|r|hash(s)==r["search_revision"])) ,"fulfilled":fulfilled.contains(sid),"expected_version":run.map(|r|r["version"].clone()).unwrap_or(Value::Null),"scheduled_allowed":run.is_none_or(|r|r["trigger"]!="scheduled"||b(&scheduled_check(config,sid,now,fulfilled,&[],false,None)["allowed"]))});
    let by_run: Map<String, Value> = runs
        .iter()
        .map(|r| {
            (
                s(&r["id"]).into(),
                workflow(Some(r), &context(s(&r["search_id"]), Some(r))),
            )
        })
        .collect();
    let by_search: Map<String, Value> = a(&config["searches"])
        .iter()
        .map(|search| {
            let run = runs.iter().find(|r| {
                r["search_id"] == search["id"] && s(&r["search_revision"]) == hash(search)
            });
            let mut c = context(s(&search["id"]), run);
            c["scheduled_allowed"] = json!(true);
            (s(&search["id"]).into(), workflow(run, &c))
        })
        .collect();
    json!({"search_run_workflows":by_run,"search_workflows":by_search})
}
fn workflow(run: Option<&Value>, context: &Value) -> Value {
    let run = run.map(|r| expired_run(r, n(&context["now"])));
    let state = run.as_ref().map(|r| s(&r["phase"])).unwrap_or("absent");
    let mut actions = Vec::new();
    let mut allowed = Vec::new();
    let mut prerequisites = Vec::new();
    if let Some(events) = contracts::data("searchEvents").as_object() {
        for (event, definition) in events {
            if definition["operation"].is_null()
                || !a(&definition["from"]).iter().any(|v| s(v) == state)
            {
                continue;
            }
            let reasons = blockers(run.as_ref(), event, context);
            let availability = if reasons.iter().any(|v| v["kind"] == "blocked") {
                "blocked"
            } else if reasons.is_empty() {
                "available"
            } else {
                "requires_input"
            };
            let operation = s(&definition["operation"]);
            let tool = format!(
                "{}_goodfinds_{}",
                operation.split('_').next().unwrap_or(operation),
                operation.split_once('_').map(|(_, v)| v).unwrap_or("")
            );
            let conditions: Vec<Value> = a(&definition["guards"])
                .iter()
                .map(|v| contracts::data("searchGuards")[s(v)]["recovery"].clone())
                .collect();
            for p in conditions
                .iter()
                .chain(reasons.iter().map(|r| &r["recovery"]))
            {
                if !prerequisites.contains(p) {
                    prerequisites.push(p.clone())
                }
            }
            if availability != "blocked" && !allowed.contains(&tool) {
                allowed.push(tool.clone())
            }
            actions.push(json!({"event":event,"operation":operation,"tool":tool,"availability":availability,"required_inputs":definition["inputs"],"conditions":conditions,"blockers":reasons,"execution":contracts::data("executionPolicies")[definition["execution_profile"].as_str().unwrap_or("chat")]}));
        }
    }
    json!({"state":state,"actions":actions,"allowed_actions":allowed,"prerequisites":prerequisites})
}

fn minute_of_day(time: &str) -> i64 {
    time.split_once(':')
        .and_then(|(h, m)| Some(h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?))
        .unwrap_or(0)
}
fn clock_time(minute: i64) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}
fn quiet_minute(minute: i64, hours: &Value) -> bool {
    if !b(&hours["enabled"]) {
        return false;
    }
    let start = minute_of_day(s(&hours["start"]));
    let end = minute_of_day(s(&hours["end"]));
    if start < end {
        minute >= start && minute < end
    } else {
        minute >= start || minute < end
    }
}
fn local_parts(at: i64, zone: &str) -> (String, i64) {
    let zone: Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    let dt = DateTime::from_timestamp_millis(at)
        .unwrap_or_default()
        .with_timezone(&zone);
    (
        dt.format("%Y-%m-%d").to_string(),
        dt.hour() as i64 * 60 + dt.minute() as i64,
    )
}
pub fn in_quiet_hours(at: i64, hours: &Value) -> bool {
    quiet_minute(local_parts(at, s(&hours["timezone"])).1, hours)
}
pub fn next_local_time(times: &[String], zone: &str, now: i64) -> Option<String> {
    let zone: Tz = zone.parse().ok()?;
    let today = DateTime::from_timestamp_millis(now)?
        .with_timezone(&zone)
        .date_naive();
    for offset in 0..4 {
        let date = today.checked_add_signed(Duration::days(offset))?;
        let mut candidates = Vec::new();
        for value in times {
            let clock = NaiveTime::parse_from_str(value, "%H:%M").ok()?;
            match zone.from_local_datetime(&date.and_time(clock)) {
                LocalResult::Single(t) => candidates.push(t.timestamp_millis()),
                LocalResult::Ambiguous(a, b) => {
                    candidates.push(a.timestamp_millis());
                    candidates.push(b.timestamp_millis())
                }
                LocalResult::None => {}
            }
        }
        if let Some(next) = candidates.into_iter().filter(|t| *t > now).min() {
            return Some(iso(next));
        }
    }
    None
}
pub fn daily_rule(minutes: &[i64]) -> Option<String> {
    if minutes.is_empty() {
        return None;
    }
    let hours: Vec<i64> = minutes
        .iter()
        .map(|m| m / 60)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let offsets: Vec<i64> = minutes
        .iter()
        .map(|m| m % 60)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let count = (hours.len() * offsets.len()) as i64;
    let positions: Vec<i64> = minutes
        .iter()
        .map(|m| {
            (hours.iter().position(|h| *h == m / 60).unwrap() * offsets.len()
                + offsets.iter().position(|o| *o == m % 60).unwrap()
                + 1) as i64
        })
        .collect();
    let selected: Vec<i64> = positions
        .iter()
        .map(|p| if *p <= 366 { *p } else { p - count - 1 })
        .collect();
    if selected.iter().any(|p| p.abs() > 366) {
        return None;
    }
    let joined = |v: &[i64]| {
        v.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    };
    Some(format!(
        "FREQ=DAILY;BYHOUR={};BYMINUTE={};BYSECOND=0{}",
        joined(&hours),
        joined(&offsets),
        if positions.len() == count as usize {
            String::new()
        } else {
            format!(";BYSETPOS={}", joined(&selected))
        }
    ))
}
pub fn schedule_plan(timing: &Value, quiet: &Value, allow_quiet: bool) -> Value {
    let mut hours = quiet.clone();
    hours["enabled"] = json!(b(&quiet["enabled"]) && !allow_quiet);
    let mut times = Vec::new();
    let mut excluded = Vec::new();
    let interval = n(&timing["interval_minutes"]);
    if timing["mode"] == "daily" {
        for value in strings(&timing["times"]) {
            if quiet_minute(minute_of_day(&value), &hours) {
                excluded.push(value)
            } else {
                times.push(minute_of_day(&value))
            }
        }
        times.sort_unstable();
    } else if b(&hours["enabled"]) && interval > 0 {
        let start = minute_of_day(s(&hours["end"]));
        let duration = (minute_of_day(s(&hours["start"])) - start + 1440) % 1440;
        let mut elapsed = 0;
        while elapsed < duration {
            times.push((start + elapsed) % 1440);
            elapsed += interval
        }
        times.sort_unstable();
    }
    let mut guard = false;
    let mut rule = if timing["mode"] == "interval" && !b(&hours["enabled"]) {
        Some(if interval % 60 == 0 {
            format!("FREQ=HOURLY;INTERVAL={}", interval / 60)
        } else {
            format!("FREQ=MINUTELY;INTERVAL={interval}")
        })
    } else {
        daily_rule(&times)
    };
    if rule.is_none() && !times.is_empty() && timing["mode"] == "interval" {
        let allowed = (0..24)
            .filter(|h| (0..60).any(|m| !quiet_minute(h * 60 + m, &hours)))
            .map(|v| v.to_string())
            .collect::<Vec<_>>();
        rule = Some(format!(
            "FREQ=MINUTELY;INTERVAL={interval};BYHOUR={}",
            allowed.join(",")
        ));
        guard = true;
    }
    let clocks: Vec<String> = times.iter().map(|v| clock_time(*v)).collect();
    let cadence = if timing["mode"] == "daily" {
        format!(
            "Daily at {}",
            if clocks.is_empty() {
                "no permitted times".into()
            } else {
                clocks.join(", ")
            }
        )
    } else {
        format!(
            "Every {}",
            if interval == 60 {
                "hour".into()
            } else {
                format!("{interval} minutes")
            }
        )
    };
    json!({"timing":timing,"quiet_hours":hours,"timezone":hours["timezone"],"rrule":rule,"guard_required":guard,"description":format!("{cadence}{} ({})",if b(&hours["enabled"]){format!(" · quiet {}–{}",s(&hours["start"]),s(&hours["end"]))}else{" · any time".into()},s(&hours["timezone"])),"excluded_times":excluded,"times":clocks})
}
pub fn canonical_rule(rule: &str) -> String {
    let upper = rule.to_uppercase();
    let bare = upper.strip_prefix("RRULE:").unwrap_or(&upper);
    let re = regex::Regex::new(r"^[A-Z]+=[A-Z0-9,+-]+$").unwrap();
    let mut fields = BTreeMap::new();
    for token in bare.split(';') {
        if !re.is_match(token) {
            return format!("INVALID:{rule}");
        }
        let Some((key, value)) = token.split_once('=') else {
            return format!("INVALID:{rule}");
        };
        let mut values: Vec<_> = value.split(',').collect();
        values.sort_by(|x, y| match (x.parse::<f64>(), y.parse::<f64>()) {
            (Ok(a), Ok(b)) => a.total_cmp(&b),
            _ => std::cmp::Ordering::Equal,
        });
        if fields.insert(key.to_owned(), values.join(",")).is_some() {
            return format!("INVALID:{rule}");
        }
    }
    fields.entry("INTERVAL".into()).or_insert("1".into());
    fields.entry("BYSECOND".into()).or_insert("0".into());
    if fields.len() == 3
        && fields
            .get("FREQ")
            .is_some_and(|s| s == "HOURLY" || s == "MINUTELY")
    {
        let interval = fields["INTERVAL"].parse::<i64>().unwrap_or(0)
            * if fields["FREQ"] == "HOURLY" { 60 } else { 1 };
        fields.insert("INTERVAL".into(), interval.to_string());
        fields.insert("FREQ".into(), "MINUTELY".into());
    }
    fields
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(";")
}
fn local_slot(times: &[String], zone: &str, now: i64) -> Option<String> {
    let (date, minute) = local_parts(now, zone);
    times
        .iter()
        .filter(|v| minute_of_day(v) <= minute)
        .max()
        .map(|t| format!("{date}T{t}"))
}
fn timing_for(config: &Value, id: &str) -> Value {
    monitoring(config,id).filter(|m|!m["timing"].is_null()).map(|m|m["timing"].clone()).unwrap_or_else(||json!({"mode":"interval","interval_minutes":monitoring(config,id).map(|m|m["interval_minutes"].clone()).unwrap_or_else(||config["schedule"]["interval_minutes"].clone())}))
}
fn plan_for(config: &Value, id: &str) -> Value {
    schedule_plan(
        &timing_for(config, id),
        &config["schedule"]["quiet_hours"],
        monitoring(config, id).is_some_and(|m| b(&m["allow_quiet_hours"])),
    )
}
pub fn scheduled_check(
    config: &Value,
    search_id: &str,
    now: i64,
    fulfilled: &HashSet<String>,
    runs: &[Value],
    dispatch: bool,
    host: Option<&Value>,
) -> Value {
    let plan = plan_for(config, search_id);
    let result = |allowed: bool, reason: &str, explanation: String, next: Option<String>| json!({"search_id":search_id,"allowed":allowed,"reason":reason,"explanation":explanation,"next_allowed_at":next,"checked_at":iso(now),"plan":plan});
    let Some(saved) = search(config, search_id) else {
        return result(
            false,
            "search_removed",
            "This saved search was removed.".into(),
            None,
        );
    };
    if fulfilled.contains(search_id) {
        return result(
            false,
            "fulfilled",
            "This buying goal is fulfilled.".into(),
            None,
        );
    }
    if !b(&saved["enabled"])
        || monitoring(config, search_id).is_none_or(|m| m["preference"] != "recurring")
    {
        return result(
            false,
            "monitoring_off",
            "Recurring checks are off for this search.".into(),
            None,
        );
    }
    if dispatcher(config, search_id).is_some_and(|d| {
        host.map(|h| &h["status"])
            .unwrap_or(&d["schedule"]["status"])
            != "active"
    }) {
        return result(
            false,
            "dispatcher_paused",
            "The shared schedule is paused or unverified.".into(),
            None,
        );
    }
    if plan["rrule"].is_null() {
        return result(false,"no_active_times","All saved search times fall within quiet hours. Change the times or explicitly allow overnight checks.".into(),None);
    }
    let times = strings(&plan["times"]);
    let fallback = vec![s(&plan["quiet_hours"]["end"]).to_owned()];
    let next = |at: i64| {
        next_local_time(
            if times.is_empty() { &fallback } else { &times },
            s(&plan["timezone"]),
            at,
        )
    };
    if in_quiet_hours(now, &plan["quiet_hours"]) {
        return result(
            false,
            "quiet_hours",
            format!(
                "Scheduled searches pause from {} to {} ({}).",
                s(&plan["quiet_hours"]["start"]),
                s(&plan["quiet_hours"]["end"]),
                s(&plan["timezone"])
            ),
            next(now),
        );
    }
    if !dispatch
        || runs
            .iter()
            .any(|r| s(&r["search_id"]) == search_id && active(r))
    {
        return result(true, "ready", "Scheduled search permitted.".into(), None);
    }
    let started = runs
        .iter()
        .filter(|r| s(&r["search_id"]) == search_id && !r["scheduled_at"].is_null())
        .max_by_key(|r| time(s(&r["scheduled_at"])).unwrap_or(0));
    let timing = timing_for(config, search_id);
    if timing["mode"] == "daily"
        || (b(&plan["quiet_hours"]["enabled"]) && !b(&plan["guard_required"]))
    {
        let minute = local_parts(now, s(&plan["timezone"])).1;
        let due = times.iter().any(|t| {
            let at = minute_of_day(t);
            minute >= at && minute - at < 15 && !quiet_minute(at, &plan["quiet_hours"])
        });
        if !due {
            return result(
                false,
                "not_due",
                "The next saved daily search time has not arrived. Missed times are skipped."
                    .into(),
                next_local_time(&times, s(&plan["timezone"]), now),
            );
        }
        if started.is_some_and(|r| {
            time(s(&r["scheduled_at"])).ok().is_some_and(|t| {
                local_slot(&times, s(&plan["timezone"]), t)
                    == local_slot(&times, s(&plan["timezone"]), now)
            })
        }) {
            return result(
                false,
                "already_started",
                "This daily search time has already been started.".into(),
                next_local_time(&times, s(&plan["timezone"]), now),
            );
        }
    } else if let Some(run) = started
        && let Ok(t) = time(s(&run["scheduled_at"]))
    {
        let interval = n(&timing["interval_minutes"]);
        let due = t + ((interval as f64 - (interval as f64 / 4.0).min(5.0)) * 60_000.0) as i64;
        if due > now {
            return result(
                false,
                "not_due",
                "The next check interval has not elapsed.".into(),
                if in_quiet_hours(due, &plan["quiet_hours"]) {
                    next(due)
                } else {
                    Some(iso(due))
                },
            );
        }
    }
    result(true, "ready", "Scheduled search permitted.".into(), None)
}
pub fn dispatcher_plan(
    config: &Value,
    ids: &[String],
    fulfilled: &HashSet<String>,
    now: i64,
) -> Value {
    let members: Vec<_> = ids
        .iter()
        .filter(|id| {
            search(config, id).is_some_and(|s| b(&s["enabled"]))
                && !fulfilled.contains(*id)
                && monitoring(config, id).is_some_and(|m| m["preference"] == "recurring")
        })
        .collect();
    let plans: Vec<_> = members
        .iter()
        .map(|id| plan_for(config, id))
        .filter(|p| !p["rrule"].is_null())
        .collect();
    let times: Vec<String> = plans
        .iter()
        .flat_map(|p| strings(&p["times"]))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let rule = if !plans.is_empty() && plans.iter().all(|p| !a(&p["times"]).is_empty()) {
        daily_rule(&times.iter().map(|v| minute_of_day(v)).collect::<Vec<_>>())
    } else if !plans.is_empty()
        && plans
            .iter()
            .all(|p| canonical_rule(s(&p["rrule"])) == canonical_rule(s(&plans[0]["rrule"])))
    {
        Some(s(&plans[0]["rrule"]).to_owned())
    } else {
        None
    };
    let supported = plans.is_empty() || rule.is_some();
    let explanation = if supported {
        if rule.is_some() {
            "Shared wake-ups cover the active searches; each search keeps its own timing."
        } else {
            "No active members have permitted search times."
        }
    } else {
        "These continuous intervals cannot be combined exactly. Keep separate dispatcher groups for their timing plans."
    };
    json!({"search_ids":members.iter().filter(|id|!plan_for(config,id)["rrule"].is_null()).collect::<Vec<_>>(),"times":times,"rrule":rule,"timezone":config["schedule"]["quiet_hours"]["timezone"],"interval_minutes":plans.iter().map(|p|if p["timing"]["mode"]=="interval"{n(&p["timing"]["interval_minutes"])}else{1440}).min().unwrap_or(n(&config["schedule"]["interval_minutes"])),"supported":supported,"explanation":explanation,"next_wake_at":next_local_time(&times,s(&config["schedule"]["quiet_hours"]["timezone"]),now),"revision":hash(config)})
}
fn validate_timing(timing: &Value) -> Result<()> {
    if timing["mode"] == "daily" {
        let times = strings(&timing["times"]);
        if times.iter().collect::<HashSet<_>>().len() != times.len() {
            return invalid("Search times must be unique");
        }
    }
    Ok(())
}
pub fn set_monitoring(config: &mut Value, input: &Value) -> Result<()> {
    let request = contracts::parse("monitoringPreferenceSchema", input)?;
    if request.get("interval_minutes").is_some() && request.get("timing").is_some() {
        return invalid("Choose an interval or specific times, not both");
    }
    let sid = s(&request["search_id"]);
    if search(config, sid).is_none() {
        return invalid("Choose a saved search");
    }
    let previous = monitoring(config, sid).cloned().unwrap_or(Value::Null);
    let timing = request
        .get("timing")
        .cloned()
        .or_else(|| {
            request
                .get("interval_minutes")
                .map(|v| json!({"mode":"interval","interval_minutes":v}))
        })
        .unwrap_or_else(|| previous["timing"].clone());
    validate_timing(&timing)?;
    let minutes = if timing["mode"] == "daily" {
        json!(1440)
    } else {
        timing
            .get("interval_minutes")
            .or_else(|| previous.get("interval_minutes"))
            .unwrap_or(&config["schedule"]["interval_minutes"])
            .clone()
    };
    let record = json!({"search_id":sid,"preference":request["preference"],"interval_minutes":minutes,"timing":timing,"allow_quiet_hours":request.get("allow_quiet_hours").unwrap_or(&previous["allow_quiet_hours"]).as_bool().unwrap_or(false),"schedule":previous["schedule"],"interruption":previous["interruption"],"last_scheduled_run_at":previous["last_scheduled_run_at"]});
    let mut records = a(&config["monitoring"]).to_vec();
    records.retain(|m| s(&m["search_id"]) != sid);
    records.push(record);
    config["monitoring"] = json!(records);
    if request["preference"] == "recurring"
        && let Some(saved) = config["searches"]
            .as_array_mut()
            .and_then(|ss| ss.iter_mut().find(|s| s["id"] == sid))
    {
        saved["enabled"] = json!(true)
    }
    Ok(())
}
pub fn record_schedule(config: &mut Value, input: &Value, now: i64) -> Result<()> {
    let report = contracts::parse("hostScheduleReportSchema", input)?;
    validate_zone(&report["timezone"])?;
    let sid = s(&report["search_id"]);
    if report["status"] != "blocked" && report["automation_id"].is_null() {
        return invalid("A verified schedule needs its host automation ID");
    }
    if dispatcher(config, sid).is_some() {
        return invalid(
            "This search uses a shared schedule. Reconcile it with report_goodfinds_dispatcher_schedule.",
        );
    }
    let saved = search(config, sid).ok_or_else(|| {
        Error::validation("Save the buyer's monitoring choice for this search first")
    })?;
    let record = monitoring(config, sid).ok_or_else(|| {
        Error::validation("Save the buyer's monitoring choice for this search first")
    })?;
    let previous = record["schedule"].clone();
    if !report["automation_id"].is_null()
        && a(&config["monitoring"]).iter().any(|m| {
            m["search_id"] != sid && m["schedule"]["automation_id"] == report["automation_id"]
        })
    {
        return invalid("That automation belongs to another saved search");
    }
    if !previous.is_null() && previous["thread_id"] != report["thread_id"] {
        return invalid("Keep this schedule in its original buying thread");
    }
    if !previous["automation_id"].is_null()
        && previous["status"] != "removed"
        && !report["automation_id"].is_null()
        && previous["automation_id"] != report["automation_id"]
    {
        return invalid("Update the existing automation instead of creating a duplicate");
    }
    if report["status"] == "active" {
        if !b(&saved["enabled"]) || record["preference"] != "recurring" {
            return invalid(
                "Recurring checks require an enabled search and the buyer's search choice",
            );
        }
        if report["interval_minutes"] != record["interval_minutes"] {
            return invalid("Verify the host schedule at the buyer's saved frequency");
        }
        if !report["rrule"].is_null() {
            let plan = plan_for(config, sid);
            if plan["rrule"].is_null()
                || canonical_rule(s(&report["rrule"])) != canonical_rule(s(&plan["rrule"]))
                || report["timezone"] != plan["timezone"]
            {
                return invalid(
                    "Verify the host schedule's saved times, quiet hours and time zone",
                );
            }
        }
    }
    let record = config["monitoring"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| m["search_id"] == sid)
        .unwrap();
    if report["status"] == "blocked" {
        record["interruption"] = report["evidence"].clone();
        if !previous.is_null() {
            return Ok(());
        }
    } else {
        record["interruption"] = Value::Null
    }
    let mut receipt = report;
    receipt.as_object_mut().unwrap().remove("search_id");
    if receipt["last_run_at"].is_null() && previous["automation_id"] == receipt["automation_id"] {
        receipt["last_run_at"] = previous["last_run_at"].clone()
    }
    receipt["verified_at"] = json!(iso(now));
    record["schedule"] = receipt;
    Ok(())
}

fn interval_minutes(rule: &str) -> Option<i64> {
    let bare = rule.strip_prefix("RRULE:").unwrap_or(rule);
    let mut fields = HashMap::new();
    for token in bare.split(';') {
        let (k, v) = token.split_once('=')?;
        if fields.insert(k, v).is_some() {
            return None;
        }
        if k != "FREQ" && k != "INTERVAL" {
            return None;
        }
        if k == "INTERVAL" && (v.starts_with('0') || v.parse::<i64>().ok().is_none_or(|n| n < 1)) {
            return None;
        }
    }
    let unit = match fields.get("FREQ").copied() {
        Some("MINUTELY") => 1,
        Some("HOURLY") => 60,
        Some("DAILY") => 1440,
        _ => return None,
    };
    let minutes = unit
        * fields
            .get("INTERVAL")
            .copied()
            .unwrap_or("1")
            .parse::<i64>()
            .ok()?;
    (15..=1440).contains(&minutes).then_some(minutes)
}
pub fn host_observations(ws: &Workspace) -> Result<HashMap<String, Value>> {
    let mut results = HashMap::new();
    let Some(directory) = ws.automations_directory.as_ref() else {
        return Ok(results);
    };
    let mut records = a(&ws.config["monitoring"]).to_vec();
    for d in a(&ws.config["dispatchers"]) {
        records.push(
            json!({"search_id":format!("dispatcher:{}",s(&d["id"])),"schedule":d["schedule"]}),
        )
    }
    let mut cache = HashMap::new();
    let id_re = regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$").unwrap();
    for record in records {
        let schedule = &record["schedule"];
        let Some(automation_id) = schedule["automation_id"].as_str() else {
            continue;
        };
        let sid = s(&record["search_id"]);
        let cache_key = format!("{automation_id}:{}", s(&schedule["thread_id"]));
        if let Some(cached) = cache.get(&cache_key) {
            results.insert(sid.to_owned(), Value::clone(cached));
            continue;
        }
        let observation = |status: &str, evidence: &str, minutes: Option<i64>| json!({"status":status,"evidence":evidence,"interval_minutes":minutes,"checked_at":iso(ws.now),"rrule":null,"timezone":null});
        let value = if !id_re.is_match(automation_id) {
            observation(
                "unavailable",
                "This schedule needs verification through the host.",
                None,
            )
        } else if !directory.exists() {
            observation(
                "unavailable",
                "The host's schedule status is unavailable.",
                None,
            )
        } else {
            match std::fs::read_to_string(directory.join(automation_id).join("automation.toml")) {
                Ok(text) => match toml::from_str::<toml::Value>(&text)
                    .ok()
                    .and_then(|v| serde_json::to_value(v).ok())
                {
                    Some(v)
                        if v["kind"] == "heartbeat"
                            && ["ACTIVE", "PAUSED"].contains(&s(&v["status"]))
                            && v["rrule"].is_string()
                            && v["target_thread_id"].is_string() =>
                    {
                        if v["id"] != automation_id
                            || v["target_thread_id"] != schedule["thread_id"]
                        {
                            observation(
                                "unavailable",
                                "The linked schedule's identity or chat has changed.",
                                None,
                            )
                        } else {
                            let mut out = observation(
                                if v["status"] == "ACTIVE" {
                                    "active"
                                } else {
                                    "paused"
                                },
                                "Checked the linked Codex automation.",
                                interval_minutes(s(&v["rrule"])),
                            );
                            out["rrule"] = v["rrule"].clone();
                            out["timezone"] = v.get("timezone").cloned().unwrap_or_else(|| {
                                json!(
                                    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())
                                )
                            });
                            out
                        }
                    }
                    _ => observation(
                        "unavailable",
                        "The linked schedule could not be read or verified.",
                        None,
                    ),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    observation("removed", "The linked schedule no longer exists.", None)
                }
                Err(_) => observation(
                    "unavailable",
                    "The linked schedule could not be read or verified.",
                    None,
                ),
            }
        };
        cache.insert(cache_key, value.clone());
        results.insert(sid.to_owned(), value);
    }
    Ok(results)
}
fn host_for_search<'a>(
    config: &Value,
    hosts: &'a HashMap<String, Value>,
    sid: &str,
) -> Option<&'a Value> {
    dispatcher(config, sid)
        .and_then(|d| hosts.get(&format!("dispatcher:{}", s(&d["id"]))))
        .or_else(|| hosts.get(sid))
}
pub fn dispatcher_summaries(
    config: &Value,
    fulfilled: &HashSet<String>,
    now: i64,
    hosts: &HashMap<String, Value>,
) -> Vec<Value> {
    a(&config["dispatchers"]).iter().map(|d|json!({"dispatcher":d,"plan":dispatcher_plan(config,&strings(&d["search_ids"]),fulfilled,now),"host_schedule":hosts.get(&format!("dispatcher:{}",s(&d["id"])))})).collect()
}
fn dispatcher_matches(summary: &Value) -> bool {
    let host = &summary["host_schedule"];
    let receipt = &summary["dispatcher"]["schedule"];
    let rule = host
        .get("rrule")
        .filter(|v| !v.is_null())
        .unwrap_or(&receipt["rrule"]);
    let zone = host
        .get("timezone")
        .filter(|v| !v.is_null())
        .unwrap_or(&receipt["timezone"]);
    let status = host.get("status").unwrap_or(&receipt["status"]);
    b(&summary["plan"]["supported"])
        && !summary["plan"]["rrule"].is_null()
        && status == "active"
        && !rule.is_null()
        && canonical_rule(s(rule)) == canonical_rule(s(&summary["plan"]["rrule"]))
        && zone == &summary["plan"]["timezone"]
}
pub fn record_dispatcher(
    config: &mut Value,
    input: &Value,
    now: i64,
    fulfilled: &HashSet<String>,
    hosts: &HashMap<String, Value>,
) -> Result<()> {
    let report = contracts::parse("dispatcherReportSchema", input)?;
    validate_zone(&report["schedule"]["timezone"])?;
    if report["schedule"]["thread_id"] != report["thread_id"]
        || (report["schedule"]["status"] != "blocked"
            && report["schedule"]["automation_id"].is_null())
    {
        return invalid("Verify the original chat and host automation identity");
    }
    let ids = strings(&report["search_ids"]);
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return invalid("Searches must be unique");
    }
    if s(&report["plan_revision"]) != hash(config) {
        return invalid(
            "The shared schedule plan changed. Read its context again before reporting it.",
        );
    }
    let previous = a(&config["dispatchers"])
        .iter()
        .find(|d| d["id"] == report["dispatcher_id"])
        .cloned();
    if let Some(p) = &previous {
        if ["thread_id", "host_id", "notification_policy"]
            .iter()
            .any(|k| p[*k] != report[*k])
        {
            return invalid("Preserve the original host, buying chat and notification settings");
        }
        if report["schedule"]["status"] != "blocked"
            && !p["schedule"]["automation_id"].is_null()
            && p["schedule"]["status"] != "removed"
            && report["schedule"]["automation_id"] != p["schedule"]["automation_id"]
        {
            return invalid("Reuse the existing shared automation");
        }
    }
    for sid in &ids {
        let Some(m) = monitoring(config, sid) else {
            return invalid(
                "Only searches with an existing recurring choice can join a dispatcher",
            );
        };
        if search(config, sid).is_none() || m["preference"] != "recurring" {
            return invalid(
                "Only searches with an existing recurring choice can join a dispatcher",
            );
        }
        if a(&config["dispatchers"])
            .iter()
            .any(|d| d["id"] != report["dispatcher_id"] && strings(&d["search_ids"]).contains(sid))
        {
            return invalid("This search already belongs to another dispatcher");
        }
        if !m["schedule"]["thread_id"].is_null()
            && m["schedule"]["thread_id"] != report["thread_id"]
        {
            return invalid("Keep each search in its original buying chat");
        }
        if report["schedule"]["status"] != "blocked"
            && !m["schedule"]["automation_id"].is_null()
            && m["schedule"]["automation_id"] != report["schedule"]["automation_id"]
        {
            let status = hosts
                .get(sid)
                .map(|h| s(&h["status"]))
                .unwrap_or(s(&m["schedule"]["status"]));
            if !["paused", "removed"].contains(&status) {
                return invalid(
                    "Pause and verify the redundant automation before migrating this search",
                );
            }
        }
    }
    if report["schedule"]["status"] == "blocked" {
        for m in config["monitoring"].as_array_mut().unwrap() {
            if ids.iter().any(|id| id == s(&m["search_id"])) {
                m["interruption"] = report["schedule"]["evidence"].clone()
            }
        }
        return Ok(());
    }
    if let Some(previous) = &previous
        && report["schedule"]["status"] == "active"
        && strings(&previous["search_ids"]).iter().any(|id| {
            !ids.contains(id)
                && search(config, id).is_some_and(|s| b(&s["enabled"]))
                && monitoring(config, id).is_some_and(|m| m["preference"] == "recurring")
                && !fulfilled.contains(id)
        })
    {
        return invalid("Pause or stop a search before removing its active dispatcher membership");
    }
    let plan = dispatcher_plan(config, &ids, fulfilled, now);
    if previous.is_none()
        && a(&config["dispatchers"]).iter().any(|d| {
            let mut members = strings(&d["search_ids"]);
            for id in &ids {
                if !members.contains(id) {
                    members.push(id.clone())
                }
            }
            d["thread_id"] == report["thread_id"]
                && d["host_id"] == report["host_id"]
                && d["notification_policy"] == report["notification_policy"]
                && d["schedule"]["status"] != "removed"
                && b(&dispatcher_plan(config, &members, fulfilled, now)["supported"])
        })
    {
        return invalid(
            "Join the existing compatible dispatcher instead of creating a duplicate schedule",
        );
    }
    if a(&config["dispatchers"]).iter().any(|d| {
        d["id"] != report["dispatcher_id"]
            && d["schedule"]["automation_id"] == report["schedule"]["automation_id"]
    }) {
        return invalid("That host automation already belongs to another dispatcher");
    }
    if report["schedule"]["status"] == "active"
        && (!b(&plan["supported"])
            || plan["rrule"].is_null()
            || canonical_rule(s(&report["schedule"]["rrule"])) != canonical_rule(s(&plan["rrule"]))
            || report["schedule"]["timezone"] != plan["timezone"])
    {
        return invalid("Verify the shared recurrence against the current dispatcher plan");
    }
    let mut schedule = report["schedule"].clone();
    schedule["verified_at"] = json!(iso(now));
    let d = json!({"id":report["dispatcher_id"],"thread_id":report["thread_id"],"host_id":report["host_id"],"notification_policy":report["notification_policy"],"search_ids":ids,"schedule":schedule});
    let mut dispatchers = a(&config["dispatchers"]).to_vec();
    dispatchers.retain(|v| v["id"] != d["id"]);
    dispatchers.push(d);
    config["dispatchers"] = json!(dispatchers);
    for m in config["monitoring"].as_array_mut().unwrap() {
        if ids.iter().any(|id| id == s(&m["search_id"])) {
            if m["last_scheduled_run_at"].is_null() {
                m["last_scheduled_run_at"] = m["schedule"]["last_run_at"].clone()
            }
            m["schedule"] = Value::Null;
            m["interruption"] = Value::Null;
        }
    }
    Ok(())
}
fn monitoring_summary(
    config: &Value,
    search: &Value,
    fulfilled: bool,
    sample: bool,
    host: Option<&Value>,
    now: i64,
    shared: Option<&Value>,
) -> Value {
    let sid = s(&search["id"]);
    let empty = Value::Null;
    let record = monitoring(config, sid).unwrap_or(&empty);
    let preference = record["preference"].as_str().unwrap_or("undecided");
    let minutes = record
        .get("interval_minutes")
        .unwrap_or(&config["schedule"]["interval_minutes"]);
    let timing = timing_for(config, sid);
    let plan = plan_for(config, sid);
    let quiet = in_quiet_hours(now, &plan["quiet_hours"]);
    let shared = shared.unwrap_or(&empty);
    let host = shared
        .get("host_schedule")
        .filter(|v| !v.is_null())
        .or(host)
        .unwrap_or(&empty);
    let mut receipt = if sample {
        Value::Null
    } else {
        shared
            .get("dispatcher")
            .map(|d| d["schedule"].clone())
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| record["schedule"].clone())
    };
    if !receipt.is_null() && !shared.is_null() {
        receipt["last_run_at"] = record["last_scheduled_run_at"].clone()
    }
    let mut schedule = receipt.clone();
    if !receipt.is_null() && !host.is_null() && host["status"] != "unavailable" {
        schedule["status"] = host["status"].clone();
        if !host["interval_minutes"].is_null() {
            schedule["interval_minutes"] = host["interval_minutes"].clone()
        }
        schedule["next_run_at"] = Value::Null;
        schedule["last_run_at"] = record
            .get("last_scheduled_run_at")
            .filter(|v| !v.is_null())
            .unwrap_or(&receipt["last_run_at"])
            .clone()
    }
    let interruption = if !host.is_null() && host["status"] != "unavailable" {
        Value::Null
    } else {
        record["interruption"].clone()
    };
    let result = |status: &str, label: &str, next_action: &str| {
        let times = strings(&plan["times"]);
        let fallback = vec![s(&plan["quiet_hours"]["end"]).to_owned()];
        json!({"search_id":sid,"preference":preference,"interval_minutes":minutes,"timing":timing,"plan":plan,"quiet_now":quiet,"next_allowed_at":if quiet&&!plan["rrule"].is_null(){next_local_time(if times.is_empty(){&fallback}else{&times},s(&plan["timezone"]),now)}else{None},"status":status,"label":label,"next_action":next_action,"schedule":schedule,"host_schedule":if sample{&empty}else{host},"interruption":interruption,"dispatcher_id":shared["dispatcher"]["id"],"next_search_at":next_local_time(&times,s(&plan["timezone"]),now)})
    };
    if sample {
        return result("saved", "Sample search", "none");
    }
    if host["status"] == "unavailable"
        && (shared.is_null() || (b(&search["enabled"]) && !fulfilled && preference == "recurring"))
    {
        return result("unverified", "Schedule unverified", "check");
    }
    if fulfilled || !b(&search["enabled"]) || preference == "once" {
        if schedule["status"] == "active"
            && (shared.is_null() || a(&shared["plan"]["search_ids"]).is_empty())
        {
            return result("stop_needed", "Pause monitoring needed", "pause");
        }
        if fulfilled {
            return result("fulfilled", "Fulfilled", "none");
        }
        return if b(&search["enabled"]) {
            result("saved", "Monitoring off", "none")
        } else {
            result("paused", "Paused", "none")
        };
    }
    if preference == "undecided" {
        return result("choice_needed", "Monitoring off", "choose");
    }
    if schedule["status"] == "paused" {
        return result("paused", "Monitoring paused", "resume");
    }
    if host["status"] == "active" && host["interval_minutes"].is_null() && host["rrule"].is_null() {
        return result("setup_needed", "Schedule changed", "update");
    }
    if !interruption.is_null() || schedule["status"] == "blocked" {
        return result(
            "blocked",
            "Monitoring needs attention",
            if schedule["automation_id"].is_null() {
                "start"
            } else {
                "update"
            },
        );
    }
    if schedule["status"] == "active" {
        let rule = host
            .get("rrule")
            .filter(|v| !v.is_null())
            .unwrap_or(&schedule["rrule"]);
        let zone = host
            .get("timezone")
            .filter(|v| !v.is_null())
            .unwrap_or(&schedule["timezone"]);
        let expected = shared
            .get("plan")
            .and_then(|p| p.get("rrule"))
            .filter(|v| !v.is_null())
            .unwrap_or(&plan["rrule"]);
        let matches = !expected.is_null()
            && (shared.is_null() || b(&shared["plan"]["supported"]))
            && !rule.is_null()
            && canonical_rule(s(rule)) == canonical_rule(s(expected))
            && zone == &plan["timezone"];
        if !matches {
            return result(
                "setup_needed",
                if plan["rrule"].is_null() {
                    "No active search times"
                } else {
                    "Schedule update needed"
                },
                "update",
            );
        }
        return if quiet {
            result("quiet", "Quiet hours", "none")
        } else {
            result("active", "Monitoring active", "none")
        };
    }
    result(
        "setup_needed",
        if schedule["status"] == "removed" {
            "Schedule removed"
        } else {
            "Monitoring setup needed"
        },
        "start",
    )
}
pub fn monitoring_snapshot(
    ws: &Workspace,
    searches: &[Value],
    fulfilled: &HashSet<String>,
) -> Result<Value> {
    let hosts = host_observations(ws)?;
    let dispatchers = dispatcher_summaries(&ws.config, fulfilled, ws.now, &hosts);
    let monitoring: Vec<Value> = searches
        .iter()
        .map(|s| {
            monitoring_summary(
                &ws.config,
                s,
                fulfilled.contains(crate::searches::s(&s["id"])),
                ws.mode == "sample",
                hosts.get(crate::searches::s(&s["id"])),
                ws.now,
                dispatchers
                    .iter()
                    .find(|d| a(&d["dispatcher"]["search_ids"]).contains(&s["id"])),
            )
        })
        .collect();
    Ok(json!({"monitoring":monitoring,"dispatchers":dispatchers}))
}
pub fn reconcile_scheduled_runs(ws: &mut Workspace) -> Result<()> {
    let hosts = host_observations(ws)?;
    let fulfilled = fulfilled_searches(ws)?;
    for mut run in raw_runs(ws, None, false)? {
        if run["trigger"] == "scheduled" && active(&run) {
            let check = scheduled_check(
                &ws.config,
                s(&run["search_id"]),
                ws.now,
                &fulfilled,
                &[],
                false,
                host_for_search(&ws.config, &hosts, s(&run["search_id"])),
            );
            if !b(&check["allowed"]) {
                stop_run(
                    &mut run,
                    ws.now,
                    s(&check["explanation"]),
                    check["reason"] == "quiet_hours",
                );
                run["interruption"] = Value::Null;
                save_run(ws, &run)?
            }
        }
    }
    Ok(())
}
fn scheduled_batch(ws: &mut Workspace, input: &Value) -> Result<Value> {
    let request = contracts::parse("scheduledBatchSchema", input)?;
    let fulfilled = fulfilled_searches(ws)?;
    let hosts = host_observations(ws)?;
    let d = a(&ws.config["dispatchers"])
        .iter()
        .find(|d| d["id"] == request["dispatcher_id"] && d["thread_id"] == request["thread_id"])
        .ok_or_else(|| Error::validation("Choose the shared schedule in its original buying chat"))?
        .clone();
    let summaries = dispatcher_summaries(&ws.config, &fulfilled, ws.now, &hosts);
    let summary = summaries
        .iter()
        .find(|s| s["dispatcher"]["id"] == d["id"])
        .unwrap();
    let mut result = json!({"dispatcher_id":d["id"],"checked_at":iso(ws.now),"reason":"ready","runs":[],"skipped":[]});
    if !dispatcher_matches(summary) {
        let status = summary["host_schedule"]
            .get("status")
            .or_else(|| d["schedule"].get("status"))
            .and_then(Value::as_str)
            .unwrap_or("unverified");
        result["reason"] = json!(if status == "active" {
            "schedule_update_needed"
        } else {
            status
        });
        return Ok(result);
    }
    reconcile(ws)?;
    for sid in strings(&d["search_ids"]) {
        let recent = runs(ws, Some(&sid))?;
        let latest = latest_scheduled(ws, &sid)?;
        let mut history = recent.clone();
        if let Some(latest) = &latest {
            history.retain(|r| r["id"] != latest["id"]);
            history.push(latest.clone())
        }
        let check = scheduled_check(
            &ws.config,
            &sid,
            ws.now,
            &fulfilled,
            &history,
            true,
            host_for_search(&ws.config, &hosts, &sid),
        );
        if !b(&check["allowed"]) {
            result["skipped"]
                .as_array_mut()
                .unwrap()
                .push(json!({"search_id":sid,"reason":check["reason"]}));
            continue;
        }
        let plan = dispatcher_plan(&ws.config, std::slice::from_ref(&sid), &fulfilled, ws.now);
        let times = strings(&plan["times"]);
        let slot = if !times.is_empty() {
            local_slot(&times, s(&plan["timezone"]), ws.now).unwrap_or_else(|| iso(ws.now))
        } else {
            format!(
                "{}:{}",
                latest.as_ref().map(|r| s(&r["id"])).unwrap_or("first"),
                s(&request["request_id"])
            )
        };
        let digits = hash(&json!({"searchId":sid,"slot":slot}));
        let occurrence = format!(
            "{}-{}-5{}-a{}-{}",
            &digits[..8],
            &digits[8..12],
            &digits[13..16],
            &digits[17..20],
            &digits[20..32]
        );
        let run = if let Some(active) = recent.iter().find(|r| active(r)) {
            active.clone()
        } else {
            run_action(
                ws,
                "start",
                &json!({"search_id":sid,"request_id":occurrence,"trigger":"scheduled","resume":true}),
            )?
        };
        result["runs"].as_array_mut().unwrap().push(json!({"search_id":sid,"run_id":run["id"],"version":run["version"],"phase":run["phase"],"worker_id":run["worker"]["id"],"agent_id":run["worker"]["agent_id"]}));
    }
    if a(&result["runs"]).is_empty() {
        result["reason"] = json!("nothing_due")
    }
    Ok(result)
}
pub fn command(ws: &mut Workspace, action: &str, args: &Value) -> Result<Value> {
    match action {
        "set_monitoring" => {
            set_monitoring(&mut ws.config, &args["monitoring"])?;
            reconcile_scheduled_runs(ws)?;
            Ok(json!({}))
        }
        "report_host_schedule" => {
            record_schedule(&mut ws.config, &args["report"], ws.now)?;
            reconcile_scheduled_runs(ws)?;
            Ok(json!({}))
        }
        "report_dispatcher_schedule" => {
            let fulfilled = fulfilled_searches(ws)?;
            let hosts = host_observations(ws)?;
            record_dispatcher(&mut ws.config, &args["report"], ws.now, &fulfilled, &hosts)?;
            reconcile_scheduled_runs(ws)?;
            Ok(json!({}))
        }
        "request_scheduled_batch" => {
            let supplied = args.get("request").unwrap_or(args);
            let mut input = json!({});
            for key in ["dispatcher_id", "thread_id", "request_id"] {
                if let Some(value) = supplied.get(key) {
                    input[key] = value.clone();
                }
            }
            Ok(json!({"batch":scheduled_batch(ws,&input)?}))
        }
        "check_scheduled_search" => {
            let sid = s(&args["search_id"]);
            let hosts = host_observations(ws)?;
            let fulfilled = fulfilled_searches(ws)?;
            let mut history = runs(ws, Some(sid))?;
            if let Some(latest) = latest_scheduled(ws, sid)? {
                history.push(latest)
            }
            Ok(scheduled_check(
                &ws.config,
                sid,
                ws.now,
                &fulfilled,
                &history,
                true,
                host_for_search(&ws.config, &hosts, sid),
            ))
        }
        "get_dispatcher_context" => dispatcher_context(ws, args),
        "list_search_runs" => {
            let selected = runs(ws, args["search_id"].as_str())?;
            let progress_only = b(&args["progress_only"]);
            let mut output = json!({"search_run_workflows":if progress_only{json!({})}else{workflow_views(&ws.config,&selected,&fulfilled_searches(ws)?,ws.now)["search_run_workflows"].clone()}});
            output["search_runs"] = json!(
                selected
                    .iter()
                    .map(|r| if progress_only {
                        json!({"id":r["id"],"version":r["version"],"phase":r["phase"]})
                    } else {
                        let mut run = r.clone();
                        run["progress"] = search_progress(r);
                        run
                    })
                    .collect::<Vec<_>>()
            );
            Ok(output)
        }
        "request_search_run" | "update_search_run" | "claim_search_run" | "renew_search_lease"
        | "cancel_search_run" => {
            let request = &args["request"];
            let fulfilled = fulfilled_searches(ws)?;
            let hosts = host_observations(ws)?;
            if action == "request_search_run" && request["trigger"] == "scheduled" {
                let sid = s(&request["search_id"]);
                let mut history = runs(ws, Some(sid))?;
                if let Some(latest) = latest_scheduled(ws, sid)? {
                    history.push(latest)
                }
                let check = scheduled_check(
                    &ws.config,
                    sid,
                    ws.now,
                    &fulfilled,
                    &history,
                    true,
                    host_for_search(&ws.config, &hosts, sid),
                );
                if !b(&check["allowed"]) {
                    return Ok(json!({"scheduled_check":check}));
                }
            } else if action == "request_search_run" {
                reconcile_scheduled_runs(ws)?;
            } else if action != "cancel_search_run"
                && let Some(mut run) = find_run(ws, s(&request["run_id"]))?
                && run["trigger"] == "scheduled"
            {
                let check = scheduled_check(
                    &ws.config,
                    s(&run["search_id"]),
                    ws.now,
                    &fulfilled,
                    &[],
                    false,
                    host_for_search(&ws.config, &hosts, s(&run["search_id"])),
                );
                if !b(&check["allowed"]) {
                    if active(&run) {
                        stop_run(
                            &mut run,
                            ws.now,
                            s(&check["explanation"]),
                            check["reason"] == "quiet_hours",
                        );
                        run["interruption"] = Value::Null;
                        save_run(ws, &run)?
                    }
                    return Ok(json!({"scheduled_check":check}));
                }
            }
            let mapped = match action {
                "request_search_run" => "start",
                "claim_search_run" => "claim",
                "renew_search_lease" => "heartbeat",
                "cancel_search_run" => "cancel",
                _ => "update",
            };
            let run = run_action(ws, mapped, request)?;
            if run["phase"] == "completed"
                && run["trigger"] == "scheduled"
                && let Some(m) = ws.config["monitoring"]
                    .as_array_mut()
                    .and_then(|m| m.iter_mut().find(|m| m["search_id"] == run["search_id"]))
            {
                m["last_scheduled_run_at"] = run["updated_at"].clone()
            }
            Ok(json!({"run":run}))
        }
        _ => invalid(format!("Unknown search operation: {action}")),
    }
}
fn dispatcher_context(ws: &Workspace, args: &Value) -> Result<Value> {
    let mut scoped = json!({});
    for key in ["thread_id", "search_ids", "dispatcher_id"] {
        if let Some(value) = args.get(key) {
            scoped[key] = value.clone();
        }
    }
    let input = contracts::parse("dispatcherContextInputSchema", &scoped)?;
    let fulfilled = fulfilled_searches(ws)?;
    let hosts = host_observations(ws)?;
    let dispatchers: Vec<Value> = dispatcher_summaries(&ws.config, &fulfilled, ws.now, &hosts)
        .into_iter()
        .filter(|d| d["dispatcher"]["thread_id"] == input["thread_id"])
        .collect();
    let selected = dispatchers
        .iter()
        .find(|d| d["dispatcher"]["id"] == input["dispatcher_id"])
        .map(|d| d["dispatcher"].clone())
        .unwrap_or(Value::Null);
    if !input["dispatcher_id"].is_null() && selected.is_null() {
        return invalid("Choose a dispatcher in this buying chat");
    }
    let ids = if input["search_ids"].is_array() {
        strings(&input["search_ids"])
    } else if !selected.is_null() {
        strings(&selected["search_ids"])
    } else {
        dispatchers
            .iter()
            .flat_map(|d| strings(&d["dispatcher"]["search_ids"]))
            .collect()
    };
    for id in &ids {
        let m = monitoring(&ws.config, id);
        let owning = dispatcher(&ws.config, id);
        if search(&ws.config, id).is_none()
            || m.is_some_and(|m| {
                !m["schedule"].is_null() && m["schedule"]["thread_id"] != input["thread_id"]
            })
            || owning.is_some_and(|d| d["thread_id"] != input["thread_id"])
        {
            return invalid("Choose saved searches from this buying chat");
        }
    }
    Ok(
        json!({"revision":hash(&ws.config),"mode":ws.mode,"plan":dispatcher_plan(&ws.config,&ids,&fulfilled,ws.now),"dispatcher":selected,"dispatchers":dispatchers,"legacy_schedules":a(&ws.config["monitoring"]).iter().filter(|m|ids.iter().any(|id|id==s(&m["search_id"]))&&!m["schedule"].is_null()).map(|m|json!({"search_id":m["search_id"],"schedule":m["schedule"]})).collect::<Vec<_>>()}),
    )
}

pub fn search_cover_product(search: &Value) -> Option<String> {
    search["discovery"]["reference_model"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| match s(&search["product"]) {
            "macbook_pro" => Some("MacBook Pro".into()),
            "mac_mini" => Some("Mac mini".into()),
            "mac_pro" => Some("Mac Pro".into()),
            _ => None,
        })
}
pub fn cover_follow_up(search: &Value) -> Value {
    let Some(product) = search_cover_product(search) else {
        return Value::Null;
    };
    let sources: Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/data/search-cover-sources.json"
    ))
    .expect("bundled cover index");
    fn contains_id(value: &Value, media_id: &str) -> bool {
        match value {
            Value::Object(m) => {
                m.get("media_id").is_some_and(|v| s(v) == media_id)
                    || m.iter()
                        .any(|(k, v)| k == media_id || contains_id(v, media_id))
            }
            Value::Array(v) => v.iter().any(|v| contains_id(v, media_id)),
            _ => false,
        }
    }
    let cover = &search["cover"];
    if search["product"] == "rental"
        || (!cover.is_null()
            && (cover["kind"] == "user" || !contains_id(&sources, s(&cover["media_id"]))))
    {
        return Value::Null;
    }
    json!({"search_id":search["id"],"product":product,"action":"fetch_manufacturer_photo","required":true})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> (tempfile::TempDir, Workspace) {
        let directory = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(directory.path(), "live", "search-test").unwrap();
        ws.now = time("2026-06-01T12:00:00.000Z").unwrap();
        ws.automations_directory = None;
        let search = contracts::data("example")["searches"][0].clone();
        ws.config["searches"] = json!([search]);
        (directory, ws)
    }
    fn request(ws: &mut Workspace) -> Value {
        run_action(
            ws,
            "start",
            &json!({"search_id":ws.config["searches"][0]["id"],"request_id":id()}),
        )
        .unwrap()
    }
    fn quiet() -> Value {
        json!({"enabled":true,"start":"22:00","end":"08:00","timezone":"Europe/London"})
    }
    #[test]
    fn definition_answers_and_interview_visibility() {
        let definition = json!({"schema_version":1,"version":1,"category":"camera","title":"Camera","description":"Choose a camera","price":{"currency":"GBP","period":"once"},"comparison_attributes":["model"],"fields":[{"id":"kind","label":"Kind","type":"single_choice","required":true,"options":[{"value":"digital","label":"Digital"},{"value":"film","label":"Film"}]},{"id":"pixels","label":"Pixels","type":"integer","minimum":1,"visible_when":{"field":"kind","one_of":["digital"]},"match":{"attribute":"pixels","operator":"gte"}}]});
        let d = validate_definition(&definition).unwrap();
        assert_eq!(
            clean_answers(&d, &json!({"kind":"film","pixels":-2}), false).unwrap(),
            json!({"kind":"film"})
        );
        assert!(clean_answers(&d, &json!({"kind":"digital","pixels":-2}), false).is_err());
        assert!(clean_answers(&d, &json!({}), false).is_err());
        assert!(clean_answers(&d, &json!({}), true).is_ok());
        assert_eq!(
            interview_fields(&d, &json!({}), "setup", None, &[]).len(),
            1
        );
        assert_eq!(
            interview_fields(&d, &json!({"kind":"digital"}), "refinement", None, &[]).len(),
            1
        );
        let mut invalid_d = definition.clone();
        invalid_d["fields"][0]["visible_when"] = json!({"field":"pixels","one_of":[1]});
        assert!(validate_definition(&invalid_d).is_err());
    }
    #[test]
    fn numeric_native_answers_preserve_minor_units() {
        let f = json!({"id":"budget","label":"Budget","type":"integer","display_divisor":100,"minimum":1});
        assert_eq!(
            native_answer(&f, &json!({"budget":42.35}), true).unwrap(),
            json!(4235.0)
        );
        assert_eq!(
            native_answer(&f, &json!({"budget":"__no_preference__"}), false).unwrap(),
            Value::Null
        );
    }
    #[test]
    fn leases_fence_workers_and_reads_do_not_write() {
        let (_dir, mut ws) = workspace();
        let run = request(&mut ws);
        let worker = id();
        let claimed=run_action(&mut ws,"claim",&json!({"run_id":run["id"],"expected_version":0,"worker_id":worker,"agent_id":"real-agent"})).unwrap();
        assert_eq!(claimed["phase"], "discovering");
        assert!(
            run_action(
                &mut ws,
                "heartbeat",
                &json!({"run_id":run["id"],"worker_id":id()})
            )
            .is_err()
        );
        ws.now += SEARCH_LEASE_MS;
        let projected = runs(&ws, None).unwrap();
        assert_eq!(projected[0]["phase"], "blocked");
        assert_eq!(
            find_run(&ws, s(&run["id"])).unwrap().unwrap()["phase"],
            "discovering"
        );
        let failure = run_action(
            &mut ws,
            "heartbeat",
            &json!({"run_id":run["id"],"worker_id":worker}),
        )
        .unwrap_err();
        assert!(failure.blockers.is_some());
        let resumed = run_action(
            &mut ws,
            "start",
            &json!({"search_id":run["search_id"],"request_id":id(),"resume":true}),
        )
        .unwrap();
        assert_eq!(resumed["id"], run["id"]);
        assert!(resumed["worker"].is_null());
        assert_eq!(resumed["phase"], "requested");
    }
    #[test]
    fn run_identity_coverage_and_changed_brief_fences() {
        let (_dir, mut ws) = workspace();
        let run = request(&mut ws);
        let repeated = run_action(
            &mut ws,
            "start",
            &json!({"search_id":run["search_id"],"request_id":run["id"]}),
        )
        .unwrap();
        assert_eq!(run, repeated);
        assert!(
            run_action(
                &mut ws,
                "update",
                &json!({"run_id":run["id"],"expected_version":0,"phase":"completed"})
            )
            .is_err()
        );
        let mut query = run["queries"][0].clone();
        query["text"] = json!("replacement");
        assert!(
            run_action(
                &mut ws,
                "update",
                &json!({"run_id":run["id"],"expected_version":0,"query":query})
            )
            .is_err()
        );
        ws.config["searches"][0]["name"] = json!("Changed brief");
        assert!(run_action(&mut ws,"claim",&json!({"run_id":run["id"],"expected_version":0,"worker_id":id(),"agent_id":"agent"})).unwrap_err().message.contains("brief changed"));
        let cancelled = run_action(&mut ws, "cancel", &json!({"run_id":run["id"]})).unwrap();
        assert_eq!(cancelled["phase"], "cancelled");
        assert_eq!(
            run_action(&mut ws, "cancel", &json!({"run_id":run["id"]})).unwrap(),
            cancelled
        );
    }
    #[test]
    fn atomic_category_progress_and_discovery_provenance() {
        let (_dir, mut ws) = workspace();
        let mut run = request(&mut ws);
        for index in 0..a(&run["queries"]).len() {
            let mut query = run["queries"][index].clone();
            query["status"] = json!("completed");
            run = run_action(
                &mut ws,
                "update",
                &json!({"run_id":run["id"],"expected_version":run["version"],"query":query}),
            )
            .unwrap();
        }
        let import_product = ws.config["searches"][0]["product"].clone();
        record_import(&mut ws,s(&run["id"]),&[json!({"key":"fixture-listing","product":import_product,"collection_stage":"verification","image_review":{"complete":true}})],None).unwrap();
        run = find_run(&ws, s(&run["id"])).unwrap().unwrap();
        assert_eq!(run["verified_keys"], json!(["fixture-listing"]));
        assert!(run["first_result_at"].is_string());
        let count: i64 = ws
            .db
            .query_row("SELECT count(*) FROM listing_search_discoveries", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        let completed = run_action(
            &mut ws,
            "update",
            &json!({"run_id":run["id"],"expected_version":run["version"],"phase":"completed"}),
        )
        .unwrap();
        assert_eq!(completed["phase"], "completed");
        assert!(record_import(&mut ws, s(&run["id"]), &[], None).is_err());
    }
    #[test]
    fn daily_schedules_preserve_exact_pairs_and_dst() {
        let plan = schedule_plan(
            &json!({"mode":"daily","times":["08:10","10:40","23:00"]}),
            &quiet(),
            false,
        );
        assert_eq!(plan["excluded_times"], json!(["23:00"]));
        assert_eq!(
            plan["rrule"],
            "FREQ=DAILY;BYHOUR=8,10;BYMINUTE=10,40;BYSECOND=0;BYSETPOS=1,4"
        );
        assert_eq!(
            canonical_rule("RRULE:FREQ=HOURLY;INTERVAL=1"),
            canonical_rule("INTERVAL=60;FREQ=MINUTELY")
        );
        assert!(canonical_rule("FREQ=DAILY;FREQ=HOURLY").starts_with("INVALID:"));
        let spring = time("2026-03-29T00:00:00.000Z").unwrap();
        assert_eq!(
            next_local_time(&["01:30".into()], "Europe/London", spring),
            Some("2026-03-30T00:30:00.000Z".into())
        );
        let autumn = time("2026-10-25T00:45:00.000Z").unwrap();
        assert_eq!(
            next_local_time(&["01:30".into()], "Europe/London", autumn),
            Some("2026-10-25T01:30:00.000Z".into())
        );
    }
    #[test]
    fn monitoring_keeps_verified_receipt_after_failed_check() {
        let (_dir, mut ws) = workspace();
        let sid = ws.config["searches"][0]["id"].clone();
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":sid,"preference":"recurring","interval_minutes":60}),
        )
        .unwrap();
        let thread = id();
        let plan = plan_for(&ws.config, s(&sid));
        let report = json!({"search_id":sid,"automation_id":"schedule-one","thread_id":thread,"status":"active","interval_minutes":60,"rrule":plan["rrule"],"timezone":plan["timezone"],"evidence":"Verified"});
        record_schedule(&mut ws.config, &report, ws.now).unwrap();
        let mut blocked = report.clone();
        blocked["status"] = json!("blocked");
        blocked["evidence"] = json!("Host offline");
        record_schedule(&mut ws.config, &blocked, ws.now).unwrap();
        assert_eq!(ws.config["monitoring"][0]["schedule"]["status"], "active");
        assert_eq!(ws.config["monitoring"][0]["interruption"], "Host offline");
        let mut duplicate = report;
        duplicate["automation_id"] = json!("new-automation");
        assert!(record_schedule(&mut ws.config, &duplicate, ws.now).is_err());
    }
    #[test]
    fn shared_dispatch_is_reserved_once_and_keeps_pauses() {
        let (_dir, mut ws) = workspace();
        ws.config["schedule"]["quiet_hours"] = quiet();
        ws.now = time("2026-06-01T07:01:00.000Z").unwrap();
        let sid = ws.config["searches"][0]["id"].clone();
        set_monitoring(&mut ws.config,&json!({"search_id":sid,"preference":"recurring","timing":{"mode":"daily","times":["08:00","12:00"]}})).unwrap();
        let thread = id();
        let did = id();
        let plan = dispatcher_plan(&ws.config, &[s(&sid).into()], &HashSet::new(), ws.now);
        let report = json!({"plan_revision":hash(&ws.config),"dispatcher_id":did,"thread_id":thread,"search_ids":[sid],"schedule":{"automation_id":"shared-one","thread_id":thread,"status":"active","interval_minutes":1440,"rrule":plan["rrule"],"timezone":plan["timezone"],"evidence":"Verified shared host schedule"}});
        record_dispatcher(
            &mut ws.config,
            &report,
            ws.now,
            &HashSet::new(),
            &HashMap::new(),
        )
        .unwrap();
        let batch = scheduled_batch(
            &mut ws,
            &json!({"dispatcher_id":did,"thread_id":thread,"request_id":id()}),
        )
        .unwrap();
        assert_eq!(a(&batch["runs"]).len(), 1);
        let second = scheduled_batch(
            &mut ws,
            &json!({"dispatcher_id":did,"thread_id":thread,"request_id":id()}),
        )
        .unwrap();
        assert_eq!(batch["runs"][0]["run_id"], second["runs"][0]["run_id"]);
        ws.config["dispatchers"][0]["schedule"]["status"] = json!("paused");
        let paused = scheduled_batch(
            &mut ws,
            &json!({"dispatcher_id":did,"thread_id":thread,"request_id":id()}),
        )
        .unwrap();
        assert!(a(&paused["runs"]).is_empty());
        assert_eq!(paused["reason"], "paused");
    }
    #[test]
    fn host_observation_is_read_only_and_bound_to_original_chat() {
        let (dir, mut ws) = workspace();
        let sid = ws.config["searches"][0]["id"].clone();
        let thread = id();
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":sid,"preference":"recurring"}),
        )
        .unwrap();
        record_schedule(&mut ws.config,&json!({"search_id":sid,"automation_id":"linked","thread_id":thread,"status":"active","interval_minutes":60,"evidence":"Verified"}),ws.now).unwrap();
        let before = ws.config.clone();
        let directory = dir.path().join("automations");
        std::fs::create_dir_all(directory.join("linked")).unwrap();
        std::fs::write(directory.join("linked/automation.toml"),format!("id = \"linked\"\nkind = \"heartbeat\"\nstatus = \"PAUSED\"\nrrule = \"FREQ=HOURLY;INTERVAL=1\"\ntarget_thread_id = \"{thread}\"\ntimezone = \"Europe/London\"\n")).unwrap();
        ws.automations_directory = Some(directory.clone());
        assert_eq!(host_observations(&ws).unwrap()[s(&sid)]["status"], "paused");
        assert_eq!(ws.config, before);
        std::fs::write(
            directory.join("linked/automation.toml"),
            "id = \"linked\"\nkind = \"cron\"\n",
        )
        .unwrap();
        assert_eq!(
            host_observations(&ws).unwrap()[s(&sid)]["status"],
            "unavailable"
        );
    }
}

pub fn normalize_draft(input: &Value) -> Result<Value> {
    let mut draft = contracts::parse("draftInputSchema", input)?;
    draft["definition"] = validate_definition(&draft["definition"])?;
    validate_discovery(&draft["discovery"])?;
    let uncertain = strings(&draft["uncertain_fields"]);
    if uncertain.iter().collect::<HashSet<_>>().len() != uncertain.len() {
        return invalid("Uncertain fields must be unique");
    }
    for fid in uncertain {
        if !a(&draft["definition"]["fields"])
            .iter()
            .any(|f| s(&f["id"]) == fid)
            || draft["values"].get(&fid).is_some()
        {
            return invalid("Uncertainty must name an unanswered field");
        }
    }
    draft["values"] = clean_answers(&draft["definition"], &draft["values"], true)?;
    let markets = strings(&draft["marketplaces"]);
    if markets.iter().collect::<HashSet<_>>().len() != markets.len() {
        return invalid("Marketplaces must be unique");
    }
    Ok(draft)
}

pub fn validate_zone(zone: &Value) -> Result<()> {
    if let Some(zone) = zone.as_str()
        && zone.parse::<Tz>().is_err()
    {
        return invalid("Choose a valid time zone");
    }
    Ok(())
}
pub fn validate_quiet_hours(quiet: &Value) -> Result<Value> {
    let quiet = contracts::parse("quietHoursSchema", quiet)?;
    validate_zone(&quiet["timezone"])?;
    if quiet["start"] == quiet["end"] {
        return invalid("Quiet hours must have different start and end times");
    }
    Ok(quiet)
}
pub fn validate_cover(cover: &Value) -> Result<Value> {
    let cover = contracts::parse("searchCoverSchema", cover)?;
    if ["manufacturer", "area", "stock"].contains(&s(&cover["kind"]))
        && cover["source_url"].is_null()
    {
        return invalid("Include the image's source page");
    }
    if cover["kind"] == "generated" && cover["prompt"].is_null() {
        return invalid("Keep the image generation prompt");
    }
    if !cover["source_url"].is_null()
        && url::Url::parse(s(&cover["source_url"]))
            .ok()
            .is_none_or(|u| !["https", "http"].contains(&u.scheme()) || u.host_str().is_none())
    {
        return invalid("Include a valid image source page");
    }
    Ok(cover)
}
fn validate_discovery(discovery: &Value) -> Result<()> {
    if discovery.is_null() {
        return Ok(());
    }
    if discovery["scope"] == "exact" && s(&discovery["reference_model"]).trim().is_empty() {
        return invalid("Exact model searches need a model");
    }
    if ["constructor", "prototype"].contains(&s(&discovery["model_attribute"])) {
        return invalid("Choose a different field ID");
    }
    for source in a(&discovery["research"]["sources"]) {
        if url::Url::parse(s(&source["url"]))
            .ok()
            .is_none_or(|u| u.scheme() != "https" || u.host_str().is_none())
        {
            return invalid("Research sources need HTTPS URLs");
        }
    }
    for candidate in a(&discovery["research"]["candidates"]) {
        if candidate["capabilities"].as_object().is_some_and(|o| {
            o.keys()
                .any(|k| ["constructor", "prototype"].contains(&k.as_str()))
        }) {
            return invalid("Choose a different field ID");
        }
    }
    Ok(())
}

#[cfg(test)]
mod edge_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(root.path(), "live", "test-context").unwrap();
        ws.now = time("2026-10-06T09:00:00.000Z").unwrap();
        ws.automations_directory = None;
        ws.config["searches"] = contracts::data("example")["searches"].clone();
        ws.config["schedule"]["quiet_hours"] =
            json!({"enabled":true,"start":"22:00","end":"08:00","timezone":"UTC"});
        (root, ws)
    }
    #[test]
    fn distinct_model_aliases_preserve_category_discovery() {
        let search = json!({"id":"coffee","product":"espresso_machine","definition":{"title":"Coffee machine"},"discovery":{"reference_model":"Example Pro","model_attribute":"model","model_aliases":[{"canonical":"Example Pro","aliases":["ExamplePro","Example Pro"]}],"research":{"queries":["entry coffee machine"],"candidates":[{"model":"Other Model"}]}}});
        let feedback = vec![
            json!({"search_id":"coffee","scope":"search","rule":{"attribute":"model","operator":"neq","importance":"required","value":"ExamplePro"}}),
        ];
        let queries = query_plan(&search, &feedback);
        assert!(
            !queries
                .iter()
                .any(|q| q["purpose"] == "exact" || q["purpose"] == "alias")
        );
        assert_eq!(
            queries
                .iter()
                .filter(|q| q["purpose"] == "category")
                .count(),
            2
        );
        assert!(queries.iter().any(|q| q["text"] == "Other Model"));
    }
    #[test]
    fn unknown_or_lower_bound_seller_counts_remain_uncertain() {
        let now = time("2026-10-06T09:00:00.000Z").unwrap();
        let row = json!({"seller_listing_count":5,"seller_listing_count_precision":"lower_bound","seller_profile_url":"https://example.com/seller","seller_listings_checked_at":iso(now),"evidence":{"seller_listing_count":"Seller page displays at least 5 current listings"}});
        assert_eq!(seller_count_matches(&row, &json!(10), "lte", now), None);
        assert_eq!(
            seller_count_matches(&row, &json!(4), "lte", now),
            Some(false)
        );
        assert_eq!(
            seller_count_matches(&row, &json!(5), "gte", now),
            Some(true)
        );
        assert_eq!(
            seller_count_matches(&row, &json!({"min":1}), "range", now),
            Some(true)
        );
        assert_eq!(
            seller_count_matches(&row, &json!(10), "lte", now + 31 * 86_400_000),
            None
        );
        assert!(criterion_matches(&json!(1), &json!(1.0), "eq"));
    }
    #[test]
    fn continuous_dispatchers_require_exact_compatible_recurrences() {
        let (_root, mut ws) = fixture();
        let ids: Vec<_> = a(&ws.config["searches"])
            .iter()
            .map(|s| s["id"].clone())
            .collect();
        assert!(ids.len() >= 2);
        ws.config["schedule"]["quiet_hours"]["enabled"] = json!(false);
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":ids[0],"preference":"recurring","interval_minutes":60}),
        )
        .unwrap();
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":ids[1],"preference":"recurring","interval_minutes":90}),
        )
        .unwrap();
        let ids = ids.iter().map(|v| s(v).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            dispatcher_plan(&ws.config, &ids, &HashSet::new(), ws.now)["supported"],
            false
        );
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":ids[1],"preference":"recurring","interval_minutes":60}),
        )
        .unwrap();
        let plan = dispatcher_plan(&ws.config, &ids, &HashSet::new(), ws.now);
        assert_eq!(plan["supported"], true);
        assert_eq!(
            canonical_rule(s(&plan["rrule"])),
            canonical_rule("FREQ=MINUTELY;INTERVAL=60")
        );
        set_monitoring(&mut ws.config,&json!({"search_id":ids[0],"preference":"recurring","timing":{"mode":"daily","times":["09:10","10:40"]}})).unwrap();
        set_monitoring(&mut ws.config,&json!({"search_id":ids[1],"preference":"recurring","timing":{"mode":"daily","times":["11:20"]}})).unwrap();
        let plan = dispatcher_plan(&ws.config, &ids, &HashSet::new(), ws.now);
        assert_eq!(
            plan["rrule"],
            "FREQ=DAILY;BYHOUR=9,10,11;BYMINUTE=10,20,40;BYSECOND=0;BYSETPOS=1,6,8"
        );
    }
    #[test]
    fn timing_changes_defer_workers_before_import_parsing() {
        let (_root, mut ws) = fixture();
        let sid = ws.config["searches"][0]["id"].clone();
        set_monitoring(
            &mut ws.config,
            &json!({"search_id":sid,"preference":"recurring"}),
        )
        .unwrap();
        let run = run_action(
            &mut ws,
            "start",
            &json!({"search_id":sid,"request_id":id(),"trigger":"scheduled"}),
        )
        .unwrap();
        let worker = id();
        run_action(&mut ws,"claim",&json!({"run_id":run["id"],"expected_version":0,"worker_id":worker,"agent_id":"real-worker"})).unwrap();
        ws.config["schedule"]["quiet_hours"]["start"] = json!("08:30");
        let check = scheduled_import_check(&mut ws, s(&run["id"]))
            .unwrap()
            .unwrap();
        assert_eq!(check["reason"], "quiet_hours");
        let stopped = find_run(&ws, s(&run["id"])).unwrap().unwrap();
        assert_eq!(stopped["phase"], "deferred");
        assert!(stopped["interruption"].is_null());
        let resumed = command(
            &mut ws,
            "request_search_run",
            &json!({"request":{"search_id":sid,"request_id":id(),"trigger":"manual"}}),
        )
        .unwrap()["run"]
            .clone();
        assert_eq!(resumed["id"], run["id"]);
        assert_eq!(resumed["trigger"], "manual");
        assert!(resumed["worker"].is_null());
    }
    #[test]
    fn scheduled_duplicate_detection_uses_history_beyond_recent_limit() {
        let (_root, mut ws) = fixture();
        let sid = ws.config["searches"][0]["id"].clone();
        set_monitoring(&mut ws.config,&json!({"search_id":sid,"preference":"recurring","timing":{"mode":"daily","times":["09:00"]}})).unwrap();
        let run = run_action(
            &mut ws,
            "start",
            &json!({"search_id":sid,"request_id":id(),"trigger":"scheduled"}),
        )
        .unwrap();
        run_action(&mut ws, "cancel", &json!({"run_id":run["id"]})).unwrap();
        for _ in 0..55 {
            ws.now += 1000;
            let manual = run_action(
                &mut ws,
                "start",
                &json!({"search_id":sid,"request_id":id(),"trigger":"manual","resume":false}),
            )
            .unwrap();
            run_action(&mut ws, "cancel", &json!({"run_id":manual["id"]})).unwrap();
        }
        assert!(
            !runs(&ws, None)
                .unwrap()
                .iter()
                .any(|r| r["id"] == run["id"])
        );
        let check = command(&mut ws, "check_scheduled_search", &json!({"search_id":sid})).unwrap();
        assert_eq!(check["reason"], "already_started");
    }
    #[test]
    fn changed_brief_imports_and_stale_progress_are_rejected() {
        let (_root, mut ws) = fixture();
        let sid = ws.config["searches"][0]["id"].clone();
        let run = run_action(
            &mut ws,
            "start",
            &json!({"search_id":sid,"request_id":id()}),
        )
        .unwrap();
        let worker = id();
        let claimed=run_action(&mut ws,"claim",&json!({"run_id":run["id"],"expected_version":0,"worker_id":worker,"agent_id":"worker"})).unwrap();
        let stale=run_action(&mut ws,"update",&json!({"run_id":run["id"],"expected_version":0,"worker_id":worker,"next_step":"Progress"})).unwrap_err();
        assert!(
            a(stale.blockers.as_ref().unwrap())
                .iter()
                .any(|b| b["code"] == "revision_conflict")
        );
        assert_eq!(
            find_run(&ws, s(&run["id"])).unwrap().unwrap()["version"],
            claimed["version"]
        );
        ws.config["searches"][0]["name"] = json!("Different brief");
        assert!(
            record_import(&mut ws, s(&run["id"]), &[], Some(&worker))
                .unwrap_err()
                .message
                .contains("current search run and buying brief")
        );
    }
    #[test]
    fn refinements_uncertainty_and_discovery_refinements_validate() {
        let template = contracts::data("templates")[0].clone();
        let mut draft = json!({"name":"Fictional draft","definition":template,"values":{},"uncertain_fields":[]});
        assert!(normalize_draft(&draft).is_ok());
        let fid = s(&template["fields"][0]["id"]);
        draft["uncertain_fields"] = json!([fid, fid]);
        assert!(normalize_draft(&draft).is_err());
        draft["uncertain_fields"] = json!(["unknown_field"]);
        assert!(normalize_draft(&draft).is_err());
        draft["uncertain_fields"] = json!([]);
        draft["discovery"] = json!({"scope":"exact"});
        assert!(normalize_draft(&draft).is_err());
        assert!(
            validate_quiet_hours(
                &json!({"enabled":true,"start":"08:00","end":"08:00","timezone":"UTC"})
            )
            .is_err()
        );
        assert!(
            validate_quiet_hours(
                &json!({"enabled":true,"start":"22:00","end":"08:00","timezone":"fictional/town"})
            )
            .is_err()
        );
    }
}

/// Prepare exactly one visible unanswered question. The transport performs native elicitation.
pub fn prepare_interview(ws: &Workspace, args: &Value) -> Result<Value> {
    let object = args
        .as_object()
        .ok_or_else(|| Error::validation("Interview arguments must be an object"))?;
    if object
        .keys()
        .any(|k| !["mode", "draft_id", "stage", "refinement_fields"].contains(&k.as_str()))
    {
        return invalid("Unknown interview argument");
    }
    let draft_id = args["draft_id"]
        .as_str()
        .ok_or_else(|| Error::validation("Choose an unfinished search"))?;
    let stage = args["stage"].as_str().unwrap_or("setup");
    if !["setup", "refinement"].contains(&stage) {
        return invalid("Choose setup or refinement");
    }
    let draft = a(&ws.config["drafts"])
        .iter()
        .find(|d| s(&d["id"]) == draft_id)
        .ok_or_else(|| Error::validation("That unfinished search no longer exists"))?;
    let refinements = if args.get("refinement_fields").is_some() {
        if !args["refinement_fields"].is_array()
            || a(&args["refinement_fields"]).is_empty()
            || a(&args["refinement_fields"]).len() > 10
            || a(&args["refinement_fields"]).iter().any(|v| !v.is_string())
        {
            return invalid("Choose one to ten refinement fields");
        }
        if stage != "refinement" {
            return invalid("Select refinement fields only during refinement");
        }
        let ids = strings(&args["refinement_fields"]);
        for id in &ids {
            if a(&draft["definition"]["fields"])
                .iter()
                .find(|f| s(&f["id"]) == id)
                .is_none_or(|f| b(&f["required"]) || f["question_stage"] == "setup")
            {
                return invalid(format!("That field is not an optional refinement: {id}"));
            }
        }
        Some(ids)
    } else {
        None
    };
    let uncertain = strings(&draft["uncertain_fields"]);
    let field = interview_fields(
        &draft["definition"],
        &draft["values"],
        stage,
        refinements.as_deref(),
        &uncertain,
    )
    .into_iter()
    .next()
    .unwrap_or(Value::Null);
    let status = if a(&draft["definition"]["fields"])
        .iter()
        .any(|f| b(&f["required"]) && uncertain.iter().any(|id| id == s(&f["id"])))
    {
        "needs_guidance"
    } else {
        "ready"
    };
    let revisions = ws.revisions()?;
    Ok(
        json!({"draft":draft,"field":field,"stage":stage,"refinement_fields":refinements,"status":status,"expected_entity_revision":revisions["drafts"].get(draft_id).unwrap_or(&revisions["absent"])}),
    )
}
/// Apply one elicitation reply without writing; the caller saves returned draft with the prepared revision.
pub fn apply_interview(
    prepared: &Value,
    action: &str,
    content: &Value,
    custom: bool,
) -> Result<Value> {
    let draft = &prepared["draft"];
    let field = &prepared["field"];
    let stage = s(&prepared["stage"]);
    let mut saved = draft.clone();
    let mut status = s(&prepared["status"]).to_owned();
    let mut should_save = false;
    if !field.is_null() {
        if action != "accept" {
            status = match action {
                "cancel" => "cancelled",
                "unsupported" => "unsupported",
                _ => "declined",
            }
            .into()
        } else {
            let fid = s(&field["id"]);
            let reply = &content[fid];
            let unsure = !custom
                && b(&field["allow_unsure"])
                && (reply == "__not_sure__" || a(reply).iter().any(|v| v == "__not_sure__"));
            if unsure && reply.is_array() && a(reply).len() != 1 {
                return invalid("Choose Not sure on its own, or select the options you want");
            }
            let mut values = draft["values"].clone();
            if !unsure {
                values[fid] = native_answer(field, content, custom)?
            }
            let mut uncertain = strings(&draft["uncertain_fields"]);
            if unsure {
                if !uncertain.iter().any(|id| id == fid) {
                    uncertain.push(fid.into())
                }
            } else {
                uncertain.retain(|id| id != fid)
            }
            saved["values"] = clean_answers(&draft["definition"], &values, true)?;
            saved["uncertain_fields"] = json!(uncertain);
            should_save = true;
            let refinements = prepared["refinement_fields"]
                .is_array()
                .then(|| strings(&prepared["refinement_fields"]));
            status = if unsure
                || a(&draft["definition"]["fields"])
                    .iter()
                    .any(|f| b(&f["required"]) && uncertain.iter().any(|id| id == s(&f["id"])))
            {
                "needs_guidance"
            } else if !interview_fields(
                &draft["definition"],
                &values,
                stage,
                refinements.as_deref(),
                &uncertain,
            )
            .is_empty()
            {
                "answered"
            } else {
                "ready"
            }
            .into();
        }
    }
    let remaining = interview_fields(
        &draft["definition"],
        &saved["values"],
        "refinement",
        None,
        &[],
    )
    .into_iter()
    .filter(|f| !b(&f["required"]) && f["question_stage"] != "setup")
    .map(|f| json!({"id":f["id"],"label":f["label"]}))
    .collect::<Vec<_>>();
    let mut interview = json!({"status":status,"stage":stage,"draft_id":draft["id"],"remaining_refinements":remaining});
    if !field.is_null() {
        interview["question"] = field.clone()
    }
    Ok(json!({"draft":if should_save{saved}else{Value::Null},"interview":interview}))
}
pub fn excluded_models(search: &Value, feedback: &[Value]) -> Vec<String> {
    let model = search["discovery"]["model_attribute"]
        .as_str()
        .unwrap_or("model");
    let mut out = Vec::new();
    for e in feedback {
        if applies_to_search(e, search)
            && e["rule"]["attribute"] == model
            && e["rule"]["operator"] == "neq"
            && e["rule"]["importance"] == "required"
            && let Some(value) = e["rule"]["value"].as_str()
            && !out.iter().any(|s| s == value)
        {
            out.push(value.to_owned())
        }
    }
    out
}

#[cfg(test)]
mod interview_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(dir.path(), "live", "interview-test").unwrap();
        ws.automations_directory = None;
        let mut draft=normalize_draft(&json!({"name":"Camera","definition":{"schema_version":1,"version":1,"category":"camera","title":"Camera","description":"A fictional interview","price":{"currency":"GBP","period":"once"},"comparison_attributes":["model"],"fields":[{"id":"budget","label":"Budget","type":"integer","required":true,"display_divisor":100,"minimum":1,"allow_unsure":true,"match":{"attribute":"price_minor","operator":"lte"}},{"id":"colors","label":"Colors","type":"multiple_choice","allow_unsure":true,"options":[{"value":"black","label":"Black"},{"value":"silver","label":"Silver"}]}]},"values":{}})).unwrap();
        draft["id"] = json!("draft-camera");
        ws.config["drafts"] = json!([draft]);
        ws.save_config().unwrap();
        (dir, ws)
    }
    #[test]
    fn native_interview_applies_one_question_and_preserves_uncertainty() {
        let (_dir, mut ws) = fixture();
        let prepared = prepare_interview(&ws, &json!({"draft_id":"draft-camera"})).unwrap();
        assert_eq!(prepared["field"]["id"], "budget");
        let unsupported = apply_interview(&prepared, "unsupported", &json!({}), false).unwrap();
        assert_eq!(unsupported["interview"]["status"], "unsupported");
        assert!(unsupported["draft"].is_null());
        let declined = apply_interview(&prepared, "cancel", &json!({}), false).unwrap();
        assert_eq!(declined["interview"]["status"], "cancelled");
        let uncertain = apply_interview(
            &prepared,
            "accept",
            &json!({"budget":"__not_sure__"}),
            false,
        )
        .unwrap();
        assert_eq!(uncertain["interview"]["status"], "needs_guidance");
        assert_eq!(uncertain["draft"]["uncertain_fields"], json!(["budget"]));
        assert!(uncertain["draft"]["values"].get("budget").is_none());
        ws.config["drafts"][0] = uncertain["draft"].clone();
        let next = prepare_interview(&ws, &json!({"draft_id":"draft-camera"})).unwrap();
        assert!(next["field"].is_null());
        assert_eq!(next["status"], "needs_guidance");
        let answer = apply_interview(&prepared, "accept", &json!({"budget":145.50}), true).unwrap();
        assert_eq!(answer["draft"]["values"]["budget"], 14550.0);
        assert_eq!(answer["interview"]["status"], "ready");
        assert_eq!(
            answer["interview"]["remaining_refinements"],
            json!([{"id":"colors","label":"Colors"}])
        );
    }
    #[test]
    fn optional_refinement_selection_and_unsure_choice_are_validated() {
        let (_dir, mut ws) = fixture();
        assert!(
            prepare_interview(
                &ws,
                &json!({"draft_id":"draft-camera","refinement_fields":["colors"]})
            )
            .is_err()
        );
        assert!(prepare_interview(&ws,&json!({"draft_id":"draft-camera","stage":"refinement","refinement_fields":["budget"]})).is_err());
        ws.config["drafts"][0]["values"] = json!({"budget":10000});
        let p = prepare_interview(
            &ws,
            &json!({"draft_id":"draft-camera","stage":"refinement","refinement_fields":["colors"]}),
        )
        .unwrap();
        assert_eq!(p["field"]["id"], "colors");
        assert!(
            apply_interview(
                &p,
                "accept",
                &json!({"colors":["black","__not_sure__"]}),
                false
            )
            .is_err()
        );
        let ready = apply_interview(&p, "accept", &json!({"colors":["black"]}), false).unwrap();
        assert_eq!(ready["interview"]["status"], "ready");
        assert_eq!(ready["draft"]["values"]["colors"], json!(["black"]));
        let revision = p["expected_entity_revision"].clone();
        ws.config["drafts"][0]["name"] = json!("Another name");
        ws.save_config().unwrap();
        let refreshed = prepare_interview(
            &ws,
            &json!({"draft_id":"draft-camera","stage":"refinement"}),
        )
        .unwrap();
        assert_ne!(revision, refreshed["expected_entity_revision"]);
    }
}

pub fn empty_workflow(now: i64) -> Value {
    workflow(None, &json!({"now":now}))
}

pub fn is_bundled_cover(media_id: &str) -> bool {
    let sources: Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/data/search-cover-sources.json"
    ))
    .expect("bundled cover index");
    let canonical = sources["media_id_aliases"][media_id]
        .as_str()
        .unwrap_or(media_id);
    a(contracts::data("bundledSearchCovers"))
        .iter()
        .any(|entry| s(&entry["image"]["media_id"]) == canonical)
}
pub fn bundled_cover_for(search: &Value) -> Option<Value> {
    let product = s(&search["product"]).trim().to_lowercase();
    let (category, preset) = if product == "rental" {
        let structured = search["values"]["country"].as_str();
        let name = structured
            .unwrap_or_else(|| {
                s(&search["values"]["area"])
                    .split(',')
                    .next_back()
                    .unwrap_or("")
            })
            .trim()
            .to_lowercase();
        let name = name.replace('.', "");
        let preset = match name.as_str() {
            "us" | "usa" | "united states" | "united states of america" => "us",
            "ca" if structured.is_some() => "ca",
            "canada" => "ca",
            "au" | "australia" => "au",
            "fr" | "france" => "fr",
            "de" if structured.is_some() => "de",
            "germany" | "deutschland" => "de",
            "gb" | "uk" | "united kingdom" | "great britain" => "gb",
            _ => "neutral",
        };
        ("rental", preset)
    } else if let Some(preset) = match product.as_str() {
        "sofa" | "couch" => Some("sofa"),
        "dining_set" | "dining_table" => Some("dining_set"),
        "wardrobe" => Some("wardrobe"),
        "chest_of_drawers" => Some("chest_of_drawers"),
        "sideboard" => Some("sideboard"),
        "bicycle" => Some("bicycle"),
        "garden_furniture" | "patio_furniture" => Some("garden_furniture"),
        "pram" | "pushchair" | "stroller" => Some("pram"),
        _ => None,
    } {
        ("", preset)
    } else {
        fn kind(value: &Value) -> Option<&'static str> {
            let value = if a(value).len() == 1 {
                &a(value)[0]
            } else {
                value
            };
            match s(value).trim().to_lowercase().as_str() {
                "sedan" | "saloon" => Some("sedan"),
                "4x4" | "suv" => Some("4x4"),
                "motorbike" | "motorcycle" => Some("motorbike"),
                "boat" => Some("boat"),
                _ => None,
            }
        }
        let preset = kind(&json!(product)).or_else(|| {
            if [
                "vehicle",
                "vehicles",
                "car",
                "cars",
                "motorbike",
                "motorcycle",
                "boat",
            ]
            .contains(&product.as_str())
            {
                kind(&search["values"]["body_type"])
                    .or_else(|| kind(&search["values"]["vehicle_type"]))
            } else {
                None
            }
        })?;
        ("vehicle", preset)
    };
    a(contracts::data("bundledSearchCovers"))
        .iter()
        .find(|entry| {
            (category.is_empty() || entry["category"] == category) && entry["preset"] == preset
        })
        .map(|entry| entry["image"].clone())
}
