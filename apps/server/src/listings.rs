//! Listing evidence, historical observations, independent reading state, and valuation.
use crate::{
    contracts,
    error::{Error, Result},
    storage::Workspace,
    util::{canonical, hash, id, iso, time},
};
use chrono::{Datelike, TimeZone, Utc};
use regex::Regex;
use rusqlite::{OptionalExtension, ToSql, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use url::Url;
const DAY: i64 = 86_400_000;
pub const ACTIONS: &[&str] = &[
    "set_listing_seen",
    "attach_listing_media",
    "record_journey_check",
    "load_sample_workspace",
    "import_listing_observations",
];
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn t(v: &Value) -> i64 {
    time(s(v)).unwrap_or(i64::MIN / 4)
}
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
fn truth(v: &Value) -> bool {
    !v.is_null() && v != false && v != "" && v != 0
}
fn default(v: &Value, fallback: Value) -> Value {
    if v.is_null() { fallback } else { v.clone() }
}
fn remove(v: &mut Value, key: &str) {
    if let Some(o) = v.as_object_mut() {
        o.remove(key);
    }
}
fn fresh(v: &Value, now: i64, days: i64) -> bool {
    let age = now - t(v);
    age >= 0 && age <= days * DAY
}
fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(Error::validation(message))
}
fn median(mut values: Vec<f64>) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(f64::total_cmp);
    let m = values.len() / 2;
    json!(if values.len() % 2 == 1 {
        values[m]
    } else {
        (values[m - 1] + values[m]) / 2.
    })
}
fn round(value: f64, digits: i32) -> f64 {
    (value * 10f64.powi(digits)).round() / 10f64.powi(digits)
}
fn terminal(value: &str) -> bool {
    [
        "sold",
        "out_of_stock",
        "ended_unsold",
        "expired",
        "removed",
        "unknown_unavailable",
    ]
    .contains(&value)
}
fn documents(ws: &Workspace, sql: &str, params: &[&dyn ToSql]) -> Result<Vec<Value>> {
    let mut stmt = ws.db.prepare(sql)?;
    let rows = stmt.query_map(params, |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::from_str(&row?)?);
    }
    Ok(out)
}
fn policy(config: &Value, name: &str, defaults: Value) -> Value {
    let mut p = defaults;
    if let Some(o) = config[name].as_object() {
        for (k, v) in o {
            p[k] = v.clone();
        }
    }
    p
}
fn quality_policy(config: &Value) -> Value {
    policy(
        config,
        "quality_policy",
        json!({"minimum_outlier_peers":20,"outlier_z":3.5,"max_check_age_hours":72}),
    )
}
fn credibility_policy(config: &Value) -> Value {
    policy(
        config,
        "credibility_policy",
        json!({"recent_account_months":24,"minimum_peer_listings":10,"stddev_threshold":3,"zero_variance_discount_fraction":0.5,"established_account_minimum_friends":100}),
    )
}
pub fn source_url(source: &str, value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let hosts: &[&str] = match source {
        "facebook_marketplace" => &["facebook.com"],
        "ebay" => &[
            "ebay.com",
            "ebay.co.uk",
            "ebay.de",
            "ebay.fr",
            "ebay.ca",
            "ebay.com.au",
        ],
        "vinted" => &["vinted.co.uk", "vinted.com", "vinted.fr", "vinted.de"],
        "gumtree" => &["gumtree.com"],
        "craigslist" => &["craigslist.org"],
        "autotrader" => &["autotrader.co.uk"],
        _ => &[],
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && hosts.iter().any(|h| {
            url.host_str()
                .is_some_and(|host| host == *h || host.ends_with(&format!(".{h}")))
        })
}
fn item_url(source: &str, listing_id: &str, value: &str, demo: bool) -> Result<String> {
    let url = Url::parse(value).map_err(|_| Error::validation("Invalid item URL"))?;
    let path = url.path().trim_end_matches('/');
    let pattern = match source {
        "facebook_marketplace" => r"^/marketplace/item/(\d+)$",
        "ebay" => r"^/itm/(?:[^/]+/)?(\d+)$",
        "vinted" => r"^/items/(\d+)(?:-[^/]+)?$",
        "gumtree" => r"^/p/(?:[^/]+/)+(\d+)$",
        "craigslist" => r"^/(?:[^/]+/)+(\d+)\.html$",
        "autotrader" => r"^/car-details/(\d+)$",
        _ => return fail("Unsupported marketplace"),
    };
    let valid = if demo {
        url.scheme() == "https"
            && url.host_str() == Some("example.invalid")
            && url.username().is_empty()
            && url.password().is_none()
    } else {
        !listing_id.is_empty()
            && listing_id.bytes().all(|c| c.is_ascii_digit())
            && source_url(source, value)
            && Regex::new(pattern)
                .unwrap()
                .captures(path)
                .is_some_and(|c| c.get(1).is_some_and(|m| m.as_str() == listing_id))
    };
    if !valid {
        return fail(
            "Live item URL must match its source and listing ID; examples require example.invalid",
        );
    }
    Ok(format!(
        "{}{}{}",
        url.origin().ascii_serialization(),
        path,
        if source == "facebook_marketplace" {
            "/"
        } else {
            ""
        }
    ))
}
pub fn normalize_observations(input: &Value, demo: bool, now: i64) -> Result<Vec<Value>> {
    let inputs = input
        .as_array()
        .ok_or_else(|| Error::validation("Observations must be an array"))?;
    let mut rows = Vec::<Value>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for input in inputs {
        let row = normalize(input, demo, now)?;
        let key = s(&row["key"]).to_owned();
        if let Some(index) = indexes.get(&key) {
            if rows[*index] != row {
                return fail(format!(
                    "Conflicting duplicate observation for {}",
                    s(&row["listing_id"])
                ));
            }
        } else {
            indexes.insert(key, rows.len());
            rows.push(row);
        }
    }
    Ok(rows)
}
pub fn normalize(input: &Value, demo: bool, now: i64) -> Result<Value> {
    if !input.is_object() {
        return fail("Observation must be an object");
    }
    let mut row = input.clone();
    let source = s(&row["source"]).to_owned();
    let listing_id = s(&row["listing_id"]).trim().to_owned();
    if listing_id.is_empty() {
        return fail("Listing ID is required");
    }
    row["url"] = json!(item_url(&source, &listing_id, s(&row["url"]), demo)?);
    let prefix = if demo { "synthetic" } else { "manual" };
    if row["provenance"] != prefix {
        return fail(format!("This run requires {prefix} observations"));
    }
    if row["collection_method"] == "user_requested_browser" && !truth(&row["observed_at"]) {
        return fail("Browser observations need a timezone-aware observed_at");
    }
    let observed = if truth(&row["observed_at"]) {
        time(s(&row["observed_at"]))?
    } else {
        now
    };
    if observed > now + 300000 {
        return fail("Observation time cannot be in the future");
    }
    row["key"] = json!(if source == "facebook_marketplace" {
        format!("{prefix}:{listing_id}")
    } else {
        format!("{prefix}:{source}:{listing_id}")
    });
    row["title"] = default(&row["title"], json!(format!("Listing {listing_id}")));
    row["product"] = default(&row["product"], json!("unknown"));
    row["price_minor"] = default(&row["price_minor"], Value::Null);
    row["observed_at"] = json!(iso(observed));
    row["observation_time_precision"] = json!(if truth(&input["observed_at"]) {
        "recorded"
    } else {
        "import_time"
    });
    row["check_outcome"] = default(&row["check_outcome"], json!("success"));
    row["availability"] = if truth(&row["availability"]) {
        row["availability"].clone()
    } else {
        json!("unknown")
    };
    if ![
        "success",
        "login_required",
        "forbidden",
        "rate_limited",
        "network_error",
        "parser_error",
        "not_found",
        "not_inspected",
    ]
    .contains(&s(&row["check_outcome"]))
    {
        return fail("Unsupported listing check outcome");
    }
    if !terminal(s(&row["availability"]))
        && !["active", "reserved", "unknown"].contains(&s(&row["availability"]))
    {
        return fail("Unsupported availability state");
    }
    for key in [
        "availability_text",
        "discovery_surface",
        "country",
        "category_id",
        "category_path",
        "bundle_type",
        "seller_type",
        "seller_id",
        "location_precision",
        "publication_text",
        "publication_timezone",
        "publication_kind",
    ] {
        if !row[key].is_null() && row[key].as_str().is_none_or(|v| v.chars().count() > 2000) {
            return fail(format!("Invalid {key}"));
        }
    }
    if row["publication"].is_object() {
        let p = &mut row["publication"];
        let bounds = truth(&p["earliest_at"]) || truth(&p["latest_at"]);
        if bounds {
            if !truth(&p["earliest_at"])
                || !truth(&p["latest_at"])
                || !["exact", "bounded"].contains(&s(&p["precision"]))
                || !truth(&p["evidence"])
            {
                return fail("Publication bounds need both timestamps and supporting evidence");
            }
            let start = time(s(&p["earliest_at"]))?;
            let end = time(s(&p["latest_at"]))?;
            if start > end || end > observed || (p["precision"] == "exact" && start != end) {
                return fail(
                    "Publication bounds conflict with their precision or observation time",
                );
            }
            p["earliest_at"] = json!(iso(start));
            p["latest_at"] = json!(iso(end));
        } else if ["exact", "bounded"].contains(&s(&p["precision"])) {
            return fail("Exact or bounded publication evidence needs timestamps");
        }
    }
    if !row["cash_price_minor"].is_null() {
        if !truth(&row["evidence"]["cash_price_minor"]) {
            return fail(
                "An explicit cash price needs integer minor units and cash-price evidence",
            );
        }
        row["price_minor"] = row["cash_price_minor"].clone();
        row["price_kind"] = json!("asking");
        if row["product"] != "rental" {
            row["price_period"] = json!("once");
        }
    } else if row["product"] != "rental"
        && !row["price_period"].is_null()
        && row["price_period"] != "once"
    {
        row["price_kind"] = json!("finance");
    }
    if !row["price_minor"].is_null() && row["price_kind"].is_null() {
        return fail(
            "A numeric price needs an explicit price_kind; use asking for a full outright price",
        );
    }
    if row["price_kind"] != "asking" {
        row["price_minor"] = Value::Null;
    }
    if row["price_minor"].is_null() {
        remove(&mut row, "displayed_previous_price_minor");
    }
    for key in [
        "finance_price_minor",
        "finance_monthly_minor",
        "monthly_payment_minor",
        "finance",
        "finance_terms",
    ] {
        remove(&mut row, key);
    }
    row["total_cash_cost_minor"] = Value::Null;
    if row["costs_complete"] == true && !row["price_minor"].is_null() {
        let mut total = 0i64;
        for key in [
            "price_minor",
            "shipping_minor",
            "buyer_fee_minor",
            "tax_minor",
        ] {
            let amount = row[key].as_i64().filter(|x| *x >= 0).ok_or_else(|| {
                Error::validation("Complete costs need nonnegative integer amounts")
            })?;
            total = total
                .checked_add(amount)
                .ok_or_else(|| Error::validation("Total price is too large"))?;
        }
        row["total_cash_cost_minor"] = json!(total);
    }
    for key in ["field_evidence", "logistics", "seller", "interest", "terms"] {
        if !row[key].is_null() && !row[key].is_object() {
            return fail(format!("{key} must be an object"));
        }
    }
    row = contracts::parse("listingObservationSchema", &row)?;
    for key in ["price_minor", "ram_gb", "ssd_gb", "drive_minutes"] {
        if !row[key].is_null() && row[key].as_i64().is_none_or(|v| v < 0) {
            return fail(format!("{key} needs a nonnegative integer"));
        }
    }
    if !row["currency"].is_null()
        && !Regex::new(r"^[A-Z]{3}$")
            .unwrap()
            .is_match(s(&row["currency"]))
    {
        return fail("Invalid currency");
    }
    for metric in ["friend", "listing"] {
        if row[format!("seller_{metric}_count")].is_null()
            != row[format!("seller_{metric}_count_precision")].is_null()
        {
            return fail(format!(
                "{metric} count needs its precision; unknown counts need null precision"
            ));
        }
    }
    for key in [
        "seller_profile_checked_at",
        "seller_listings_checked_at",
        "seller_metadata_checked_at",
    ] {
        if !row[key].is_null() {
            time(s(&row[key]))?;
        }
    }
    if truth(&row["seller_account_joined_at"]) {
        let joined = s(&row["seller_account_joined_at"]);
        if !Regex::new(r"^\d{4}(?:-\d{2}-\d{2})?$")
            .unwrap()
            .is_match(joined)
        {
            return fail("Seller join date must be YYYY or YYYY-MM-DD, preserving its precision");
        }
        let date = format!(
            "{}T00:00:00Z",
            if joined.len() == 4 {
                format!("{joined}-01-01")
            } else {
                joined.to_owned()
            }
        );
        if time(&date)? > crate::util::now() {
            return fail("Invalid seller join date");
        }
    }
    for (media, review, total) in [
        ("photos", "image_review", "total_images"),
        ("videos", "video_review", "total_videos"),
    ] {
        let positions: Vec<i64> = arr(&row[media])
            .iter()
            .map(|v| v["position"].as_i64().unwrap_or(0))
            .collect();
        if positions.iter().collect::<HashSet<_>>().len() != positions.len() {
            return fail(format!(
                "Each {media} entry needs a unique positive position"
            ));
        }
        if row[review].is_object() {
            let r = &row[review];
            let reviewed = arr(&r["reviewed_positions"]);
            let limit = r[total].as_i64().unwrap_or(0);
            let unique: BTreeSet<_> = reviewed.iter().map(|p| p.as_i64().unwrap_or(0)).collect();
            if unique.len() != reviewed.len()
                || unique.iter().any(|p| *p > limit)
                || positions.iter().any(|p| *p > limit)
                || (r["complete"] == true && reviewed.len() != limit as usize)
                || (media == "videos"
                    && !row["media_capture"]["expected_videos"].is_null()
                    && r[total] != row["media_capture"]["expected_videos"])
            {
                return fail(format!(
                    "A complete {review} must cover every item exactly once"
                ));
            }
        }
    }
    if row["media_capture"]["status"] == "complete" {
        for (key, total) in [("photos", "expected_photos"), ("videos", "expected_videos")] {
            if row["media_capture"][total].as_u64() != Some(arr(&row[key]).len() as u64) {
                return fail(
                    "Complete media capture needs the observed totals and every saved image and video",
                );
            }
        }
    }
    if let Some(attributes) = row["attributes"].as_object() {
        let re = Regex::new(r"^[a-z][a-z0-9_]{0,63}$").unwrap();
        if attributes.len() > 60
            || attributes
                .keys()
                .any(|k| !re.is_match(k) || ["constructor", "prototype"].contains(&k.as_str()))
        {
            return fail("Listing attributes need bounded, typed values");
        }
        if attributes
            .iter()
            .any(|(k, v)| !row[k].is_null() && row[k] != *v)
        {
            return fail("Listing attributes conflict with top-level evidence");
        }
    }
    for key in ["seller_profile_url", "seller_public_profile_url"] {
        if truth(&row[key]) {
            let url =
                Url::parse(s(&row[key])).map_err(|_| Error::validation("Invalid seller URL"))?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || if demo {
                    url.host_str() != Some("example.invalid")
                } else {
                    !source_url(&source, s(&row[key]))
                }
            {
                return fail("Seller links must use the same permitted source");
            }
        }
    }
    if row["seller_inventory_review"].is_object() {
        let review = row["seller_inventory_review"].clone();
        if review["source_url"] != row["seller_profile_url"] || review["category"] != row["product"]
        {
            return fail(
                "Seller inventory review must use this seller profile and listing category",
            );
        }
        if time(s(&review["checked_at"]))? > observed {
            return fail("Seller inventory review cannot be later than the listing observation");
        }
        let mut ids = HashSet::new();
        for (index, item) in arr(&review["listings"]).iter().enumerate() {
            let item_id = s(&item["listing_id"]);
            if !ids.insert(item_id) {
                return fail("Seller inventory items must have distinct listing IDs");
            }
            row["seller_inventory_review"]["listings"][index]["url"] =
                json!(item_url(&source, item_id, s(&item["url"]), demo)?);
        }
        if row["seller_listing_count_precision"] == "exact"
            && row["seller_listing_count"]
                .as_u64()
                .is_some_and(|n| ids.len() > n as usize)
        {
            return fail(
                "The inspected inventory cannot exceed the seller’s exact total listing count",
            );
        }
    }
    for cost in arr(&row["setup_costs"]) {
        if cost["basis"] == "unknown" {
            if !cost["price_minor"].is_null() {
                return fail("Unknown additional costs cannot have an amount");
            }
        } else if cost["price_minor"].is_null() || cost["evidence"].is_null() {
            return fail("Known additional costs need an amount and supporting source");
        }
    }
    for check in arr(&row["verification_checks"]) {
        if ["confirmed", "missing"].contains(&s(&check["state"])) && check["evidence"].is_null() {
            return fail("Confirmed or missing details need evidence");
        }
    }
    if canonical(&row).len() > 50000 {
        return fail("Observation is too large");
    }
    Ok(row)
}
fn normalize_coverage(input: &Value, now: i64, searches: &Value) -> Result<Vec<Value>> {
    if input.is_null() {
        return Ok(vec![]);
    }
    let input = input
        .as_array()
        .filter(|v| v.len() <= 50)
        .ok_or_else(|| Error::validation("Search coverage must contain at most fifty checks"))?;
    input.iter().map(|value|{let mut run=contracts::parse("searchCoverageSchema",value)?;let search=arr(searches).iter().find(|s|s["id"]==run["search_id"]).ok_or_else(||Error::validation("Search coverage needs a saved search"))?;
        let start=time(s(&run["started_at"]))?;let end=time(s(&run["finished_at"]))?;if start>end||end>now+300000{return fail("Invalid search coverage times");}
if !run["result_count"].is_null()&&n(&run["inspected_count"])>n(&run["result_count"]){return fail("Inspected count exceeds search result count");}
if canonical(&run).len()>50000{return fail("Search coverage is too large");}
        run["started_at"]=json!(iso(start));run["finished_at"]=json!(iso(end));run["search_revision"]=json!(hash(search));run["scope_key"]=json!(hash(&json!({"source":run["source"],"search_id":run["search_id"],"query":run["query"],"filters":run["filters"],"sort":run["sort"],"search":search})));Ok(run)
    }).collect()
}
fn fingerprint(row: &Value) -> String {
    let mut v = json!({});
    for key in [
        "title",
        "description",
        "attributes",
        "condition",
        "item_state",
        "functional",
        "bundle_type",
        "photos",
        "videos",
    ] {
        v[key] = row[key].clone();
    }
    hash(&v)
}
fn publication_bounds(row: &Value) -> Option<(i64, i64)> {
    let p = &row["publication"];
    if p["kind"] == "published" && truth(&p["earliest_at"]) && truth(&p["latest_at"]) {
        Some((t(&p["earliest_at"]), t(&p["latest_at"])))
    } else {
        None
    }
}
fn merge_media(old: &Value, new: &Value, replace: bool, refresh: bool) -> Value {
    if new.is_null() {
        return old.clone();
    }
    if replace {
        return new.clone();
    }
    let mut combined = arr(old).to_vec();
    for item in arr(new) {
        if let Some(index) = combined
            .iter()
            .position(|s| s["media_id"] == item["media_id"])
        {
            if refresh {
                let pos = combined[index]["position"].clone();
                combined[index] = item.clone();
                combined[index]["position"] = pos;
            }
            continue;
        }
        let mut item = item.clone();
        if combined.iter().any(|s| s["position"] == item["position"]) {
            item["position"] = json!(
                combined
                    .iter()
                    .map(|s| s["position"].as_i64().unwrap_or(0))
                    .max()
                    .unwrap_or(0)
                    + 1
            );
        }
        combined.push(item);
    }
    json!(combined)
}
pub fn rebuild_history(key: &str, history: &[Value]) -> Option<(Value, Vec<Value>)> {
    let mut current = Value::Null;
    let mut prior = Value::Null;
    let mut first_active = Value::Null;
    let mut last_active = Value::Null;
    let mut conflict = false;
    let mut successes = Vec::<Value>::new();
    let mut seen = HashMap::<String, String>::new();
    let mut events = Vec::new();
    for row in history {
        if row["check_outcome"] != "success" {
            events.push(json!({"kind":"check_failed","observed_at":row["observed_at"],"outcome":row["check_outcome"]}));
            if current.is_null() {
                current = row.clone();
                current["availability"] = json!("unknown");
                current["price_minor"] = Value::Null;
            }
            current["check_outcome"] = row["check_outcome"].clone();
            current["last_attempted_at"] = row["observed_at"].clone();
            continue;
        }
        successes.push(row["observed_at"].clone());
        let payload = format!(
            "{}{}{}",
            fingerprint(row),
            row["price_minor"],
            s(&row["availability"])
        );
        if seen
            .get(s(&row["observed_at"]))
            .is_some_and(|p| p != &payload)
        {
            conflict = true;
        }
        seen.insert(s(&row["observed_at"]).into(), payload);
        if prior.is_null() {
            events.push(json!({"kind":"first_observed_at","observed_at":row["observed_at"]}));
        } else {
            if default(&row["price_kind"], json!("asking")) == "asking"
                && default(&prior["price_kind"], json!("asking")) == "asking"
                && !row["price_minor"].is_null()
                && !prior["price_minor"].is_null()
                && row["currency"] == prior["currency"]
                && default(&row["price_period"], json!("once"))
                    == default(&prior["price_period"], json!("once"))
                && row["price_minor"] != prior["price_minor"]
            {
                events.push(json!({"kind":"price_changed","observed_at":row["observed_at"],"previous_price_minor":prior["price_minor"],"price_minor":row["price_minor"],"currency":row["currency"],"earliest_at":prior["observed_at"],"latest_at":row["observed_at"]}));
            }
            if row["availability"] != prior["availability"] {
                events.push(json!({"kind":"status_changed","observed_at":row["observed_at"],"previous_state":default(&prior["availability"],json!("unknown")),"state":default(&row["availability"],json!("unknown")),"earliest_at":prior["observed_at"],"latest_at":row["observed_at"]}));
            }
            if fingerprint(row) != fingerprint(&prior) {
                events.push(json!({"kind":"content_changed","observed_at":row["observed_at"]}));
            }
        }
        for relation in arr(&row["relationships"]) {
            if !arr(&prior["relationships"]).contains(relation) {
                events.push(json!({"kind":"relationship_observed","observed_at":row["observed_at"],"relationship":relation}));
            }
        }
        if row["availability"] == "active" {
            if first_active.is_null() {
                first_active = row["observed_at"].clone();
            }
            last_active = row["observed_at"].clone();
        }
        let original = current["publication"].clone();
        let photos = merge_media(
            &current["photos"],
            &row["photos"],
            row["media_capture"]["status"] == "complete",
            true,
        );
        let videos = merge_media(
            &current["videos"],
            &row["videos"],
            row["media_capture"]["status"] == "complete",
            true,
        );
        if row["collection_stage"] == "discovery" && !current.is_null() {
            if ((row.get("location").is_some() && row["location"] != current["location"])
                || (row.get("country").is_some() && row["country"] != current["country"]))
                && row.get("travel_checked_at").is_none()
            {
                for k in [
                    "drive_minutes",
                    "drive_origin",
                    "drive_latitude",
                    "drive_longitude",
                    "travel_source",
                    "travel_checked_at",
                ] {
                    current[k] = Value::Null;
                }
                remove(&mut current, "journey_estimate");
            }
            for k in [
                "price_minor",
                "currency",
                "price_kind",
                "price_period",
                "cash_price_minor",
                "total_cash_cost_minor",
                "costs_complete",
                "check_outcome",
                "collection_stage",
                "title",
                "availability",
                "observed_at",
            ] {
                if let Some(v) = row.get(k) {
                    current[k] = v.clone();
                } else {
                    remove(&mut current, k);
                }
            }
            for k in ["attributes", "evidence", "field_evidence"] {
                if !current[k].is_object() {
                    current[k] = json!({});
                }
                if let Some(obj) = row[k].as_object() {
                    for (name, value) in obj {
                        current[k][name] = value.clone();
                    }
                }
            }
            for k in [
                "description",
                "chip",
                "ram_gb",
                "ssd_gb",
                "screen_inches",
                "condition",
                "item_state",
                "functional",
                "location",
                "location_precision",
                "country",
                "category_id",
                "category_path",
                "bundle_type",
                "inventory_type",
                "quantity",
                "availability_text",
                "seller_name",
                "seller_id",
                "seller_type",
                "seller_profile_url",
                "seller_public_profile_url",
                "seller_friend_count",
                "seller_friend_count_text",
                "seller_friend_count_precision",
                "seller_listing_count",
                "seller_listing_count_text",
                "seller_listing_count_precision",
                "seller_listings_checked_at",
                "seller_inventory_review",
                "seller_profile_checked_at",
                "seller_profile_notes",
                "seller_avatar_media_id",
                "seller_has_profile_image",
                "seller_account_joined_at",
                "seller_metadata_checked_at",
                "drive_minutes",
                "drive_origin",
                "drive_latitude",
                "drive_longitude",
                "travel_source",
                "travel_checked_at",
                "publication",
                "logistics",
                "seller",
                "interest",
                "terms",
            ] {
                if let Some(v) = row.get(k) {
                    current[k] = v.clone();
                    if row["evidence"].get(k).is_none() {
                        remove(&mut current["evidence"], k);
                    }
                    if row["field_evidence"].get(k).is_none() {
                        remove(&mut current["field_evidence"], k);
                    }
                }
            }
        } else {
            current = row.clone();
        }
        if !photos.is_null() {
            current["photos"] = photos;
        }
        if !videos.is_null() {
            current["videos"] = videos;
        }
        for (media, review, total) in [
            ("photos", "image_review", "total_images"),
            ("videos", "video_review", "total_videos"),
        ] {
            if current[review][total].as_i64().is_some_and(|total| {
                arr(&current[media])
                    .iter()
                    .any(|p| p["position"].as_i64().unwrap_or(0) > total)
            }) {
                remove(&mut current, review);
            }
        }
        if let Some(capture) = row.get("media_capture") {
            current["media_capture"] = capture.clone();
        } else {
            remove(&mut current, "media_capture");
        }
        if original["kind"] == "published" {
            let old_bounds = publication_bounds(&json!({"publication":original}));
            let new_bounds = publication_bounds(row);
            if row.get("publication").is_none()
                || old_bounds.is_some_and(|o| new_bounds.is_none_or(|n| o.0 <= n.0))
            {
                current["publication"] = original;
            }
        }
        current["last_attempted_at"] = row["observed_at"].clone();
        prior = row.clone();
    }
    let first = history.first()?;
    let last = history.last()?;
    if current.is_null() {
        return None;
    }
    remove(&mut current, "evaluation_id");
    remove(&mut current, "observation_sequence");
    current["key"] = json!(key);
    current["first_observed_at"] = successes.first().unwrap_or(&first["observed_at"]).clone();
    current["last_observed_at"] = successes.last().unwrap_or(&last["observed_at"]).clone();
    current["last_successful_at"] = successes.last().cloned().unwrap_or(Value::Null);
    current["first_confirmed_active_at"] = first_active;
    current["last_confirmed_active_at"] = last_active;
    current["observation_conflict"] = json!(conflict);
    Some((current, events))
}
fn observations(ws: &Workspace, key: Option<&str>) -> Result<Vec<Value>> {
    let sql = format!(
        "SELECT o.listing_key,o.rowid,o.evaluation_id,o.document_json,e.evaluated_at FROM listing_observations o JOIN listing_evaluations e ON o.evaluation_id=e.id{}",
        if key.is_some() {
            " WHERE o.listing_key=?"
        } else {
            ""
        }
    );
    let mut stmt = ws.db.prepare(&sql)?;
    let parameters: Vec<&dyn ToSql> = key
        .as_ref()
        .map(|k| vec![k as &dyn ToSql])
        .unwrap_or_default();
    let mut rows = stmt.query(parameters.as_slice())?;
    let mut out = Vec::new();
    while let Some(entry) = rows.next()? {
        let data: String = entry.get(3)?;
        let mut row: Value = serde_json::from_str(&data)?;
        if row["price_kind"] != "asking"
            || (row["product"] != "rental"
                && default(&row["price_period"], json!("once")) != "once")
        {
            row["price_minor"] = Value::Null;
        }
        for k in [
            "finance_price_minor",
            "finance_monthly_minor",
            "monthly_payment_minor",
            "finance",
            "finance_terms",
        ] {
            remove(&mut row, k);
        }
        row["key"] = json!(entry.get::<_, String>(0)?);
        row["observation_sequence"] = json!(entry.get::<_, i64>(1)?);
        row["evaluation_id"] = json!(entry.get::<_, String>(2)?);
        row["ingested_at"] = json!(entry.get::<_, String>(4)?);
        row["observed_at"] = json!(iso(time(s(&row["observed_at"]))?));
        row["check_outcome"] = default(&row["check_outcome"], json!("success"));
        out.push(row);
    }
    out.sort_by_key(|r| {
        (
            t(&r["observed_at"]),
            t(&r["ingested_at"]),
            r["observation_sequence"].as_i64().unwrap_or(0),
        )
    });
    Ok(out)
}
fn apply_history(row: &mut Value, history: &[Value], events: Vec<Value>) {
    row["events"] = json!(events);
    row["price_history"]=json!(history.iter().rev().filter(|h|h["check_outcome"]=="success").map(|h|json!({"evaluated_at":default(&h["ingested_at"],h["observed_at"].clone()),"observed_at":h["observed_at"],"price_minor":if h["price_kind"]=="asking"{h["price_minor"].clone()}else{Value::Null},"currency":h["currency"],"price_period":default(&h["price_period"],json!("once"))})).collect::<Vec<_>>());
    if !truth(&row["first_confirmed_active_at"]) {
        row["duration"] = json!({"lower_days":null,"upper_days":null,"unfinished":true,"basis":"No confirmed active observation"});
        return;
    }
    let start = t(&row["first_confirmed_active_at"]);
    let end = history.iter().find(|h| {
        t(&h["observed_at"]) >= start
            && h["check_outcome"] == "success"
            && (terminal(s(&h["availability"])) || h["availability"] == "reserved")
    });
    let active = history
        .iter()
        .rev()
        .find(|h| {
            t(&h["observed_at"]) >= start
                && h["check_outcome"] == "success"
                && h["availability"] == "active"
                && end.is_none_or(|e| t(&h["observed_at"]) <= t(&e["observed_at"]))
        })
        .map(|h| t(&h["observed_at"]))
        .unwrap_or(start);
    row["duration"] = json!({"lower_days":(active-start)as f64/DAY as f64,"upper_days":end.map(|e|(t(&e["observed_at"])-start)as f64/DAY as f64),"unfinished":end.is_none(),"outcome":end.map(|e|s(&e["availability"])).unwrap_or("active_or_unknown"),"basis":"First observed availability episode; publication and transaction times may be earlier"});
}
fn apply_captures(ws: &Workspace, rows: &mut [Value]) -> Result<()> {
    for capture in documents(
        ws,
        "SELECT document_json FROM listing_media_captures ORDER BY captured_at,rowid",
        &[],
    )? {
        let Some(row) = rows.iter_mut().find(|r| r["key"] == capture["listing_key"]) else {
            continue;
        };
        let captured = &capture["media_capture"]["captured_at"];
        if !truth(captured) {
            continue;
        }
        if row["media_capture"]["status"] == "complete"
            && t(&default(
                &row["media_capture"]["captured_at"],
                row["observed_at"].clone(),
            )) > t(captured)
        {
            continue;
        }
        for (key, total) in [("photos", "expected_photos"), ("videos", "expected_videos")] {
            let value = merge_media(
                &row[key],
                &capture[key],
                capture["media_capture"][total].as_u64() == Some(arr(&capture[key]).len() as u64),
                false,
            );
            if !value.is_null() {
                row[key] = value;
            }
        }
        row["media_capture"] = capture["media_capture"].clone();
    }
    Ok(())
}
pub fn journey_origin_key(config: &Value) -> String {
    json!([
        s(&config["origin"]).trim(),
        config["location"]["latitude"],
        config["location"]["longitude"],
        config["location"]["country"]
    ])
    .to_string()
}
fn destination_key(destination: &Value, country: &Value) -> String {
    json!([
        s(destination)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
        country.as_str().map(|s| s.trim().to_lowercase())
    ])
    .to_string()
}
fn journey_lifetime(kind: &Value) -> i64 {
    if kind == "typical" { 7 * DAY } else { DAY }
}
fn journey_fresh(route: &Value, config: &Value, row: &Value, now: i64) -> bool {
    route["origin_key"] == journey_origin_key(config)
        && destination_key(&route["destination"], &route["country"])
            == destination_key(
                &row["location"],
                &default(&row["country"], config["location"]["country"].clone()),
            )
        && t(&route["checked_at"]) <= now
        && t(&route["expires_at"]) > now
}
fn apply_journeys(ws: &Workspace, rows: &mut [Value]) -> Result<()> {
    let key = journey_origin_key(&ws.config);
    let routes = documents(
        ws,
        "SELECT document_json FROM journey_estimates WHERE origin_key=?",
        &[&key],
    )?;
    for row in rows {
        let Some(route) = routes
            .iter()
            .find(|route| journey_fresh(route, &ws.config, row, ws.now))
        else {
            continue;
        };
        if row["drive_origin"] == ws.config["origin"]
            && t(&row["travel_checked_at"]) > t(&route["checked_at"])
        {
            continue;
        }
        row["drive_minutes"] = route["drive_minutes"].clone();
        row["drive_origin"] = ws.config["origin"].clone();
        row["drive_latitude"] = ws.config["location"]["latitude"].clone();
        row["drive_longitude"] = ws.config["location"]["longitude"].clone();
        row["travel_source"] = json!("Google Maps · town-level estimate");
        row["travel_checked_at"] = route["checked_at"].clone();
        row["journey_estimate"] = route.clone();
        if !row["evidence"].is_object() {
            row["evidence"] = json!({});
        }
        row["evidence"]["drive_minutes"] = route["evidence"].clone();
    }
    Ok(())
}
fn root_key(parents: &mut HashMap<String, String>, key: &str) -> String {
    let parent = parents
        .entry(key.into())
        .or_insert_with(|| key.into())
        .clone();
    if parent == key {
        parent
    } else {
        let root = root_key(parents, &parent);
        parents.insert(key.into(), root.clone());
        root
    }
}
pub fn load(ws: &Workspace) -> Result<Vec<Value>> {
    let provenance = if ws.mode == "sample" {
        "synthetic"
    } else {
        "manual"
    };
    let mut stmt=ws.db.prepare("SELECT listing_key,document_json,first_observed_at,last_observed_at FROM listings WHERE provenance=? ORDER BY rowid")?;
    let mut cursor = stmt.query([provenance])?;
    let mut rows = Vec::new();
    while let Some(entry) = cursor.next()? {
        let data: String = entry.get(1)?;
        let mut row: Value = serde_json::from_str(&data)?;
        row["key"] = json!(entry.get::<_, String>(0)?);
        row["first_observed_at"] = json!(entry.get::<_, String>(2)?);
        row["last_observed_at"] = json!(entry.get::<_, String>(3)?);
        rows.push(row);
    }
    apply_captures(ws, &mut rows)?;
    apply_journeys(ws, &mut rows)?;
    let mut parents = HashMap::new();
    for row in &rows {
        root_key(&mut parents, s(&row["key"]));
        for relation in arr(&row["relationships"]) {
            if relation["confidence"] == "confirmed" {
                let target = if relation["source"] == "facebook_marketplace" {
                    format!("{provenance}:{}", s(&relation["listing_id"]))
                } else {
                    format!(
                        "{provenance}:{}:{}",
                        s(&relation["source"]),
                        s(&relation["listing_id"])
                    )
                };
                let left = root_key(&mut parents, s(&row["key"]));
                let right = root_key(&mut parents, &target);
                parents.insert(left.clone().max(right.clone()), left.min(right));
            }
        }
    }
    let history = observations(ws, None)?;
    for row in &mut rows {
        let key = s(&row["key"]).to_owned();
        row["entity_key"] = json!(root_key(&mut parents, &key));
        let mut found=ws.db.prepare("SELECT search_id,run_id,run_started_at,recorded_at FROM listing_search_discoveries WHERE listing_key=?")?;
        row["first_found_runs"]=json!(found.query_map([&key],|r|Ok(json!({"search_id":r.get::<_,String>(0)?,"run_id":r.get::<_,String>(1)?,"run_started_at":r.get::<_,String>(2)?,"recorded_at":r.get::<_,Option<String>>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?);
        let mut seen = ws
            .db
            .prepare("SELECT search_id,seen_at FROM listing_seen WHERE listing_key=?")?;
        row["seen_in_searches"] = json!(
            seen.query_map([&key], |r| Ok(
                json!({"search_id":r.get::<_,String>(0)?,"seen_at":r.get::<_,String>(1)?})
            ))?
            .collect::<std::result::Result<Vec<_>, _>>()?
        );
        let events = documents(
            ws,
            "SELECT document_json FROM listing_events WHERE listing_key=? ORDER BY observed_at DESC,id",
            &[&key],
        )?;
        let selected: Vec<_> = history
            .iter()
            .filter(|h| h["key"] == key)
            .cloned()
            .collect();
        apply_history(row, &selected, events);
    }
    Ok(rows)
}
pub fn find(ws: &Workspace, key: &str) -> Result<Option<Value>> {
    Ok(load(ws)?.into_iter().find(|r| r["key"] == key))
}
pub fn distinct(rows: &[Value]) -> Vec<Value> {
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for row in rows {
        let key = s(&default(&row["entity_key"], row["key"].clone())).to_owned();
        if let Some((_, g)) = groups.iter_mut().find(|(k, _)| k == &key) {
            g.push(row.clone());
        } else {
            groups.push((key, vec![row.clone()]));
        }
    }
    groups
        .into_iter()
        .map(|(_, mut group)| {
            group.sort_by_key(|r| {
                std::cmp::Reverse(t(&default(
                    &r["observed_at"],
                    r["last_observed_at"].clone(),
                )))
            });
            let mut row = group[0].clone();
            if let Some(original) = group
                .iter()
                .filter(|r| publication_bounds(r).is_some())
                .min_by_key(|r| publication_bounds(r).unwrap().0)
            {
                row["publication"] = original["publication"].clone();
            }
            row["entity_sources"] = json!(
                group
                    .iter()
                    .map(|r| s(&r["source"]))
                    .collect::<BTreeSet<_>>()
            );
            if let Some(start) = group
                .iter()
                .filter(|r| truth(&r["first_observed_at"]))
                .min_by_key(|r| t(&r["first_observed_at"]))
            {
                row["first_observed_at"] = start["first_observed_at"].clone();
            }
            row
        })
        .collect()
}
pub fn setup_cost_total(row: &Value) -> Value {
    let base = default(&row["total_cash_cost_minor"], row["price_minor"].clone());
    let costs = arr(&row["setup_costs"]);
    if base.is_null()
        || (!costs.is_empty()
            && (row.get("costs_complete") == Some(&Value::Null) || row["costs_complete"] == false))
        || costs.iter().any(|c| {
            c["price_minor"].is_null() || c["currency"] != default(&row["currency"], json!("GBP"))
        })
    {
        return json!({"total_minor":null,"basis":"unknown"});
    }
    json!({"total_minor":n(&base)+costs.iter().map(|c|n(&c["price_minor"])).sum::<f64>(),"basis":if costs.iter().any(|c|c["basis"]=="estimate"){"estimate"}else{"observed"}})
}
fn accessory_evidence(row: &Value, id: &str) -> Option<String> {
    let names: Vec<String> = match id {
        "portafilter" => vec!["portafilter".into(), "portafilter handle".into()],
        "filter_baskets" => vec![
            "filter baskets".into(),
            "filter basket".into(),
            "baskets".into(),
            "basket".into(),
        ],
        "tamper" => vec!["tamper".into(), "integrated tamper".into()],
        _ => vec![id.replace('_', " ")],
    };
    let count =
        Regex::new(r"^(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten)\s+").unwrap();
    for key in ["accessories", "package_contents"] {
        let source = s(&row["evidence"][key]);
        if source.trim().is_empty() {
            continue;
        }
        let content = &row["attributes"][key];
        let strings = if let Some(a) = content.as_array() {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        } else {
            s(content).split([';', ',']).map(str::to_owned).collect()
        };
        if strings.iter().any(|item| {
            names.contains(
                &count
                    .replace(&item.trim().to_lowercase().replace('_', " "), "")
                    .into_owned(),
            )
        }) {
            return Some(source.to_owned());
        }
    }
    None
}
pub fn verification_checks(row: &Value, expected: &Value) -> Vec<Value> {
    let mut checks = arr(&row["verification_checks"]).to_vec();
    for check in &mut checks {
        if check["state"] == "unknown"
            && let Some(e) = accessory_evidence(row, s(&check["id"]))
        {
            check["state"] = json!("confirmed");
            check["evidence"] = json!(e);
        }
    }
    let add = |checks: &mut Vec<Value>, definition: &Value| {
        let id = s(&definition["id"]);
        if checks.iter().any(|c| c["id"] == id) {
            return;
        }
        let accessory = accessory_evidence(row, id);
        let value = default(
            &row["attributes"][id],
            if accessory.is_some() {
                json!(true)
            } else {
                Value::Null
            },
        );
        let evidence = default(&row["evidence"][id], json!(accessory));
        let verified = !s(&evidence).trim().is_empty();
        let mut check = definition.clone();
        check["state"] = json!(if verified && value.is_boolean() {
            if value == true {
                "confirmed"
            } else {
                "missing"
            }
        } else {
            "unknown"
        });
        check["evidence"] = if verified { evidence } else { Value::Null };
        checks.push(check);
    };
    for definition in arr(expected) {
        add(&mut checks, definition);
    }
    for (id, label, question, needed) in [
        (
            "condition",
            "Condition",
            "Could you confirm its condition and whether there is any damage?",
            !truth(&row["condition"]) || row["condition"] == "unknown",
        ),
        (
            "functional",
            "Working condition",
            "Is everything working properly, with no faults?",
            row["functional"].is_null(),
        ),
    ] {
        if needed && !checks.iter().any(|c| c["id"] == id) {
            checks.push(json!({"id":id,"label":label,"question":question,"state":"unknown","evidence":null}));
        }
    }
    if arr(expected).is_empty() && row["product"] == "espresso_machine" {
        for (id, label, question) in [
            (
                "portafilter",
                "Portafilter",
                "Does it include the portafilter?",
            ),
            (
                "filter_baskets",
                "Filter baskets",
                "Which filter baskets are included?",
            ),
            ("tamper", "Tamper", "Is the tamper included?"),
        ] {
            add(
                &mut checks,
                &json!({"id":id,"label":label,"question":question}),
            );
        }
    }
    if !checks.iter().any(|c| c["id"] == "package_contents")
        && arr(expected).is_empty()
        && row["product"] != "espresso_machine"
        && row["product"] != "rental"
        && !truth(&row["attributes"]["package_contents"])
    {
        checks.push(json!({"id":"package_contents","label":"Included accessories","question":"Could you confirm which parts and accessories are included?","state":"unknown","evidence":null}));
    }
    checks
}
pub fn quality(row: &Value, config: &Value, now: i64, peers: &[Value]) -> Value {
    let policy = quality_policy(config);
    let mut flags = Vec::new();
    let mut price = Vec::<String>::new();
    let mut stock = Vec::<String>::new();
    if default(&row["check_outcome"], json!("success")) != "success" {
        stock.push("The latest listing check did not succeed".into());
    }
    let stamp = default(&row["observed_at"], row["last_observed_at"].clone());
    if truth(&stamp) && (now - t(&stamp)) as f64 > n(&policy["max_check_age_hours"]) * 3600000. {
        stock.push("Listing availability needs a fresh check".into());
    }
    if row["availability"] != "active" {
        stock.push("Listing is not confirmed active".into());
    }
    if row["price_kind"] != "asking"
        || !truth(&row["price_minor"])
        || (row["product"] != "rental" && default(&row["price_period"], json!("once")) != "once")
    {
        price.push("Full purchase price is unknown or unavailable".into());
    }
    let conflicts: Vec<_> = row["field_evidence"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, v)| v["state"] == "conflicting")
        .map(|(k, _)| k.as_str())
        .collect();
    if !conflicts.is_empty() || row["observation_conflict"] == true {
        flags.push(json!({"code":"conflicting_evidence","message":"Listing evidence conflicts and needs review","severity":"review"}));
        price.push("Conflicting listing evidence".into());
    }
    if conflicts.contains(&"availability") || row["observation_conflict"] == true {
        stock.push("Availability evidence conflicts".into());
    }
    if arr(&row["relationships"])
        .iter()
        .any(|r| r["confidence"] == "probable")
    {
        flags.push(json!({"code":"possible_duplicate","message":"This may be a relisted or cross-posted item","severity":"context"}));
    }
    let valid: Vec<_> = distinct(peers)
        .into_iter()
        .filter(|p| truth(&p["price_minor"]) && p["price_kind"] == "asking")
        .collect();
    let mut center = Value::Null;
    let mut spread = Value::Null;
    let mut score = Value::Null;
    if truth(&row["price_minor"]) && valid.len() as f64 >= n(&policy["minimum_outlier_peers"]) {
        let prices: Vec<_> = valid.iter().map(|p| n(&p["price_minor"])).collect();
        center = median(prices.clone());
        spread = median(prices.iter().map(|p| (p - n(&center)).abs()).collect());
        if n(&spread) > 0. {
            let z = 0.6745 * (n(&row["price_minor"]) - n(&center)) / n(&spread);
            score = json!(round(z, 2));
            if z.abs() > n(&policy["outlier_z"]) {
                let direction = if z < 0. { "low" } else { "high" };
                flags.push(json!({"code":format!("{direction}_price"),"message":format!("Purchase price is unusually {direction} among equivalent listings"),"severity":"context"}));
            }
        } else {
            flags.push(json!({"code":"flat_price_sample","message":"Similar prices have no reliable statistical spread","severity":"context"}));
        }
    }
    let active_days =
        if truth(&row["first_confirmed_active_at"]) && truth(&row["last_confirmed_active_at"]) {
            json!(
                (t(&row["last_confirmed_active_at"]) - t(&row["first_confirmed_active_at"])) as f64
                    / DAY as f64
            )
        } else {
            Value::Null
        };
    let bounds = publication_bounds(row);
    let age = bounds.map(|(_, b)| (now - b) as f64 / DAY as f64);
    let mut ages: Vec<_> = distinct(peers)
        .iter()
        .filter_map(publication_bounds)
        .map(|(_, b)| (now - b) as f64 / DAY as f64)
        .collect();
    ages.sort_by(f64::total_cmp);
    if let Some(age) = age
        && ages.len() as f64 >= n(&policy["minimum_outlier_peers"])
        && !ages.is_empty()
        && age > ages[((ages.len() as f64 * 0.95).floor() as usize).min(ages.len() - 1)]
    {
        flags.push(json!({"code":"long_advertised_age","message":"Advertised age is longer than most equivalent observed listings","severity":"context"}));
    }
    for message in &stock {
        flags.push(json!({"code":"availability_uncertain","message":message,"severity":"review"}));
    }
    let publication = if conflicts.contains(&"publication") {
        vec!["Publication evidence conflicts"]
    } else if bounds.is_some() {
        vec![]
    } else {
        vec!["Original publication time is not established"]
    };
    let duration = if conflicts.contains(&"availability") || row["observation_conflict"] == true {
        vec!["Availability evidence conflicts"]
    } else if row["inventory_type"] == "multiple_units" {
        vec!["Multi-unit stock does not establish an individual item's lifetime"]
    } else if truth(&row["first_confirmed_active_at"]) {
        vec![]
    } else {
        vec!["No confirmed active observation"]
    };
    let price_reasons: Vec<_> = stock.iter().chain(price.iter()).cloned().collect();
    let mut eligibility = json!({});
    for (name, reasons) in [
        ("arrival_rate", json!(publication)),
        ("current_stock", json!(stock)),
        ("price_baseline", json!(price_reasons)),
        ("duration_analysis", json!(duration)),
        ("deal_alert", json!(price_reasons)),
    ] {
        eligibility[name] = json!({"eligible":arr(&reasons).is_empty(),"reasons":reasons});
    }
    json!({"flags":flags,"eligibility":eligibility,"observed_active_days":active_days,"advertised_age_minimum_days":age,"peer_count":valid.len(),"median_cash_price_minor":center,"mad_minor":spread,"modified_z_score":score})
}
pub fn cohort(row: &Value, search: &Value) -> Option<String> {
    crate::searches::search_cohort(row, search).map(|base| {
        canonical(&json!([
            base,
            row["currency"],
            default(&row["price_period"], json!("once")),
            row["bundle_type"],
            row["seller_type"],
            default(&row["quantity"], json!(1)),
            row["condition"],
            row["item_state"],
            row["functional"]
        ]))
    })
}
fn history_cohort(row: &Value, search: &Value) -> Option<String> {
    if row["product"] != search["product"] {
        return None;
    }
    let mut filtered = search.clone();
    filtered["definition"]["fields"] = json!(
        arr(&search["definition"]["fields"])
            .iter()
            .filter(
                |f| !["price_minor", "drive_minutes", "seller_listing_count"]
                    .contains(&s(&f["match"]["attribute"]))
            )
            .cloned()
            .collect::<Vec<_>>()
    );
    let (rejected, uncertain, _) =
        crate::searches::criteria(row, &filtered, false, crate::util::now());
    if !rejected.is_empty()
        || !uncertain.is_empty()
        || (["macbook_pro", "mac_mini"].contains(&s(&row["product"])) && row["functional"] != true)
    {
        None
    } else {
        cohort(row, search)
    }
}
fn evidence(row: &Value, name: &str) -> bool {
    !s(&row["evidence"][name]).trim().is_empty()
}
pub fn match_listing(
    row: &Value,
    search: &Value,
    config: &Value,
    now: i64,
    demo: bool,
    budget: bool,
) -> (String, Vec<String>) {
    if row["product"] != search["product"] {
        return (
            "not_matching".into(),
            vec!["Different search category".into()],
        );
    }
    let (mut rejected, mut uncertain, _) = crate::searches::criteria(row, search, budget, now);
    let (learned, unknown, _) = crate::searches::learned_criteria(row, search, config, budget);
    rejected.extend(learned);
    uncertain.extend(unknown);
    if budget && !demo && row["image_review"]["complete"] != true {
        uncertain.push("Every listing image needs inspection".into());
    }
    if budget
        && !demo
        && (!arr(&row["videos"]).is_empty()
            || n(&row["video_review"]["total_videos"]) > 0.
            || n(&row["media_capture"]["expected_videos"]) > 0.)
        && row["video_review"]["complete"] != true
    {
        uncertain.push("Every listing video needs inspection".into());
    }
    if budget && row["collection_stage"] == "discovery" {
        uncertain.push("Provisional discovery needs verification".into());
    }
    if budget
        && (!arr(&row["verification_checks"]).is_empty()
            || !arr(&search["discovery"]["verification_checks"]).is_empty())
        && verification_checks(row, &search["discovery"]["verification_checks"])
            .iter()
            .any(|c| c["state"] != "confirmed")
    {
        uncertain.push("Condition or included accessories need seller confirmation".into());
    }
    if budget
        && !arr(&row["setup_costs"]).is_empty()
        && setup_cost_total(row)["basis"] != "observed"
    {
        uncertain.push("Complete setup cost needs verification".into());
    }
    if terminal(s(&row["availability"])) || row["availability"] == "reserved" {
        rejected.push("Listing is unavailable".into());
    } else if row["availability"] != "active" {
        uncertain.push("Availability is unknown".into());
    }
    if row["price_kind"] != "asking" {
        rejected.push("A full purchase price is required; finance payments are ignored".into());
    }
    if !truth(&row["price_minor"]) {
        uncertain.push("Full asking price needs verification".into());
    }
    if row["currency"] != search["definition"]["price"]["currency"] {
        rejected.push("Different currency".into());
    }
    if default(&row["price_period"], json!("once")) != search["definition"]["price"]["period"] {
        uncertain.push("Price period needs verification or normalization".into());
    }
    if ["macbook_pro", "mac_mini"].contains(&s(&search["product"])) {
        if row["functional"] == false {
            rejected.push("Item is not working".into());
        } else if row["functional"] != true || !evidence(row, "functional") {
            uncertain.push("Working condition needs verification".into());
        }
        if !["new", "used", "refurbished"].contains(&s(&row["item_state"])) {
            uncertain.push("New/used state is unknown".into());
        }
        if search["product"] == "macbook_pro"
            && (![14., 16.].contains(&n(&row["screen_inches"])) || !evidence(row, "screen_inches"))
        {
            uncertain.push("Laptop screen size needs verification".into());
        }
    }
    let driving = arr(&search["definition"]["fields"]).iter().any(|f| {
        f["match"]["attribute"] == "drive_minutes"
            && default(&f["match"]["importance"], json!("required")) == "required"
            && !search["values"][s(&f["id"])].is_null()
            && crate::searches::is_visible(f, &search["values"], &search["definition"])
    });
    if driving {
        if !demo && config["origin_confirmed"] != true {
            uncertain.push("Travel origin needs confirmation".into());
        }
        if row["drive_minutes"].is_null() || row["drive_origin"] != config["origin"] {
            uncertain.push("Driving time from the configured origin is unknown".into());
        }
        match time(s(&row["travel_checked_at"])) {
            Ok(stamp) => {
                let lifetime = if row["journey_estimate"].is_null() {
                    DAY
                } else {
                    journey_lifetime(&row["journey_estimate"]["estimate_kind"])
                };
                if now - stamp < 0
                    || now - stamp > lifetime
                    || (!row["journey_estimate"].is_null()
                        && !journey_fresh(&row["journey_estimate"], config, row, now))
                {
                    uncertain.push("Journey estimate needs a fresh check".into());
                }
            }
            Err(_) => uncertain.push("Journey check time is unknown".into()),
        };
        if !config["location"]["latitude"].is_null()
            && (row["drive_latitude"] != config["location"]["latitude"]
                || row["drive_longitude"] != config["location"]["longitude"])
        {
            uncertain.push("Journey origin coordinates need a fresh check".into());
        }
        if !truth(&row["travel_source"]) {
            uncertain.push("Journey source is unknown".into());
        }
        if row["journey_estimate"]["precision"] == "town"
            && !row["drive_minutes"].is_null()
            && arr(&search["definition"]["fields"]).iter().any(|f| {
                f["match"]["attribute"] == "drive_minutes"
                    && f["match"]["operator"] == "lte"
                    && search["values"][s(&f["id"])].is_number()
                    && (n(&search["values"][s(&f["id"])]) - n(&row["drive_minutes"])).abs() <= 10.
            })
        {
            uncertain.push("Town-level journey is close to your limit; confirm the pickup area before committing".into());
        }
    }
    if crate::searches::search_cohort(row, search).is_none() {
        uncertain.push("Comparison attributes need verification".into());
    }
    for reason in arr(&quality(row, config, now, &[])["eligibility"]["price_baseline"]["reasons"]) {
        let reason = s(reason).to_owned();
        if !uncertain.contains(&reason)
            && ![
                "Listing is not confirmed active",
                "Full purchase price is unknown or unavailable",
            ]
            .contains(&reason.as_str())
        {
            uncertain.push(reason);
        }
    }
    if !rejected.is_empty() {
        rejected.extend(uncertain);
        ("not_matching".into(), rejected)
    } else if !uncertain.is_empty() {
        ("needs_review".into(), uncertain)
    } else {
        ("matched".into(), vec![])
    }
}
pub fn credibility_check(row: &Value, peers: &[Value], config: &Value, now: i64) -> Value {
    let p = credibility_policy(config);
    let mut recent = Value::Null;
    let metadata = fresh(&row["seller_metadata_checked_at"], now, 30);
    let joined = s(&row["seller_account_joined_at"]);
    if !joined.is_empty() && evidence(row, "seller_account_joined_at") && metadata {
        let first = if joined.len() == 4 {
            format!("{joined}-01-01T00:00:00Z")
        } else {
            format!("{joined}T00:00:00Z")
        };
        let last = if joined.len() == 4 {
            format!("{joined}-12-31T00:00:00Z")
        } else {
            first.clone()
        };
        if let Some(today) = Utc.timestamp_millis_opt(now).single() {
            let months = today.year() as i64 * 12 + today.month0() as i64
                - p["recent_account_months"].as_i64().unwrap_or(24);
            let year = months.div_euclid(12) as i32;
            let month = months.rem_euclid(12) as u32 + 1;
            let mut day = today.day();
            let cutoff = loop {
                if let Some(date) = Utc.with_ymd_and_hms(year, month, day, 0, 0, 0).single() {
                    break date.timestamp_millis();
                }
                day -= 1;
            };
            if let (Ok(a), Ok(b)) = (time(&first), time(&last)) {
                recent = if a >= cutoff {
                    json!(true)
                } else if b < cutoff {
                    json!(false)
                } else {
                    Value::Null
                };
            }
        }
    }
    let image = if metadata && evidence(row, "seller_has_profile_image") {
        row["seller_has_profile_image"].clone()
    } else {
        Value::Null
    };
    let friends = if truth(&row["seller_public_profile_url"])
        && evidence(row, "seller_friend_count")
        && fresh(&row["seller_profile_checked_at"], now, 30)
    {
        row["seller_friend_count"].clone()
    } else {
        Value::Null
    };
    let mut established = Value::Null;
    let mut supporting = Vec::new();
    if !friends.is_null()
        && ["exact", "lower_bound"].contains(&s(&row["seller_friend_count_precision"]))
        && !recent.is_null()
    {
        established =
            json!(recent == false && n(&friends) >= n(&p["established_account_minimum_friends"]));
        if established == true {
            supporting.push(format!(
                "Facebook account older than {} months with {}{} friends shown on the profile",
                p["recent_account_months"],
                if row["seller_friend_count_precision"] == "lower_bound" {
                    "at least "
                } else {
                    ""
                },
                friends
            ));
        }
    }
    let mut result = json!({"status":"insufficient_data","reasons":[],"peer_count":peers.len(),"reference_median_minor":null,"reference_stddev_minor":null,"stddevs_below_median":null,"price_is_outlier":null,"seller_account_recent":recent,"seller_has_profile_image":image,"seller_friend_count":friends,"older_account_with_many_friends":established,"supporting_signals":supporting,"policy":p});
    if (peers.len() as f64) < n(&p["minimum_peer_listings"]) {
        result["reasons"] = json!(["Not enough equivalent listings for an unusual-price check"]);
        return result;
    }
    let prices: Vec<_> = peers.iter().map(|p| n(&p["price_minor"])).collect();
    let center = n(&median(prices.clone()));
    let mean = prices.iter().sum::<f64>() / prices.len() as f64;
    let spread =
        (prices.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (prices.len() - 1) as f64).sqrt();
    let mut reasons = Vec::new();
    result["reference_median_minor"] = json!(center);
    result["reference_stddev_minor"] = json!(round(spread, 2));
    if spread > 0. {
        let score = (center - n(&row["price_minor"])) / spread;
        result["stddevs_below_median"] = json!(round(score, 2));
        result["price_is_outlier"] = json!(score >= n(&p["stddev_threshold"]));
    } else {
        result["price_is_outlier"] = json!(
            n(&row["price_minor"]) <= center * (1. - n(&p["zero_variance_discount_fraction"]))
        );
        reasons.push("Peer prices have no variation; a large price-gap check replaces the deviation calculation".to_owned());
    }
    let mut signals = Vec::new();
    if recent == true {
        signals.push("Seller account joined recently".to_owned());
    }
    if image == false {
        signals.push("No custom seller profile image observed".to_owned());
    }
    if result["price_is_outlier"] == true && !signals.is_empty() {
        result["status"] = json!("review");
        let mut why = vec!["Price is unusually low among equivalent listings".to_owned()];
        why.extend(signals);
        why.extend(reasons);
        reasons = why;
    } else {
        result["status"] = json!("no_combined_flag");
        if result["price_is_outlier"] == true {
            reasons
                .push("Price is unusually low; seller signals do not establish credibility".into());
        }
    }
    result["reasons"] = json!(reasons);
    result
}
pub fn comparison_pool(
    rows: &[Value],
    search: &Value,
    config: &Value,
    now: i64,
    demo: bool,
) -> Vec<Value> {
    let pool = distinct(
        &rows
            .iter()
            .filter(|r| match_listing(r, search, config, now, demo, false).0 == "matched")
            .cloned()
            .collect::<Vec<_>>(),
    );
    pool.iter()
        .filter(|row| {
            let peers: Vec<_> = pool
                .iter()
                .filter(|p| {
                    cohort(p, search) == cohort(row, search)
                        && default(&p["entity_key"], p["key"].clone())
                            != default(&row["entity_key"], row["key"].clone())
                })
                .cloned()
                .collect();
            credibility_check(row, &peers, config, now)["status"] != "review"
        })
        .cloned()
        .collect()
}
fn rational_round(numerator: i128, denominator: i128, digits: u32) -> f64 {
    let scale = 10i128.pow(digits);
    let scaled = numerator.abs() * scale;
    let mut q = scaled / denominator;
    let r = scaled % denominator;
    if r * 2 > denominator || (r * 2 == denominator && q % 2 != 0) {
        q += 1;
    }
    if numerator < 0 {
        q = -q;
    }
    q as f64 / scale as f64
}
pub fn evaluate_listing(
    row: &Value,
    pool: &[Value],
    search: &Value,
    config: &Value,
    now: i64,
    demo: bool,
) -> Value {
    let (status, reasons) = match_listing(row, search, config, now, demo, true);
    let key = cohort(row, search);
    let peers: Vec<_> = pool
        .iter()
        .filter(|p| {
            key.is_some()
                && cohort(p, search) == key
                && default(&p["entity_key"], p["key"].clone())
                    != default(&row["entity_key"], row["key"].clone())
        })
        .cloned()
        .collect();
    let (rejected, unknown, preferences) = crate::searches::criteria(row, search, true, now);
    let (learned, learned_unknown, score) =
        crate::searches::learned_criteria(row, search, config, true);
    let purchase = setup_cost_total(row);
    let mut decision = json!({"suitability":if status=="not_matching"||!rejected.is_empty()||!learned.is_empty(){"unsuitable"}else if !unknown.is_empty()||!learned_unknown.is_empty(){"possible"}else{"suitable"},"verification":if status=="matched"{"complete"}else{"needs_check"},"value":"unknown","setup_total_minor":purchase["total_minor"],"setup_cost_basis":purchase["basis"],"listing":row,"status":status,"reasons":reasons,"quality":quality(row,config,now,&peers),"preferences":preferences,"credibility":credibility_check(row,&peers,config,now)});
    if score != 0. {
        decision["preference_score"] = json!(score);
    }
    if status != "matched" || decision["credibility"]["status"] == "review" {
        if status == "matched" {
            decision["status"] = json!("needs_review");
            decision["reasons"] = decision["credibility"]["reasons"].clone();
        }
        for metric in ["price_baseline", "deal_alert"] {
            decision["quality"]["eligibility"][metric] =
                json!({"eligible":false,"reasons":decision["reasons"]});
        }
        return decision;
    }
    decision["peer_count"] = json!(peers.len());
    if (peers.len() as f64) < n(&config["minimum_peer_listings"]) {
        decision["status"] = json!("insufficient_comparables");
        decision["reasons"] = json!(["Too few equivalent listings to estimate an average"]);
        return decision;
    }
    let sum: i128 = peers
        .iter()
        .map(|p| p["price_minor"].as_i64().unwrap_or(0) as i128)
        .sum();
    let count = peers.len() as i128;
    let candidate = row["price_minor"].as_i64().unwrap_or(0) as i128;
    decision["reference_average_minor"] = json!(rational_round(sum, count, 2));
    decision["reference_median_minor"] =
        median(peers.iter().map(|p| n(&p["price_minor"])).collect());
    decision["peer_listing_ids"] = json!(
        peers
            .iter()
            .map(|p| p["listing_id"].clone())
            .collect::<Vec<_>>()
    );
    if candidate * count < sum {
        decision["value"] = json!("below_average");
        decision["status"] = json!("qualifies");
        decision["percent_below_average"] =
            json!(rational_round((sum - candidate * count) * 100, sum, 1));
        decision["reasons"] =
            json!(["Within budget and below the average of equivalent asking prices"]);
    } else {
        decision["value"] = json!("at_or_above_average");
        decision["status"] = json!("not_deal");
        decision["reasons"] =
            json!(["Price is at or above the average of equivalent asking prices"]);
    }
    decision
}
fn rule_hash(search: &Value, config: &Value) -> String {
    let mut search = search.clone();
    remove(&mut search, "enabled");
    remove(&mut search, "cover");
    let mut credibility = credibility_policy(config);
    remove(&mut credibility, "established_account_minimum_friends");
    hash(
        &json!({"search":search,"origin":config["origin"],"days":config["baseline_days"],"peers":config["minimum_peer_listings"],"policy":config["alert_policy"],"credibility":credibility,"image_review_required":true,"cash_price_only":true,"quality_policy":quality_policy(config)}),
    )
}
pub fn pending_alerts(ws: &Workspace) -> Result<Value> {
    let mut stmt = ws.db.prepare(
        "SELECT id,search_id,listing_key,price_minor FROM deal_alerts WHERE status='pending'",
    )?;
    let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"search_id":r.get::<_,String>(1)?,"listing_key":r.get::<_,String>(2)?,"price_minor":r.get::<_,i64>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    Ok(json!(rows))
}
pub fn acknowledge(ws: &mut Workspace, ids: &[String]) -> Result<usize> {
    for id in ids {
        if !ws.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM deal_alerts WHERE id=? AND status='pending')",
            [id],
            |r| r.get::<_, bool>(0),
        )? {
            return fail("Each acknowledgement must refer to a pending alert");
        }
    }
    for id in ids {
        ws.db
            .execute("UPDATE deal_alerts SET status='delivered' WHERE id=?", [id])?;
    }
    Ok(ids.len())
}
pub fn evaluate(
    ws: &mut Workspace,
    observations_input: &Value,
    coverage_input: &Value,
) -> Result<Value> {
    let demo = ws.mode == "sample";
    let rows = normalize_observations(observations_input, demo, ws.now)?;
    let coverage = normalize_coverage(coverage_input, ws.now, &ws.config["searches"])?;
    let stamp = iso(ws.now);
    let eval_id = id();
    let mode = if demo { "synthetic" } else { "manual_import" };
    ws.db.execute(
        "INSERT INTO listing_evaluations VALUES (?,?,?,?,?)",
        params![
            eval_id,
            stamp,
            mode,
            rows.len() as i64,
            ws.config.to_string()
        ],
    )?;
    for row in &rows {
        ws.db.execute("INSERT INTO listings VALUES (?,?,?,?,?) ON CONFLICT(listing_key) DO UPDATE SET document_json=excluded.document_json,last_observed_at=excluded.last_observed_at",params![s(&row["key"]),s(&row["provenance"]),row.to_string(),stamp,stamp])?;
        ws.db.execute(
            "INSERT INTO listing_observations VALUES (?,?,?,?)",
            params![
                eval_id,
                s(&row["key"]),
                row["price_minor"].as_i64(),
                row.to_string()
            ],
        )?;
    }
    for row in &rows {
        let key = s(&row["key"]);
        if let Some((current, events)) = rebuild_history(key, &observations(ws, Some(key))?) {
            ws.db.execute("UPDATE listings SET document_json=?,first_observed_at=?,last_observed_at=? WHERE listing_key=?",params![current.to_string(),s(&current["first_observed_at"]),s(&current["last_observed_at"]),key])?;
            ws.db
                .execute("DELETE FROM listing_events WHERE listing_key=?", [key])?;
            for event in events {
                ws.db.execute(
                    "INSERT OR IGNORE INTO listing_events VALUES (?,?,?,?,?)",
                    params![
                        hash(&json!([key, event])),
                        key,
                        s(&event["kind"]),
                        s(&event["observed_at"]),
                        event.to_string()
                    ],
                )?;
            }
        }
    }
    for (index, run) in coverage.iter().enumerate() {
        ws.db.execute(
            "INSERT INTO search_coverage VALUES (?,?,?)",
            params![format!("{eval_id}:{index}"), eval_id, run.to_string()],
        )?;
    }
    let cutoff = ws.now - ws.config["baseline_days"].as_i64().unwrap_or(30) * DAY;
    let current: Vec<_> = load(ws)?
        .into_iter()
        .filter(|r| t(&r["last_observed_at"]) >= cutoff && t(&r["last_observed_at"]) <= ws.now)
        .collect();
    let mut new_alerts = Vec::new();
    let mut results = Vec::new();
    for search in arr(&ws.config["searches"]) {
        if search["enabled"] != true {
            results.push(json!({"search":search,"counts":{"paused":1},"decisions":[]}));
            continue;
        }
        let rules = rule_hash(search, &ws.config);
        let search_id = s(&search["id"]);
        ws.db.execute("UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND rule_hash<>? AND status='pending'",params![search_id,rules])?;
        let pool = comparison_pool(&current, search, &ws.config, ws.now, demo);
        let mut decisions = Vec::new();
        let mut counts = BTreeMap::<String, usize>::new();
        for row in current.iter().filter(|r| r["product"] == search["product"]) {
            let decision = evaluate_listing(row, &pool, search, &ws.config, ws.now, demo);
            let key = s(&row["key"]);
            if decision["status"] == "qualifies" {
                let price = row["price_minor"].as_i64().unwrap_or(0);
                let previous:Option<i64>=ws.db.query_row("SELECT MIN(price_minor) FROM deal_alerts WHERE search_id=? AND listing_key=? AND rule_hash=? AND status<>'withdrawn'",params![search_id,key,rules],|r|r.get(0))?;
                if previous.is_none_or(|p| price < p) || ws.config["alert_policy"] == "every_run" {
                    ws.db.execute("UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",params![search_id,key,rules])?;
                    let mut alert = decision.clone();
                    alert["id"] = json!(id());
                    alert["search_id"] = search["id"].clone();
                    alert["search_name"] = search["name"].clone();
                    alert["kind"] = json!(if previous.is_none() {
                        "first_qualification"
                    } else {
                        "price_drop"
                    });
                    alert["created_at"] = json!(stamp);
                    alert["status"] = json!("pending");
                    alert["mode"] = json!(mode);
                    ws.db.execute(
                        "INSERT INTO deal_alerts VALUES (?,?,?,?,?,?,?,?)",
                        params![
                            s(&alert["id"]),
                            search_id,
                            key,
                            rules,
                            price,
                            stamp,
                            "pending",
                            alert.to_string()
                        ],
                    )?;
                    new_alerts.push(alert);
                }
                let alerts = documents(
                    ws,
                    "SELECT alert_json FROM deal_alerts WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",
                    &[&search_id, &key, &rules],
                )?;
                for mut alert in alerts {
                    if let Some(o) = decision.as_object() {
                        for (k, v) in o {
                            alert[k] = v.clone();
                        }
                    }
                    ws.db.execute(
                        "UPDATE deal_alerts SET alert_json=?,price_minor=? WHERE id=?",
                        params![alert.to_string(), price, s(&alert["id"])],
                    )?;
                }
            } else {
                ws.db.execute("UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",params![search_id,key,rules])?;
            }
            *counts.entry(s(&decision["status"]).into()).or_default() += 1;
            decisions.push(decision);
        }
        results.push(json!({"search":search,"counts":counts,"decisions":decisions}));
    }
    let active: HashSet<_> = arr(&ws.config["searches"])
        .iter()
        .filter(|s| s["enabled"] == true)
        .map(|s| s["id"].clone().to_string())
        .collect();
    for alert in documents(
        ws,
        "SELECT alert_json FROM deal_alerts WHERE status='pending'",
        &[],
    )? {
        if alert["mode"] != mode {
            continue;
        }
        let key = s(&alert["listing"]["key"]);
        let stamp: Option<String> = ws
            .db
            .query_row(
                "SELECT last_observed_at FROM listings WHERE listing_key=?",
                [key],
                |r| r.get(0),
            )
            .optional()?;
        if !active.contains(&alert["search_id"].to_string())
            || stamp.as_ref().is_none_or(|v| time(v).unwrap_or(0) < cutoff)
        {
            ws.db.execute(
                "UPDATE deal_alerts SET status='withdrawn' WHERE id=?",
                [s(&alert["id"])],
            )?;
        }
    }
    let pending: Vec<_> = documents(
        ws,
        "SELECT alert_json FROM deal_alerts WHERE status='pending' ORDER BY created_at,id",
        &[],
    )?
    .into_iter()
    .filter(|a| a["mode"] == mode && active.contains(&a["search_id"].to_string()))
    .collect();
    Ok(
        json!({"evaluation_id":eval_id,"evaluated_at":stamp,"mode":mode,"origin":ws.config["origin"],"observed_count":rows.len(),"new_alerts":new_alerts,"pending_alerts":pending,"searches":results}),
    )
}
pub fn evaluations(ws: &Workspace) -> Result<Value> {
    let mut stmt=ws.db.prepare("SELECT id,evaluated_at,mode,observed_count FROM listing_evaluations ORDER BY evaluated_at DESC LIMIT 30")?;
    let values=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"evaluated_at":r.get::<_,String>(1)?,"mode":r.get::<_,String>(2)?,"observed_count":r.get::<_,i64>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let mut out = Vec::new();
    for mut evaluation in values {
        let id = s(&evaluation["id"]).to_owned();
        evaluation["observations"] = json!(documents(
            ws,
            "SELECT document_json FROM listing_observations WHERE evaluation_id=?",
            &[&id]
        )?);
        evaluation["search_coverage"] = json!(documents(
            ws,
            "SELECT document_json FROM search_coverage WHERE evaluation_id=?",
            &[&id]
        )?);
        out.push(evaluation);
    }
    Ok(json!(out))
}
pub fn discovery_summary(ws: &Workspace) -> Result<Value> {
    let mut stmt=ws.db.prepare("SELECT search_id,MAX(COALESCE(json_extract(document_json,'$.started_at'),json_extract(document_json,'$.worker.claimed_at'),json_extract(document_json,'$.first_result_at'),CASE WHEN json_extract(document_json,'$.phase')='completed' OR EXISTS (SELECT 1 FROM json_each(search_runs.document_json,'$.queries') AS query WHERE json_extract(query.value,'$.status')<>'planned') THEN json_extract(document_json,'$.created_at') END)) FROM search_runs GROUP BY search_id")?;
    let runs = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut result = json!({"counts":{},"last_searched":{}});
    for (id, stamp) in runs {
        result["counts"][&id] = json!(0);
        result["last_searched"][&id] = json!(stamp);
    }
    let provenance = if ws.mode == "sample" {
        "synthetic"
    } else {
        "manual"
    };
    let mut stmt=ws.db.prepare("SELECT d.search_id,COUNT(*) FROM listing_search_discoveries d JOIN listings l ON l.listing_key=d.listing_key WHERE l.provenance=? GROUP BY d.search_id")?;
    for row in stmt.query_map([provenance], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (id, count) = row?;
        result["counts"][id] = json!(count);
    }
    Ok(result)
}
fn associated(row: &Value, search: &Value) -> bool {
    row["product"] == search["product"]
        && (arr(&row["first_found_runs"]).is_empty()
            || arr(&row["first_found_runs"])
                .iter()
                .any(|r| r["search_id"] == search["id"]))
}
fn feedback_applies(event: &Value, search: &Value) -> bool {
    if event["undone"] == true {
        return false;
    }
    event["scope"] == "global"
        || (event["scope"] == "category" && event["category"] == search["product"])
        || event["search_id"] == search["id"]
}
fn dismissed(row: &Value, search: &Value, config: &Value) -> bool {
    arr(&config["feedback"])
        .iter()
        .rev()
        .find(|e| feedback_applies(e, search) && e["listing_key"] == row["key"])
        .is_some_and(|e| e["action"] == "dismiss")
}
fn model_excluded(row: &Value, search: &Value, config: &Value) -> bool {
    let name = search["discovery"]["model_attribute"]
        .as_str()
        .unwrap_or("model");
    let value = row["attributes"]
        .get(name)
        .filter(|v| !v.is_null())
        .unwrap_or(&row[name]);
    let Some(model) = value.as_str().filter(|v| !v.trim().is_empty()) else {
        return false;
    };
    if !evidence(row, name)
        || Regex::new(r"(?i)\b(unknown|unconfirmed|unidentified|unsure|not known)\b")
            .unwrap()
            .is_match(model)
    {
        return false;
    }
    let identity = crate::searches::canonical_model(value, search);
    arr(&config["feedback"]).iter().any(|event| {
        feedback_applies(event, search)
            && event["rule"]["attribute"] == name
            && event["rule"]["operator"] == "neq"
            && event["rule"]["importance"] == "required"
            && event["rule"]["value"].is_string()
            && crate::searches::canonical_model(&event["rule"]["value"], search) == identity
    })
}

pub fn reading_summary(
    rows: &[Value],
    search: &Value,
    config: &Value,
    last_searched: Option<&str>,
) -> Value {
    let related: Vec<_> = rows
        .iter()
        .filter(|r| {
            associated(r, search)
                && !dismissed(r, search, config)
                && !model_excluded(r, search, config)
        })
        .collect();
    let unseen = related
        .iter()
        .filter(|r| {
            !arr(&r["seen_in_searches"])
                .iter()
                .any(|e| e["search_id"] == search["id"])
        })
        .count();
    let latest = rows
        .iter()
        .filter_map(|r| {
            if let Some(found) = arr(&r["first_found_runs"])
                .iter()
                .find(|e| e["search_id"] == search["id"])
            {
                Some(default(
                    &found["recorded_at"],
                    found["run_started_at"].clone(),
                ))
            } else if arr(&r["first_found_runs"]).is_empty() && r["product"] == search["product"] {
                Some(r["first_observed_at"].clone())
            } else {
                None
            }
        })
        .filter(|v| time(s(v)).is_ok())
        .max_by_key(t);
    json!({"unseen_count":unseen,"seen_count":related.len()-unseen,"last_searched_at":last_searched,"latest_found_at":latest})
}
fn attach_capture(ws: &mut Workspace, input: &Value) -> Result<()> {
    let mut input = input.clone();
    remove(&mut input, "mode");
    let mut capture = contracts::parse("listingMediaInput", &input)?;
    let captured = if truth(&capture["media_capture"]["captured_at"]) {
        time(s(&capture["media_capture"]["captured_at"]))?
    } else {
        ws.now
    };
    if captured > ws.now + 300000 {
        return fail("Media capture time cannot be in the future");
    }
    capture["media_capture"]["captured_at"] = json!(iso(captured));
    for (key, total) in [("photos", "expected_photos"), ("videos", "expected_videos")] {
        let items = arr(&capture[key]);
        let positions: HashSet<_> = items
            .iter()
            .map(|i| i["position"].as_i64().unwrap_or(0))
            .collect();
        let expected = capture["media_capture"][total].as_i64();
        if positions.len() != items.len()
            || positions.iter().any(|p| expected.is_some_and(|e| *p > e))
        {
            return fail("Saved media needs unique positions within the observed gallery total");
        }
        if capture["media_capture"]["status"] == "complete"
            && (expected != Some(items.len() as i64) || capture.get(key).is_none())
        {
            return fail(
                "Complete media capture needs observed totals and every saved photo and video",
            );
        }
    }
    let key = s(&capture["listing_key"]);
    let Some(row) = find(ws, key)? else {
        return fail("Choose a saved listing in this workspace");
    };
    ws.db.execute(
        "INSERT OR IGNORE INTO listing_media_captures VALUES (?,?,?,?)",
        params![hash(&capture), key, iso(captured), capture.to_string()],
    )?;
    let mut rows = vec![row];
    apply_captures(ws, &mut rows)?;
    ws.db.execute(
        "UPDATE listings SET document_json=? WHERE listing_key=?",
        params![rows[0].to_string(), key],
    )?;
    Ok(())
}
fn record_journey(ws: &mut Workspace, input: &Value) -> Result<()> {
    let report = contracts::parse("journeyReportSchema", input)?;
    if ws.config["origin_confirmed"] != true
        || report["origin_key"] != journey_origin_key(&ws.config)
    {
        return fail("The travel origin changed or is unconfirmed. Read the journey queue again.");
    }
    let checked = time(s(&report["checked_at"]))?;
    if checked > ws.now || ws.now - checked >= journey_lifetime(&report["estimate_kind"]) {
        return fail("Use a current journey check with its actual check time.");
    }
    let url = Url::parse(s(&report["source_url"]))
        .map_err(|_| Error::validation("Use the Google Maps directions URL actually checked"))?;
    if url.scheme() != "https"
        || ![
            "google.com",
            "www.google.com",
            "google.co.uk",
            "www.google.co.uk",
        ]
        .contains(&url.host_str().unwrap_or(""))
        || !url.path().starts_with("/maps/dir")
    {
        return fail("Use the Google Maps directions URL actually checked");
    }
    let rows = load(ws)?;
    for key in arr(&report["listing_keys"]) {
        let row = rows.iter().find(|r| r["key"] == *key).ok_or_else(|| {
            Error::validation("The destination must match every saved listing in this route check.")
        })?;
        if destination_key(
            &row["location"],
            &default(&row["country"], ws.config["location"]["country"].clone()),
        ) != destination_key(&report["destination"], &report["country"])
        {
            return fail("The destination must match every saved listing in this route check.");
        }
    }
    let mut estimate = report.clone();
    remove(&mut estimate, "listing_keys");
    estimate["expires_at"] = json!(iso(checked + journey_lifetime(&report["estimate_kind"])));
    ws.db.execute("INSERT INTO journey_estimates (origin_key,destination_key,document_json) VALUES (?,?,?) ON CONFLICT(origin_key,destination_key) DO UPDATE SET document_json=excluded.document_json WHERE julianday(json_extract(excluded.document_json,'$.checked_at'))>=julianday(json_extract(journey_estimates.document_json,'$.checked_at'))",params![s(&report["origin_key"]),destination_key(&report["destination"],&report["country"]),estimate.to_string()])?;
    Ok(())
}
pub fn command(ws: &mut Workspace, action: &str, args: &Value) -> Result<Value> {
    match action {
        "set_listing_seen" => {
            let input = contracts::parse(
                "listingSeenInputSchema",
                &json!({"listings":args["listings"],"seen":default(&args["seen"],json!(true))}),
            )?;
            let rows = load(ws)?;
            for entry in arr(&input["listings"]) {
                let search = arr(&ws.config["searches"])
                    .iter()
                    .find(|s| s["id"] == entry["search_id"]);
                let row = rows.iter().find(|r| r["key"] == entry["listing_key"]);
                if !search.zip(row).is_some_and(|(s, r)| associated(r, s)) {
                    return fail("Choose a listing from this saved search");
                }
            }
            for entry in arr(&input["listings"]) {
                if input["seen"] == true {
                    ws.db.execute("INSERT INTO listing_seen(listing_key,search_id,seen_at) VALUES(?,?,?) ON CONFLICT(listing_key,search_id) DO NOTHING",params![s(&entry["listing_key"]),s(&entry["search_id"]),iso(ws.now)])?;
                } else {
                    ws.db.execute(
                        "DELETE FROM listing_seen WHERE listing_key=? AND search_id=?",
                        params![s(&entry["listing_key"]), s(&entry["search_id"])],
                    )?;
                }
            }
        }
        "attach_listing_media" => {
            crate::media::validate_references(&ws.root, &json!([args]))?;
            attach_capture(ws, args)?;
        }
        "record_journey_check" => record_journey(ws, &args["report"])?,
        "load_sample_workspace" => {
            if ws.mode != "sample" {
                return fail("Sample data must be loaded in sample mode");
            }
            let mut rows: Value = serde_json::from_str(include_str!(
                "../../../skills/marketplace-shopping/assets/demo-listings.json"
            ))?;
            for row in rows.as_array_mut().unwrap() {
                row["drive_origin"] = ws.config["origin"].clone();
                row["travel_checked_at"] = json!(iso(ws.now));
            }
            evaluate(ws, &rows, &Value::Null)?;
        }
        "import_listing_observations" => {
            if ws.mode != "live" {
                return fail("Manual observations must be imported in live mode");
            }
            if let Some(run_id) = args["run_id"].as_str()
                && let Some(check) = crate::searches::scheduled_import_check(ws, run_id)?
            {
                return Ok(json!({"scheduled_check":check}));
            }
            if args["observations"]
                .as_array()
                .is_none_or(|a| a.len() > 500)
            {
                return fail("Import up to 500 observations");
            }
            crate::media::validate_references(&ws.root, &args["observations"])?;
            let rows = normalize_observations(&args["observations"], false, ws.now)?;
            let result = evaluate(ws, &args["observations"], &args["search_coverage"])?;
            if let Some(run_id) = args["run_id"].as_str() {
                let run = crate::searches::find_run(ws, run_id)?.ok_or_else(|| {
                    Error::validation(
                        "Import observations for the current search run and buying brief",
                    )
                })?;
                let search = arr(&ws.config["searches"])
                    .iter()
                    .find(|s| s["id"] == run["search_id"])
                    .ok_or_else(|| {
                        Error::validation(
                            "Import observations for the current search run and buying brief",
                        )
                    })?;
                if run["search_revision"] != hash(search)
                    || rows.iter().any(|r| r["product"] != search["product"])
                {
                    return fail("Import observations for the current search run and buying brief");
                }
                crate::searches::record_import(ws, run_id, &rows, args["worker_id"].as_str())?;
            }
            return Ok(
                json!({"import_receipt":{"evaluation_id":result["evaluation_id"],"observed_count":result["observed_count"]}}),
            );
        }
        _ => return fail(format!("Unsupported listing action: {action}")),
    }
    Ok(json!({}))
}
pub fn insights(
    ws: &Workspace,
    rows: &[Value],
    search: &Value,
    price_pool: &[Value],
) -> Result<Value> {
    let cutoff = ws.now - ws.config["baseline_days"].as_i64().unwrap_or(30) * DAY;
    let eligible = distinct(
        &rows
            .iter()
            .filter(|r| {
                r["product"] == search["product"]
                    && {
                        let stamp = t(&default(
                            &r["last_attempted_at"],
                            r["last_observed_at"].clone(),
                        ));
                        stamp >= cutoff && stamp <= ws.now
                    }
                    && history_cohort(r, search).is_some()
            })
            .cloned()
            .collect::<Vec<_>>(),
    );
    let mut groups: Vec<(String, Vec<Value>)> = vec![];
    for row in eligible {
        if let Some(key) = history_cohort(&row, search) {
            if let Some((_, items)) = groups.iter_mut().find(|(k, _)| k == &key) {
                items.push(row);
            } else {
                groups.push((key, vec![row]));
            }
        }
    }
    let revision = hash(search);
    let mut runs: Vec<_> = documents(
        ws,
        "SELECT document_json FROM search_coverage ORDER BY rowid",
        &[],
    )?
    .into_iter()
    .filter(|r| {
        r["search_id"] == search["id"]
            && r["search_revision"] == revision
            && t(&r["finished_at"]) >= cutoff
            && t(&r["finished_at"]) <= ws.now
    })
    .collect();
    runs.sort_by_key(|r| t(&r["finished_at"]));
    let mut prior = HashMap::<String, Value>::new();
    let mut intervals = Vec::<(String, i64, i64)>::new();
    let max_gap = ws.config["schedule"]["interval_minutes"]
        .as_i64()
        .unwrap_or(60)
        * 120000;
    for run in &runs {
        let key = s(&run["scope_key"]).to_owned();
        if let Some(previous) = prior.get(&key)
            && run["status"] == "success"
            && run["pagination_complete"] == true
            && previous["status"] == "success"
            && previous["pagination_complete"] == true
        {
            let left = t(&previous["finished_at"]);
            let right = t(&run["finished_at"]);
            if right > left && right - left <= max_gap {
                intervals.push((s(&run["source"]).into(), left, right));
            }
        }
        prior.insert(key, run.clone());
    }
    intervals.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut merged = Vec::<(String, i64, i64)>::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && last.0 == interval.0
            && interval.1 <= last.2
        {
            last.2 = last.2.max(interval.2);
            continue;
        }
        merged.push(interval);
    }
    let mut result = Vec::new();
    for (key, members) in groups {
        let first = &members[0];
        let sources: HashSet<_> = members
            .iter()
            .flat_map(|r| {
                if arr(&r["entity_sources"]).is_empty() {
                    vec![s(&r["source"]).to_owned()]
                } else {
                    arr(&r["entity_sources"])
                        .iter()
                        .map(|s| s.as_str().unwrap_or("").to_owned())
                        .collect()
                }
            })
            .collect();
        let coverage = if sources.len() == 1 {
            merged
                .iter()
                .filter(|(source, _, _)| sources.contains(source))
                .map(|(_, l, r)| (r - l) as f64 / DAY as f64)
                .sum::<f64>()
        } else {
            0.
        };
        let mut arrivals = 0;
        let mut dates = Vec::<i64>::new();
        let mut unknown = 0;
        for row in &members {
            let bounds = if quality(row, &ws.config, ws.now, &[])["eligibility"]["arrival_rate"]["eligible"]
                == true
            {
                publication_bounds(row)
            } else {
                None
            };
            if bounds.is_none()
                && truth(&row["first_observed_at"])
                && merged.iter().any(|(source, left, right)| {
                    source == s(&row["source"])
                        && *left < t(&row["first_observed_at"])
                        && t(&row["first_observed_at"]) <= *right
                })
            {
                unknown += 1;
            }
            if let Some((a, b)) = bounds
                && cutoff <= a
                && b <= ws.now
                && merged.iter().any(|(source, left, right)| {
                    source == s(&row["source"]) && *left < a && b <= *right
                })
            {
                arrivals += 1;
                if a == b {
                    dates.push(a);
                }
            }
        }
        dates.sort_unstable();
        let mut gap = median(
            dates
                .windows(2)
                .map(|w| (w[1] - w[0]) as f64 / DAY as f64)
                .collect(),
        );
        if !gap.is_null()
            && (sources.len() != 1
                || !merged
                    .iter()
                    .any(|(_, l, r)| *l <= *dates.first().unwrap() && *dates.last().unwrap() <= *r))
        {
            gap = Value::Null;
        }
        let price_keys: HashSet<_> = price_pool.iter().map(|r| s(&r["key"])).collect();
        let prices: Vec<_> = members
            .iter()
            .filter(|r| price_keys.contains(s(&r["key"])))
            .map(|r| n(&r["price_minor"]))
            .collect();
        let mut completed = Vec::new();
        let mut unfinished = 0;
        for row in &members {
            if quality(row, &ws.config, ws.now, &[])["eligibility"]["duration_analysis"]["eligible"]
                == true
                && !row["duration"]["lower_days"].is_null()
            {
                if row["duration"]["unfinished"] == true {
                    unfinished += 1;
                } else {
                    completed.push(row["duration"].clone());
                }
            }
        }
        let entities: HashSet<_> = members
            .iter()
            .map(|r| s(&default(&r["entity_key"], r["key"].clone())).to_owned())
            .collect();
        let mut keys: Vec<_> = rows
            .iter()
            .filter(|r| {
                entities.contains(s(&default(&r["entity_key"], r["key"].clone())))
                    && history_cohort(r, search) == Some(key.clone())
            })
            .map(|r| r["key"].clone())
            .collect();
        keys.sort_by(|a, b| s(a).cmp(s(b)));
        result.push(json!({"cohort_listing_ids":members.iter().map(|r|r["listing_id"].clone()).collect::<Vec<_>>(),"cohort_listing_keys":keys,"distinct_count":members.len(),"confirmed_active_count":members.iter().filter(|r|quality(r,&ws.config,ws.now,&[])["eligibility"]["current_stock"]["eligible"]==true).count(),"sold_count":members.iter().filter(|r|r["availability"]=="sold").count(),"unknown_outcome_count":members.iter().filter(|r|["unknown","unknown_unavailable"].contains(&s(&r["availability"]))||default(&r["check_outcome"],json!("success"))!="success").count(),"supported_arrivals":arrivals,"coverage_days":round(coverage,4),"publication_unknown_count":unknown,"arrivals_per_day":if coverage>0.&&unknown==0&&members.iter().any(|r|publication_bounds(r).is_some()){json!(round(arrivals as f64/coverage,3))}else{Value::Null},"median_arrival_gap_days":gap,"median_cash_price_minor":median(prices.clone()),"currency":default(&first["currency"],json!("GBP")),"price_period":default(&first["price_period"],json!("once")),"cash_price_sample_count":prices.len(),"window_days":ws.config["baseline_days"],"completed_period_count":completed.len(),"unfinished_period_count":unfinished,"median_completed_lower_days":median(completed.iter().map(|r|n(&r["lower_days"])).collect()),"median_completed_upper_days":median(completed.iter().map(|r|n(&r["upper_days"])).collect()),"successful_query_checks":runs.iter().filter(|r|r["status"]=="success").count(),"note":"Observed sample, not complete inventory. Arrival rates need stable repeated coverage and publication evidence; unseen short-lived ads can be missed."}));
    }
    Ok(json!(result))
}
pub fn media_state(row: &Value, now: i64) -> Value {
    let capture = &row["media_capture"];
    let incomplete = capture.is_null()
        || capture["status"] != "complete"
        || n(&capture["expected_photos"]) > arr(&row["photos"]).len() as f64
        || n(&capture["expected_videos"]) > arr(&row["videos"]).len() as f64;
    let retry = if incomplete && capture["status"] != "complete" && truth(&capture["captured_at"]) {
        Some(t(&capture["captured_at"]) + DAY)
    } else {
        None
    };
    json!({"state":if incomplete{if capture["status"]=="unavailable"{"unavailable"}else{"pending"}}else{"complete"},"retry_at":retry.map(iso),"ready":incomplete&&retry.is_none_or(|r|now>=r)})
}
pub fn journey_queue(rows: &[Value], searches: &[Value], config: &Value, now: i64) -> Vec<Value> {
    if config["journey_checks_enabled"] == false || config["origin_confirmed"] != true {
        return vec![];
    }
    let mut groups = Vec::<(String, Value)>::new();
    for row in rows {
        let related: Vec<_> = searches
            .iter()
            .filter(|search| {
                search["product"] == row["product"]
                    && search["enabled"] == true
                    && arr(&search["definition"]["fields"]).iter().any(|f| {
                        f["match"]["attribute"] == "drive_minutes"
                            && !search["values"][s(&f["id"])].is_null()
                    })
            })
            .collect();
        if related.is_empty()
            || ["sold", "removed"].contains(&s(&row["availability"]))
            || related
                .iter()
                .all(|search| dismissed(row, search, config) || model_excluded(row, search, config))
            || s(&row["location"]).trim().is_empty()
        {
            continue;
        }
        if !row["journey_estimate"].is_null()
            && journey_fresh(&row["journey_estimate"], config, row, now)
        {
            continue;
        }
        if row["journey_estimate"].is_null()
            && !row["drive_minutes"].is_null()
            && row["drive_origin"] == config["origin"]
            && truth(&row["travel_source"])
            && t(&row["travel_checked_at"]) <= now
            && now - t(&row["travel_checked_at"]) < DAY
            && (config["location"]["latitude"].is_null()
                || (row["drive_latitude"] == config["location"]["latitude"]
                    && row["drive_longitude"] == config["location"]["longitude"]))
        {
            continue;
        }
        let country = default(&row["country"], config["location"]["country"].clone());
        let key = destination_key(&row["location"], &country);
        if let Some((_, group)) = groups.iter_mut().find(|(k, _)| k == &key) {
            group["listing_keys"]
                .as_array_mut()
                .unwrap()
                .push(row["key"].clone());
        } else {
            let destination = [s(&row["location"]), s(&country)]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("api", "1")
                .append_pair("origin", s(&config["origin"]))
                .append_pair("destination", &destination)
                .append_pair("travelmode", "driving")
                .finish();
            groups.push((key,json!({"destination":row["location"],"country":country,"listing_keys":[row["key"]],"maps_url":format!("https://www.google.com/maps/dir/?{query}")})));
        }
    }
    groups.into_iter().map(|(_, v)| v).collect()
}
fn seller_matches(row: &Value, filters: &Value, now: i64) -> bool {
    let min = filters["minimum_listings"].as_i64();
    let max = filters["maximum_listings"].as_i64();
    if min.is_some() || max.is_some() {
        let Some(count) = row["seller_listing_count"].as_i64() else {
            return false;
        };
        if !truth(&row["seller_profile_url"])
            || !evidence(row, "seller_listing_count")
            || !fresh(&row["seller_listings_checked_at"], now, 30)
        {
            return false;
        }
        if row["seller_listing_count_precision"] == "exact" {
            if min.is_some_and(|m| count < m) || max.is_some_and(|m| count > m) {
                return false;
            }
        } else if row["seller_listing_count_precision"] == "lower_bound" {
            if max.is_some() || min.is_some_and(|m| count < m) {
                return false;
            }
        } else {
            return false;
        }
    }
    if let Some(year) = filters["joined_by"].as_i64() {
        let value = s(&row["seller_account_joined_at"]);
        if value.len() != 4 && time(&format!("{value}T00:00:00Z")).is_err() {
            return false;
        }
        if value
            .get(..4)
            .and_then(|s| s.parse::<i64>().ok())
            .is_none_or(|y| y > year)
        {
            return false;
        }
    }
    true
}
fn projection(row: &Value, state: &Value, search_id: &Value) -> Value {
    let mut p = json!({});
    for key in [
        "key",
        "title",
        "url",
        "source",
        "price_minor",
        "currency",
        "price_period",
        "product",
        "first_found_runs",
        "seen_in_searches",
        "location",
        "drive_minutes",
        "travel_source",
        "travel_checked_at",
        "availability",
        "chip",
        "ram_gb",
        "ssd_gb",
        "condition",
        "seller_name",
        "seller_account_joined_at",
        "seller_listing_count",
        "seller_listing_count_precision",
        "media_capture",
    ] {
        p[key] = row[key].clone();
    }
    p["first_observed_at"] = default(&row["first_observed_at"], row["observed_at"].clone());
    p["journey_precision"] = row["journey_estimate"]["precision"].clone();
    p["collection_stage"] = default(&row["collection_stage"], json!("verification"));
    p["model"] = row["attributes"]["model"].clone();
    p["saved_photos"] = json!(arr(&row["photos"]).len());
    p["saved_videos"] = json!(arr(&row["videos"]).len());
    p["search_matches"]=json!(arr(&state["decisions"]).iter().filter(|d|d["listing"]["key"]==row["key"]&&(search_id.is_null()||d["search_id"]==*search_id)).map(|d|json!({"search_id":d["search_id"],"status":d["status"],"suitability":d["suitability"],"verification":d["verification"],"value":d["value"],"reasons":d["reasons"]})).collect::<Vec<_>>());
    p
}
pub fn listing_workflow(row: &Value, state: &Value, now: i64, search_id: &Value) -> Value {
    let checks = verification_checks(row, &Value::Null);
    let conflict = checks.iter().any(|c| c["state"] == "conflicting")
        || arr(&row["quality"]["flags"])
            .iter()
            .any(|f| f["code"] == "conflicting_evidence");
    let related: Vec<_> = arr(&state["config"]["searches"])
        .iter()
        .filter(|s| {
            s["product"] == row["product"] && (search_id.is_null() || s["id"] == *search_id)
        })
        .collect();
    let assessment:Vec<_>=related.iter().map(|search|{let decision=arr(&state["decisions"]).iter().find(|d|d["search_id"]==search["id"]&&d["listing"]["key"]==row["key"]).cloned().unwrap_or(Value::Null);json!({"search_id":search["id"],"suitability":default(&decision["suitability"],json!("unevaluated")),"verification":default(&decision["verification"],json!("needs_check")),"value":default(&decision["value"],json!("unknown")),"dismissed":dismissed(row,search,&state["config"]),"reasons":default(&decision["reasons"],json!([])),"checks":verification_checks(row,&search["discovery"]["verification_checks"]),"next_step":arr(&state["next_steps"]).iter().find(|n|n["listing_key"]==row["key"]&&n["search_id"]==search["id"])} )}).collect();
    let guards = json!({"evidence_input":{"message":"Supply newly observed listing evidence.","recovery":"Import an observation with its own fact timestamp; claimed runs also require the current worker_id."},"media_input":{"message":"Supply recovered media and observed gallery totals.","recovery":"Attach media without advancing old fact timestamps or review coverage."},"feedback_input":{"message":"Supply the buyer's feedback and current entity revision.","recovery":"Use the chosen search_id; category/global scope requires the buyer's intent."},"search_input":{"message":"Choose a saved search for this listing.","recovery":"Pass search_id to get_goodfinds_listing for a scoped assessment."}});
    let definitions = vec![
        (
            "observe",
            "import_listing_observations",
            "import_goodfinds_listing_observations",
            vec![
                "observations",
                "request_id",
                "run_id/worker_id (when claimed)",
            ],
            vec!["evidence_input"],
            !conflict,
        ),
        (
            "recover_media",
            "attach_listing_media",
            "attach_goodfinds_listing_media",
            vec!["listing_key", "photos", "videos", "media_capture"],
            vec!["media_input"],
            true,
        ),
        (
            "feedback",
            "record_listing_feedback",
            "record_goodfinds_listing_feedback",
            vec![
                "expected_entity_revision",
                "feedback.search_id",
                "feedback.listing_key",
                "feedback.action",
            ],
            vec!["search_input", "feedback_input"],
            false,
        ),
        (
            "inspect_repairs",
            "list_media_repairs",
            "list_goodfinds_media_repairs",
            vec![],
            vec![],
            false,
        ),
        (
            "inspect_conversation",
            "get_seller_conversation",
            "get_goodfinds_seller_conversation",
            vec!["listing_key"],
            vec![],
            false,
        ),
    ];
    let mut prerequisites = Vec::<Value>::new();
    let mut actions = Vec::new();
    let mut allowed = Vec::new();
    for (event, operation, tool, inputs, codes, collection) in definitions {
        let conditions: Vec<_> = codes
            .iter()
            .map(|c| guards[*c]["recovery"].clone())
            .collect();
        for c in &conditions {
            if !prerequisites.contains(c) {
                prerequisites.push(c.clone());
            }
        }
        let blockers:Vec<_>=codes.iter().filter(|c|event!="feedback"||**c!="search_input"||search_id.is_null()||related.is_empty()).map(|c|json!({"code":c,"message":guards[*c]["message"],"recovery":guards[*c]["recovery"],"kind":"input"})).collect();
        allowed.push(tool);
        actions.push(json!({"event":event,"operation":operation,"tool":tool,"availability":if blockers.is_empty(){"available"}else{"requires_input"},"required_inputs":inputs,"conditions":conditions,"blockers":blockers,"execution":if collection{json!({"profile":"collection","spawn":{"model":"gpt-6-luna","reasoning_effort":"xhigh","fork_turns":"none"}})}else{json!({"profile":"chat","spawn":{}})}}));
    }
    let conversation = arr(&state["seller_conversations"])
        .iter()
        .find(|c| c["listing_key"] == row["key"])
        .cloned()
        .unwrap_or(Value::Null);
    let mut media = media_state(row, now);
    media["image_reviewed"] = default(&row["image_review"]["complete"], json!(false));
    media["video_reviewed"] = default(&row["video_review"]["complete"], json!(false));
    json!({"state":"listing","actions":actions,"allowed_actions":allowed,"prerequisites":prerequisites,"availability":{"state":if ["active","reserved"].contains(&s(&row["availability"])){s(&row["availability"])}else if !truth(&row["availability"])||row["availability"]=="unknown"{"unknown"}else{"unavailable"},"observed":default(&row["availability"],json!("unknown"))},"evidence":{"state":if conflict{"conflicting"}else if row["collection_stage"]=="discovery"{"discovery"}else if checks.iter().any(|c|c["state"]!="confirmed"){"needs_check"}else{"resolved"},"checks":checks,"quality":row["quality"]},"media":media,"assessments":assessment,"conversation_phase":default(&conversation["phase"],json!("not_contacted")),"buying_outcome":default(&conversation["outcome"],json!("open"))})
}
pub const QUERIES: &[&str] = &[
    "list_listings",
    "get_listing",
    "list_media_repairs",
    "list_journey_checks",
];
pub fn query(ws: &Workspace, action: &str, args: &Value, state: &Value) -> Result<Value> {
    let searches: Vec<_> = arr(&ws.config["searches"])
        .iter()
        .filter(|search| args["search_id"].is_null() || search["id"] == args["search_id"])
        .cloned()
        .collect();
    if !args["search_id"].is_null() && searches.is_empty() {
        return fail("Choose a saved search");
    }
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let end = offset.saturating_add(limit);
    if action == "list_journey_checks" {
        let checks = journey_queue(arr(&state["listings"]), &searches, &ws.config, ws.now);
        return Ok(
            json!({"origin_key":journey_origin_key(&ws.config),"enabled":ws.config["journey_checks_enabled"],"origin_confirmed":default(&ws.config["origin_confirmed"],json!(false)),"checks":checks.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":checks.len(),"next_offset":if end<checks.len(){json!(end)}else{Value::Null}}),
        );
    }
    if action == "list_media_repairs" {
        let queue:Vec<_>=arr(&state["listings"]).iter().filter(|row|args["search_id"].is_null()||searches.iter().any(|search|search["product"]==row["product"])).filter_map(|row|{let media=media_state(row,ws.now);if media["state"]=="complete"{None}else{Some(json!({"listing_key":row["key"],"title":row["title"],"url":row["url"],"product":row["product"],"saved_photos":arr(&row["photos"]).len(),"saved_videos":arr(&row["videos"]).len(),"media_capture":row["media_capture"],"retry_at":media["retry_at"],"ready":media["ready"]}))}}).collect();
        return Ok(
            json!({"listings":queue.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":queue.len(),"ready":queue.iter().filter(|r|r["ready"]==true).count(),"next_offset":if end<queue.len(){json!(end)}else{Value::Null}}),
        );
    }
    if action == "get_listing" {
        let mut row = find(ws, s(&args["listing_key"]))?
            .ok_or_else(|| Error::validation("Choose a saved listing"))?;
        row["quality"] = quality(&row, &ws.config, ws.now, &[]);
        return Ok(
            json!({"workflow":listing_workflow(&row,state,ws.now,&args["search_id"]),"listing":row}),
        );
    }
    if action != "list_listings" {
        return fail(format!("Unsupported listing query: {action}"));
    }
    let q = contracts::parse("listingQuerySchema", args)?;
    let filters = &q["seller_filters"];
    if !filters["minimum_listings"].is_null()
        && !filters["maximum_listings"].is_null()
        && n(&filters["minimum_listings"]) > n(&filters["maximum_listings"])
    {
        return fail("Maximum must be at least the minimum.");
    }
    if filters["joined_by"].as_i64().is_some_and(|y| {
        y > Utc
            .timestamp_millis_opt(ws.now)
            .single()
            .map(|d| d.year() as i64)
            .unwrap_or(0)
    }) {
        return fail("Choose a year up to the current year.");
    }
    let decisions: Vec<_> = arr(&state["decisions"])
        .iter()
        .filter(|d| q["search_id"].is_null() || d["search_id"] == q["search_id"])
        .collect();
    let mut selected: Vec<_> = arr(&state["listings"])
        .iter()
        .filter(|row| {
            if !q["search_id"].is_null() && !searches.iter().any(|s| s["product"] == row["product"])
            {
                return false;
            }
            let related: Vec<_> = searches
                .iter()
                .filter(|s| s["product"] == row["product"])
                .collect();
            if q["seen"] != "all" {
                let inbox: Vec<_> = related.iter().filter(|s| associated(row, s)).collect();
                if inbox.is_empty() {
                    return false;
                }
                let unseen = inbox.iter().any(|s| {
                    !arr(&row["seen_in_searches"])
                        .iter()
                        .any(|e| e["search_id"] == s["id"])
                });
                if (q["seen"] == "unseen") != unseen {
                    return false;
                }
            }
            if !seller_matches(row, filters, ws.now) {
                return false;
            }
            if !related.is_empty() {
                if q["include_dismissed"] != true
                    && related.iter().all(|s| dismissed(row, s, &ws.config))
                {
                    return false;
                }
                if q["include_excluded"] != true
                    && related.iter().all(|s| model_excluded(row, s, &ws.config))
                {
                    return false;
                }
            }
            let matches: Vec<_> = decisions
                .iter()
                .filter(|d| d["listing"]["key"] == row["key"])
                .collect();
            if q["result_type"] == "good_deals" {
                return matches.iter().any(|d| d["status"] == "qualifies");
            }
            if q["result_type"] == "promising" {
                return matches.iter().any(|d| {
                    if truth(&d["suitability"]) {
                        d["suitability"] != "unsuitable"
                    } else {
                        ["qualifies", "not_deal", "insufficient_comparables"]
                            .contains(&s(&d["status"]))
                    }
                });
            }
            true
        })
        .collect();
    let preference = |row: &Value| {
        decisions
            .iter()
            .filter(|d| d["listing"]["key"] == row["key"])
            .map(|d| n(&d["preference_score"]))
            .fold(0., f64::max)
    };
    selected.sort_by(|a, b| match s(&q["sort"]) {
        "recommended" => preference(b).total_cmp(&preference(a)),
        "price_low" | "price_high" => {
            if a["price_minor"].is_null() || b["price_minor"].is_null() {
                a["price_minor"].is_null().cmp(&b["price_minor"].is_null())
            } else {
                format!(
                    "{}:{}",
                    s(&a["currency"]),
                    s(&default(&a["price_period"], json!("once")))
                )
                .cmp(&format!(
                    "{}:{}",
                    s(&b["currency"]),
                    s(&default(&b["price_period"], json!("once")))
                ))
                .then_with(|| {
                    if q["sort"] == "price_low" {
                        n(&a["price_minor"]).total_cmp(&n(&b["price_minor"]))
                    } else {
                        n(&b["price_minor"]).total_cmp(&n(&a["price_minor"]))
                    }
                })
            }
        }
        "found_newest" | "found_oldest" => {
            let left = time(s(&default(
                &a["first_observed_at"],
                a["observed_at"].clone(),
            )));
            let right = time(s(&default(
                &b["first_observed_at"],
                b["observed_at"].clone(),
            )));
            match (left, right) {
                (Ok(l), Ok(r)) => {
                    if q["sort"] == "found_newest" {
                        r.cmp(&l)
                    } else {
                        l.cmp(&r)
                    }
                }
                (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            }
            .then_with(|| s(&a["key"]).cmp(s(&b["key"])))
        }
        _ => t(&default(&b["last_observed_at"], b["observed_at"].clone()))
            .cmp(&t(&default(
                &a["last_observed_at"],
                a["observed_at"].clone(),
            )))
            .then_with(|| s(&a["key"]).cmp(s(&b["key"]))),
    });
    let offset = q["offset"].as_u64().unwrap_or(0) as usize;
    let limit = q["limit"].as_u64().unwrap_or(20) as usize;
    let listings: Vec<_> = selected
        .iter()
        .skip(offset)
        .take(limit)
        .map(|r| projection(r, state, &q["search_id"]))
        .collect();
    let next = offset + listings.len();
    Ok(
        json!({"listings":listings,"total":selected.len(),"next_offset":if next<selected.len(){json!(next)}else{Value::Null}}),
    )
}
