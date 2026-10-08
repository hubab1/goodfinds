//! Durable seller protocol. A saved action binds immutable reviewed text; only a
//! current executor may obtain its single send permit. Interrupted sends can
//! only be reconciled, never retried as the same action.
use crate::{
    contracts,
    error::{Error, Result},
    storage::Workspace,
    util,
};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;
use url::Url;

pub const ACTIONS: &[&str] = &[
    "save_collection_plan",
    "prepare_collection_message",
    "get_seller_conversation",
    "save_seller_message_draft",
    "request_seller_action",
    "report_seller_action_handoff",
    "cancel_seller_action",
    "claim_seller_action",
    "issue_message_send_permit",
    "report_seller_action_result",
    "record_user_reported_message",
    "correct_reply_interpretation",
    "set_buying_outcome",
];
const OPS: &[&str] = &[
    "plan", "arrange", "get", "save", "request", "handoff", "cancel", "claim", "prepare",
    "complete", "manual", "correct", "outcome",
];
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn push(v: &mut Value, x: Value) {
    if !v.is_array() {
        *v = json!([])
    }
    v.as_array_mut().unwrap().push(x);
}
fn present(v: &Value) -> bool {
    !v.is_null()
}
fn ts(v: &Value) -> i64 {
    util::time(s(v)).unwrap_or(i64::MIN)
}
fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(Error::validation(message.into()))
}
fn contains(items: &[&str], v: &Value) -> bool {
    items.contains(&s(v))
}
fn model() -> &'static Value {
    static MODEL: OnceLock<Value> = OnceLock::new();
    MODEL.get_or_init(||json!({"guards":contracts::data("sellerGuards"),"events":contracts::data("sellerEvents")}))
}
fn issue(code: &str, input: bool) -> Value {
    let g = &model()["guards"][code];
    json!({"code":code,"message":g["message"],"recovery":g["recovery"],"kind":if input{"input"}else{"blocked"}})
}
fn assert_clear(issues: &[Value]) -> Result<()> {
    if let Some(x) = issues.first() {
        let mut error = Error::validation(s(&x["message"]));
        error.blockers = Some(Box::new(json!(issues)));
        Err(error)
    } else {
        Ok(())
    }
}
fn pending(c: &Value) -> Option<&Value> {
    arr(&c["actions"]).iter().rev().find(|a| {
        contains(
            &[
                "awaiting_handoff",
                "requested",
                "running",
                "ready_to_send",
                "uncertain",
            ],
            &a["status"],
        )
    })
}
fn expired(a: &Value, now: i64) -> Value {
    let mut a = a.clone();
    if contains(&["running", "ready_to_send"], &a["status"])
        && present(&a["lease_expires_at"])
        && ts(&a["lease_expires_at"]) <= now
    {
        a["status"] = json!(if a["kind"] == "send" {
            "uncertain"
        } else {
            "blocked"
        });
        a["reason"] = json!("Execution interrupted or lease expired; verify the thread");
    }
    a
}
fn latest_incoming(c: &Value) -> Option<&Value> {
    arr(&c["messages"])
        .iter()
        .rev()
        .find(|m| m["direction"] == "incoming")
}
fn facebook(v: &str) -> Option<Url> {
    let u = Url::parse(v).ok()?;
    let h = u.host_str()?;
    if u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && (h == "facebook.com" || h.ends_with(".facebook.com"))
    {
        Some(u)
    } else {
        None
    }
}
fn facebook_id(u: &Url) -> Option<&str> {
    let p = u.path();
    let start = p.find("/marketplace/item/")? + 18;
    let id = p[start..].split('/').next()?;
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        Some(id)
    } else {
        None
    }
}
fn same_profile(a: &str, b: &str) -> bool {
    match (facebook(a), facebook(b)) {
        (Some(a), Some(b)) => {
            a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
                && (a.path() != "/profile.php"
                    || a.query_pairs()
                        .find(|(k, _)| k == "id")
                        .map(|(_, v)| v.into_owned())
                        == b.query_pairs()
                            .find(|(k, _)| k == "id")
                            .map(|(_, v)| v.into_owned()))
        }
        _ => false,
    }
}
pub fn same_listing_url(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == "https"
                && b.scheme() == "https"
                && a.username().is_empty()
                && b.username().is_empty()
                && a.password().is_none()
                && b.password().is_none()
                && a.origin() == b.origin()
                && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
        }
        _ => false,
    }
}
fn fresh(report: &Value, now: i64, context: &str) -> bool {
    let t = ts(&report["checked_at"]);
    report["context_id"] == context && t <= now && now.saturating_sub(t) <= 30 * 60_000
}
pub fn access_available(
    reports: &Value,
    browser: &str,
    context: &str,
    now: i64,
    domain: &str,
) -> bool {
    arr(reports).iter().any(|r| {
        r["browser"] == browser
            && r["status"] == "available"
            && fresh(r, now, context)
            && !arr(&r["blocked_domains"])
                .iter()
                .any(|b| s(b) == "*" || domain == s(b) || domain.ends_with(&format!(".{}", s(b))))
    })
}
fn browser(config: &Value, source: &str) -> String {
    let x = s(&config["platforms"][source]["browser"]);
    if !x.is_empty() && x != "default" {
        x.to_string()
    } else {
        s(&config["browser_preference"]).to_string()
    }
}
pub fn contact_eligibility(config: &Value, row: &Value, now: i64, context: &str) -> Value {
    contact(config, row, now, context, "live", None)
}
pub fn contact(
    config: &Value,
    row: &Value,
    now: i64,
    context: &str,
    mode: &str,
    selected: Option<&str>,
) -> Value {
    let source = row["source"].as_str().unwrap_or("facebook_marketplace");
    let mut r = json!({"message":false,"offer":false,"reason":"Contact options need checking","check_needed":true});
    if ![
        "facebook_marketplace",
        "ebay",
        "vinted",
        "gumtree",
        "autotrader",
        "craigslist",
    ]
    .contains(&source)
    {
        r["reason"] = json!("Marketplace is unsupported");
        r["check_needed"] = json!(false);
        return r;
    }
    if row["availability"] != "active" {
        r["reason"] = json!("Recheck listing availability");
        return r;
    }
    if config["platforms"][source]["enabled"] == false {
        r["reason"] = json!("Marketplace is disabled");
        r["check_needed"] = json!(false);
        return r;
    }
    if mode == "sample" {
        r["message"] = json!(source == "facebook_marketplace");
        r["reason"] = json!("Fictional manual practice");
        r["check_needed"] = json!(false);
        return r;
    }
    let b = selected
        .map(str::to_string)
        .unwrap_or_else(|| browser(config, source));
    let Some(o) = arr(&config["listing_contacts"]).iter().rev().find(|o| {
        o["listing_key"] == row["key"] && o["marketplace"] == source && o["browser"] == b
    }) else {
        return r;
    };
    if !fresh(o, now, context) || !same_listing_url(s(&o["listing_url"]), s(&row["url"])) {
        return r;
    }
    r["observation"] = o.clone();
    if o["message"] == "unavailable" && o["offer"] == "unavailable" {
        r["reason"] = json!(if o["external_contact"] == true {
            "Contact is outside the marketplace"
        } else {
            "Seller contact is unavailable"
        });
        r["check_needed"] = json!(false);
        return r;
    }
    let access = json!(
        arr(&config["browser_access"])
            .iter()
            .filter(|a| a["host"] == o["host"] && a["profile"] == o["profile"])
            .cloned()
            .collect::<Vec<_>>()
    );
    let domain = Url::parse(s(&row["url"]))
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    if !access_available(&access, &b, context, now, &domain) {
        r["reason"] = json!("Check access to the selected browser and site");
        return r;
    }
    let session = arr(&config["platform_sessions"]).iter().rev().find(|a| {
        a["marketplace"] == source
            && a["browser"] == b
            && a["host"] == o["host"]
            && a["profile"] == o["profile"]
    });
    let Some(session) = session
        .filter(|a| fresh(a, now, context) && contains(&["signed_in", "signed_out"], &a["status"]))
    else {
        r["reason"] = json!("Verify sign-in in the selected browser profile");
        return r;
    };
    let message = o["message"] == "available"
        && (session["status"] == "signed_in"
            || (!["facebook_marketplace", "craigslist"].contains(&source)
                && o["message_auth"] == "not_required"));
    let offer = o["offer"] == "available"
        && o["offer_limits"]["remaining_offers"] != 0
        && (session["status"] == "signed_in" || o["offer_auth"] == "not_required");
    r["message"] = json!(message);
    r["offer"] = json!(offer);
    r["reason"] = json!(if o["offer_limits"]["remaining_offers"] == 0 {
        "No offers remain for this listing"
    } else if !message && !offer {
        "Verify sign-in or this route's guest access"
    } else {
        ""
    });
    r["check_needed"] = json!(
        o["message"] == "unknown"
            || o["offer"] == "unknown"
            || (o["message"] == "available" && !message)
            || (o["offer"] == "available" && !offer && o["offer_limits"]["remaining_offers"] != 0)
    );
    r
}
fn identity_blockers(c: &Value, a: &Value, identity: &Value) -> Vec<Value> {
    if identity.is_null() {
        return vec![issue("identity_unverified", true)];
    }
    let listing = facebook(s(&identity["listing_url"]));
    if listing.as_ref().and_then(facebook_id) != Some(s(&c["target"]["listing_id"]))
        || identity["listing_id"] != c["target"]["listing_id"]
        || facebook(s(&identity["seller_profile_url"])).is_none()
        || facebook(s(&identity["thread_url"])).is_none()
    {
        return vec![issue("listing_identity", false)];
    }
    if present(&c["target"]["seller_profile_url"])
        && !same_profile(
            s(&c["target"]["seller_profile_url"]),
            s(&identity["seller_profile_url"]),
        )
    {
        return vec![issue("seller_identity", false)];
    }
    let established = arr(&c["actions"])
        .iter()
        .find(|a| present(&a["identity"]))
        .map(|a| &a["identity"])
        .unwrap_or(&Value::Null);
    for e in [established, &a["identity"]] {
        if present(e)
            && (!same_profile(
                s(&e["seller_profile_url"]),
                s(&identity["seller_profile_url"]),
            ) || !same_profile(s(&e["thread_url"]), s(&identity["thread_url"]))
                || ["buyer_identity", "host", "profile"]
                    .iter()
                    .any(|k| e[k] != identity[k]))
        {
            return vec![issue("identity_mismatch", false)];
        }
    }
    vec![]
}
fn route_blockers(ws: &Workspace, c: &Value, a: &Value, identity: &Value) -> Vec<Value> {
    if ws.mode == "sample" {
        return vec![issue("sample_only", false)];
    }
    if c["target"]["source"] != "facebook_marketplace" {
        return vec![issue("manual_only", false)];
    }
    let Some(u) = facebook(s(&c["target"]["url"])) else {
        return vec![issue("identity_mismatch", false)];
    };
    if facebook_id(&u) != Some(s(&c["target"]["listing_id"])) {
        return vec![issue("identity_mismatch", false)];
    }
    if ws.config["platforms"]["facebook_marketplace"]["enabled"] == false {
        return vec![issue("marketplace_disabled", false)];
    }
    if !access_available(
        &ws.config["browser_access"],
        s(&a["browser"]),
        &ws.access_context,
        ws.now,
        u.host_str().unwrap_or(""),
    ) {
        return vec![issue("browser_unverified", false)];
    }
    let row = json!({"key":c["listing_key"],"url":c["target"]["url"],"source":c["target"]["source"],"availability":"active"});
    let contact = contact(
        &ws.config,
        &row,
        ws.now,
        &ws.access_context,
        &ws.mode,
        Some(s(&a["browser"])),
    );
    if contact["message"] != true {
        let mut i = issue("contact_unverified", false);
        if !s(&contact["reason"]).is_empty() {
            i["message"] = contact["reason"].clone()
        }
        return vec![i];
    }
    let o = &contact["observation"];
    let account = arr(&ws.config["platform_sessions"]).iter().rev().find(|r| {
        r["marketplace"] == c["target"]["source"]
            && r["browser"] == a["browser"]
            && r["host"] == o["host"]
            && r["profile"] == o["profile"]
    });
    if account.map(|a| a["status"] != "signed_in").unwrap_or(true) {
        return vec![issue("signin_unverified", false)];
    }
    if present(identity) && (o["host"] != identity["host"] || o["profile"] != identity["profile"]) {
        return vec![issue("profile_mismatch", false)];
    }
    vec![]
}
pub fn collection_expired(collection: &Value, now: i64) -> bool {
    if collection.is_null() {
        return false;
    }
    let Ok(zone) = s(&collection["timezone"]).parse::<Tz>() else {
        return true;
    };
    let Some(time) = DateTime::<Utc>::from_timestamp_millis(now) else {
        return true;
    };
    let local = time.with_timezone(&zone);
    let day = local.format("%Y-%m-%d").to_string();
    let date = s(&collection["date"]);
    if date != day {
        return date < day.as_str();
    }
    if collection["time"].is_null() {
        return false;
    }
    let end = collection["end_time"]
        .as_str()
        .unwrap_or(s(&collection["time"]));
    local.format("%H:%M").to_string().as_str() >= end
}
fn draft_blockers(c: &Value, draft: &Value, row: &Value, now: i64) -> Vec<Value> {
    let mut r = vec![];
    if draft.is_null() {
        r.push(issue("draft_missing", false))
    } else if collection_expired(&draft["collection"], now) {
        r.push(issue("collection_expired", false))
    }
    if row["availability"] != "active" {
        r.push(issue(
            "availability_unchecked",
            row.get("availability").is_none(),
        ))
    }
    if latest_incoming(c).is_some_and(|m| m["id"] != draft["responds_to"]) {
        r.push(issue("reply_unreviewed", false))
    }
    r
}
fn lease_blockers(a: &Value, args: &Value, now: i64) -> Vec<Value> {
    if a["lease_expires_at"].is_null() || ts(&a["lease_expires_at"]) <= now {
        return vec![issue("lease_expired", false)];
    }
    if args.get("lease_token").is_none() {
        return vec![issue("lease_input", true)];
    }
    if a["lease_token"] != args["lease_token"] {
        return vec![issue("lease_expired", false)];
    }
    vec![]
}
fn blockers(
    ws: &Workspace,
    c: &Value,
    event: &str,
    args: &Value,
    row: &Value,
    action: Option<&Value>,
) -> Vec<Value> {
    let mut r = vec![];
    if ["inspect", "handoff", "expire"].contains(&event) {
        return r;
    }
    let mut c = c.clone();
    c["actions"] = json!(
        arr(&c["actions"])
            .iter()
            .map(|a| expired(a, ws.now))
            .collect::<Vec<_>>()
    );
    if [
        "save_draft",
        "collection_plan",
        "arrange",
        "request_send",
        "request_check",
        "outcome",
    ]
    .contains(&event)
    {
        if args.get("expected_version").is_none() {
            r.push(issue("conversation_changed", true))
        } else if args["expected_version"] != c["version"] {
            r.push(issue("conversation_changed", false))
        }
        let p = pending(&c);
        if ["save_draft", "collection_plan"].contains(&event)
            && p.is_some_and(|a| a["kind"] == "send")
        {
            r.push(issue("pending_send", false))
        }
        if ["request_send", "request_check", "arrange", "outcome"].contains(&event) && p.is_some() {
            r.push(issue("pending_action", false))
        }
        if ["request_send", "request_check", "arrange"].contains(&event) && c["outcome"] != "open" {
            r.push(issue("conversation_closed", false))
        }
        if [
            "save_draft",
            "collection_plan",
            "outcome",
            "request_send",
            "request_check",
        ]
        .contains(&event)
            && args["proposed"] != true
        {
            r.push(issue("input_required", true))
        }
        if event == "request_send" {
            r.extend(draft_blockers(&c, &c["draft"], row, ws.now));
            if args["reviewed"] != true {
                r.push(issue("review_required", true))
            }
            if ws.mode != "sample" {
                let source = s(&c["target"]["source"]);
                let b = browser(&ws.config, source);
                let contact = arr(&ws.config["listing_contacts"])
                    .iter()
                    .rev()
                    .find(|x| x["listing_key"] == c["listing_key"] && x["browser"] == b);
                if contact.is_none_or(|x| {
                    !fresh(x, ws.now, &ws.access_context)
                        || !same_listing_url(s(&x["listing_url"]), s(&c["target"]["url"]))
                        || x["marketplace"] != source
                        || x["message"] != "available"
                }) {
                    r.push(issue("contact_unverified", false))
                }
                if ws.config["platforms"][source]["enabled"] == false {
                    r.push(issue("marketplace_disabled", false))
                }
            }
        }
        return r;
    }
    let Some(action) = action.or_else(|| pending(&c)) else {
        return vec![issue("action_unclaimed", false)];
    };
    let a = expired(action, ws.now);
    if event == "cancel" {
        return if contains(&["awaiting_handoff", "requested", "blocked"], &a["status"]) {
            vec![]
        } else {
            vec![issue("uncertain_send", false)]
        };
    }
    if event == "claim" {
        if present(&a["worker_id"])
            && present(&a["lease_expires_at"])
            && ts(&a["lease_expires_at"]) > ws.now
        {
            r.push(issue("executor_active", false))
        }
        r.extend(route_blockers(ws, &c, &a, &args["identity"]));
        if s(&args["worker_id"]).is_empty() {
            r.push(issue("executor_input", true))
        }
    }
    if ["permit", "result"].contains(&event) {
        r.extend(lease_blockers(&a, args, ws.now));
        if event == "permit" {
            if a["kind"] != "send" || a["status"] != "running" {
                r.push(issue("permit_already_issued", false))
            }
            r.extend(route_blockers(ws, &c, &a, &args["identity"]));
            r.extend(identity_blockers(&c, &a, &args["identity"]));
            r.extend(draft_blockers(&c, &a["draft"], row, ws.now));
            if c["outcome"] != "open" {
                r.push(issue("conversation_closed", false))
            }
        } else {
            if !contains(&["running", "ready_to_send", "uncertain"], &a["status"]) {
                r.push(issue("action_unclaimed", false))
            }
            let result = s(&args["result"]);
            if result.is_empty() || s(&args["evidence"]).is_empty() {
                r.push(issue("evidence_required", true))
            }
            if result == "blocked" && a["status"] != "running" {
                r.push(issue("uncertain_send", false))
            }
            if result == "sent"
                && (a["kind"] != "send"
                    || !contains(&["ready_to_send", "uncertain"], &a["status"])
                    || a["draft"].is_null()
                    || !s(&args["evidence"]).contains(s(&a["draft"]["text"])))
            {
                r.push(issue("evidence_required", false))
            }
            if result == "checked" && a["kind"] != "check" {
                r.push(issue("evidence_required", false))
            }
            if ["sent", "checked"].contains(&result)
                || (result == "not_sent" && a["kind"] == "send")
            {
                let identity = if present(&args["identity"]) {
                    &args["identity"]
                } else if result == "sent" {
                    &a["identity"]
                } else {
                    &Value::Null
                };
                r.extend(identity_blockers(&c, &a, identity));
                r.extend(route_blockers(ws, &c, &a, identity))
            }
        }
    }
    r
}
pub fn workflow(ws: &Workspace, c: &Value, row: &Value) -> Value {
    let mut c = c.clone();
    c["actions"] = json!(
        arr(&c["actions"])
            .iter()
            .map(|a| expired(a, ws.now))
            .collect::<Vec<_>>()
    );
    let action = pending(&c).or_else(|| arr(&c["actions"]).last());
    let state = action.map(|a| s(&a["status"])).unwrap_or("idle");
    let mut descriptors = vec![];
    for (event, d) in model()["events"].as_object().unwrap() {
        if d["operation"].is_null() || !arr(&d["from"]).iter().any(|v| v == state) {
            continue;
        }
        let operation = s(&d["operation"]);
        let tool = contracts::all()["operations"][operation]["names"][0]
            .as_str()
            .unwrap_or(operation);
        let issues = blockers(
            ws,
            &c,
            event,
            &json!({"expected_version":c["version"]}),
            row,
            action,
        );
        let blocked = issues.iter().any(|i| i["kind"] == "blocked");
        let profile = if action.is_some_and(|a| a["kind"] == "check")
            && ["claim", "result"].contains(&event.as_str())
        {
            "collection"
        } else {
            d["execution_profile"].as_str().unwrap_or("chat")
        };
        let conditions: Vec<Value> = arr(&d["guards"])
            .iter()
            .map(|k| model()["guards"][s(k)]["recovery"].clone())
            .collect();
        descriptors.push(json!({"event":event,"operation":operation,"tool":tool,"availability":if blocked{"blocked"}else if issues.is_empty(){"available"}else{"requires_input"},"required_inputs":d["inputs"],"conditions":conditions,"blockers":issues,"execution":execution_policy(profile)}));
    }
    let mut allowed = vec![];
    let mut prerequisites = vec![];
    for d in &descriptors {
        if d["availability"] != "blocked" && !allowed.contains(&d["tool"]) {
            allowed.push(d["tool"].clone())
        }
        for x in arr(&d["conditions"])
            .iter()
            .chain(arr(&d["blockers"]).iter().map(|b| &b["recovery"]))
        {
            if !prerequisites.contains(x) {
                prerequisites.push(x.clone())
            }
        }
    }
    json!({"state":state,"actions":descriptors,"allowed_actions":allowed,"prerequisites":prerequisites,"conversation_phase":c["phase"],"buying_outcome":c["outcome"],"action_id":action.map(|a|a["id"].clone()).unwrap_or(Value::Null)})
}
pub fn execution_policy(profile: &str) -> Value {
    if profile == "collection" {
        json!({"profile":"collection","spawn":{"model":"gpt-6-luna","reasoning_effort":"xhigh","fork_turns":"none"}})
    } else {
        json!({"profile":"chat","spawn":{}})
    }
}
fn event(
    c: &mut Value,
    now: i64,
    kind: &str,
    text: &str,
    actor: &str,
    action: Value,
    message: Value,
) {
    push(
        &mut c["events"],
        json!({"id":util::id(),"kind":kind,"text":text,"actor":actor,"action_id":action,"message_id":message,"observed_at":util::iso(now)}),
    )
}
fn classify(c: &mut Value, m: &Value) {
    let f = &m["facets"];
    if f["availability"] == "unavailable" {
        c["outcome"] = json!("unavailable")
    }
    if f["unclear"] == true || contains(&["counter", "firm", "decline"], &f["price"]) {
        c["agreed_price_minor"] = Value::Null
    }
    c["phase"] = if f["unclear"] == true {
        json!("needs_review")
    } else if contains(&["counter", "firm"], &f["price"]) {
        json!(if present(&f["price_minor"]) {
            "counteroffer"
        } else {
            "needs_review"
        })
    } else if f["price"] == "accept" {
        let agreed = if present(&f["price_minor"]) {
            f["price_minor"].clone()
        } else {
            arr(&c["messages"])
                .iter()
                .rev()
                .find(|m| {
                    m["direction"] == "outgoing"
                        && present(&m["draft"])
                        && contains(&["offer", "accept"], &m["draft"]["intent"])
                })
                .map(|m| m["draft"]["price_minor"].clone())
                .unwrap_or(Value::Null)
        };
        if present(&agreed) {
            c["agreed_price_minor"] = agreed;
            json!("accepted")
        } else {
            json!("needs_review")
        }
    } else if f["price"] == "decline" {
        json!("declined")
    } else if f["collection"] != "none" || f["information_request"] == true {
        json!("question")
    } else {
        json!("needs_review")
    };
}
fn facets_evidence(message: &Value) -> Result<()> {
    let f = &message["facets"];
    if f["unclear"] != true
        && (s(&f["supporting_text"]).trim().is_empty()
            || !s(&message["text"]).contains(s(&f["supporting_text"])))
    {
        invalid("Classification needs supporting words from the seller's message")
    } else {
        Ok(())
    }
}
fn empty_facets() -> Value {
    json!({"price":"none","price_minor":null,"availability":"unknown","collection":"none","information_request":false,"unclear":true,"supporting_text":""})
}
fn outgoing(c: &mut Value, a: &mut Value, now: i64, provenance: &str) -> Result<()> {
    if a["draft"].is_null() {
        return invalid("No reviewed message for this action");
    }
    let m = json!({"id":util::id(),"external_id":a["id"],"text":a["draft"]["text"],"platform_at":null,"facets":empty_facets(),"direction":"outgoing","observed_at":util::iso(now),"provenance":provenance,"action_id":a["id"],"draft":a["draft"]});
    if !arr(&c["messages"])
        .iter()
        .any(|m| m["action_id"] == a["id"] && m["direction"] == "outgoing")
    {
        push(&mut c["messages"], m.clone())
    }
    if c["first_sent_at"].is_null() {
        c["first_sent_at"] = json!(util::iso(now))
    }
    c["latest_sent_at"] = json!(util::iso(now));
    match s(&a["draft"]["intent"]) {
        "accept" => {
            c["phase"] = json!("accepted");
            c["agreed_price_minor"] = a["draft"]["price_minor"].clone()
        }
        "decline" => {
            c["phase"] = json!("declined");
            c["agreed_price_minor"] = Value::Null
        }
        _ => {
            c["phase"] = json!("awaiting_reply");
            if a["draft"]["intent"] == "offer" {
                c["agreed_price_minor"] = Value::Null
            }
        }
    }
    a["status"] = json!("sent");
    if a["draft"]["intent"] == "arrange" && present(&c["collection_plan"]) {
        let p = &mut c["collection_plan"];
        let purpose = a["draft"]
            .get("collection_purpose")
            .unwrap_or(&p["purpose"])
            .clone();
        let changed = purpose != p["purpose"] || a["draft"]["collection"] != p["when"];
        p["purpose"] = purpose;
        p["when"] = a["draft"]["collection"].clone();
        if changed || p["status"] == "draft" {
            p["status"] = json!("proposed")
        }
        if changed {
            p["evidence"] = Value::Null;
            p["seller_message_id"] = Value::Null;
            p["provenance"] = json!("user_reported")
        }
    }
    a["confirmed_sent_at"] = json!(util::iso(now));
    a["finished_at"] = json!(util::iso(now));
    event(
        c,
        now,
        if provenance == "browser" {
            "Message confirmed sent"
        } else {
            "Message marked sent by you"
        },
        s(&a["draft"]["text"]),
        if provenance == "browser" {
            "browser"
        } else {
            "user"
        },
        a["id"].clone(),
        m["id"].clone(),
    );
    Ok(())
}
fn empty_conversation(row: &Value, now: i64) -> Value {
    json!({"search_ids":[],"collection_plan":null,"id":util::id(),"listing_key":row["key"],"version":0,"created_at":util::iso(now),"updated_at":util::iso(now),"target":{"listing_id":row["listing_id"],"url":row["url"],"source":row["source"].as_str().unwrap_or("facebook_marketplace"),"title":row["title"],"seller_profile_url":row["seller_profile_url"],"currency":row["currency"].as_str().unwrap_or("GBP"),"price_period":row["price_period"].as_str().unwrap_or("once")},"draft":null,"actions":[],"messages":[],"events":[],"phase":"not_contacted","outcome":"open","agreed_price_minor":null,"first_sent_at":null,"latest_sent_at":null,"latest_incoming_at":null,"last_checked_at":null})
}
pub fn all(ws: &Workspace) -> Result<Vec<Value>> {
    let mut q = ws
        .db
        .prepare("SELECT document_json FROM seller_conversations ORDER BY updated_at DESC")?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = vec![];
    for row in rows {
        out.push(contracts::parse(
            "conversationSchema",
            &serde_json::from_str(&row?)?,
        )?)
    }
    Ok(out)
}
pub fn find(ws: &Workspace, key: &str) -> Result<Option<Value>> {
    let row: Option<String> = ws
        .db
        .query_row(
            "SELECT document_json FROM seller_conversations WHERE listing_key=?",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    row.map(|r| contracts::parse("conversationSchema", &serde_json::from_str(&r)?))
        .transpose()
}
pub fn summaries(ws: &Workspace) -> Result<Vec<Value>> {
    Ok(all(ws)?.iter().map(|c| summary(c, ws.now)).collect())
}
fn save(ws: &Workspace, c: &Value) -> Result<()> {
    ws.db.execute("INSERT INTO seller_conversations(listing_key,document_json,updated_at) VALUES(?,?,?) ON CONFLICT(listing_key) DO UPDATE SET document_json=excluded.document_json,updated_at=excluded.updated_at",params![s(&c["listing_key"]),serde_json::to_string(c)?,s(&c["updated_at"])])?;
    Ok(())
}
pub fn handle(ws: &mut Workspace, operation: &str, input: &Value, row: &Value) -> Result<Value> {
    let args = if operation == "prepare_opening" {
        input.clone()
    } else {
        contracts::parse(&format!("sellerCommands.{operation}"), input)?
    };
    let mut c = find(ws, s(&row["key"]))?.unwrap_or_else(|| empty_conversation(row, ws.now));
    let mut changed = false;
    let mut execution = Value::Null;
    if let Some(i) = arr(&c["actions"]).iter().position(|a| {
        contains(&["running", "ready_to_send"], &a["status"])
            && present(&a["lease_expires_at"])
            && ts(&a["lease_expires_at"]) <= ws.now
    }) {
        let a = expired(&c["actions"][i], ws.now);
        event(
            &mut c,
            ws.now,
            "Action interrupted",
            s(&a["reason"]),
            "browser",
            a["id"].clone(),
            Value::Null,
        );
        c["actions"][i] = a;
        changed = true
    }
    let mut guard = args.clone();
    guard["proposed"] = json!(true);
    guard["reviewed"] = json!(true);
    match operation {
        "get" => {}
        "prepare_opening" => {
            let search = arr(&ws.config["searches"])
                .iter()
                .find(|x| x["id"] == args["search_id"] && x["product"] == row["product"])
                .ok_or_else(|| Error::validation("Choose this listing's saved search"))?;
            if c["draft"].is_null()
                && arr(&c["messages"]).is_empty()
                && arr(&c["actions"]).is_empty()
                && c["outcome"] == "open"
            {
                c["draft"] = opening_draft(row, search);
                add_search(&mut c, search["id"].clone());
                let text = s(&c["draft"]["text"]).to_string();
                event(
                    &mut c,
                    ws.now,
                    "Opening message prepared",
                    &text,
                    "assistant",
                    Value::Null,
                    Value::Null,
                );
                changed = true
            }
        }
        "plan" => {
            assert_clear(&blockers(ws, &c, "collection_plan", &guard, row, None))?;
            let p = &args["plan"];
            validate_plan(p)?;
            if p["provenance"] == "seller_message" {
                let m = arr(&c["messages"])
                    .iter()
                    .find(|m| m["direction"] == "incoming" && m["id"] == p["seller_message_id"]);
                let Some(m) = m.filter(|m| {
                    present(&p["evidence"]) && s(&m["text"]).contains(s(&p["evidence"]))
                }) else {
                    return invalid(
                        "A seller-confirmed plan needs an exact excerpt from the saved reply",
                    );
                };
                if p["status"] == "confirmed"
                    && (m["facets"]["unclear"] == true || m["facets"]["collection"] != "confirmed")
                {
                    return invalid("The saved reply must confirm the collection arrangement");
                }
            }
            c["collection_plan"] = p.clone();
            event(
                &mut c,
                ws.now,
                "Collection plan saved",
                &serde_json::to_string(p)?,
                "user",
                Value::Null,
                Value::Null,
            );
            changed = true
        }
        "arrange" => {
            assert_clear(&blockers(ws, &c, "arrange", &guard, row, None))?;
            let plan = &c["collection_plan"];
            let search = arr(&ws.config["searches"])
                .iter()
                .find(|x| arr(&c["search_ids"]).contains(&x["id"]));
            let mut questions = search.map(|x| buying_questions(row, x)).unwrap_or_default();
            if plan["when"].is_null() {
                questions.push(json!("What date and time would suit you?"))
            }
            if plan["pickup_location"].is_null() {
                questions.push(json!("Where would we meet for the viewing or collection?"))
            } else if plan["status"] != "confirmed" {
                questions.push(json!(format!(
                    "Is {} the right pickup location?",
                    s(&plan["pickup_location"])
                )))
            }
            if present(&plan["demonstration"]) {
                questions.push(json!(format!(
                    "Could you demonstrate {} when I view it?",
                    s(&plan["demonstration"])
                )))
            }
            dedup(&mut questions);
            questions.truncate(30);
            let mut d = json!({"search_id":search.map(|s|s["id"].clone()),"price_minor":c["agreed_price_minor"],"currency":c["target"]["currency"],"price_period":c["target"]["price_period"],"intent":"arrange","collection":plan["when"],"collection_purpose":plan["purpose"].as_str().unwrap_or("collection"),"verification_questions":questions,"responds_to":latest_incoming(&c).map(|m|m["id"].clone()),"text":"Draft"});
            let mut text = offer_message(&d);
            if plan["status"] == "confirmed" && present(&plan["pickup_location"]) {
                text.push_str(&format!(
                    " The agreed pickup location is {}.",
                    s(&plan["pickup_location"])
                ))
            }
            d["text"] = json!(text);
            c["draft"] = d;
            event(
                &mut c,
                ws.now,
                "Collection message prepared",
                &text,
                "assistant",
                Value::Null,
                Value::Null,
            );
            changed = true
        }
        "save" => {
            assert_clear(&blockers(ws, &c, "save_draft", &guard, row, None))?;
            let d = &args["draft"];
            validate_draft(d)?;
            if d["currency"] != c["target"]["currency"]
                || d["price_period"] != c["target"]["price_period"]
            {
                return invalid("Use this listing's currency and price period");
            }
            if present(&d["responds_to"])
                && !arr(&c["messages"])
                    .iter()
                    .any(|m| m["id"] == d["responds_to"] && m["direction"] == "incoming")
            {
                return invalid("The reply being answered no longer exists");
            }
            if present(&d["search_id"]) {
                if !arr(&ws.config["searches"])
                    .iter()
                    .any(|x| x["id"] == d["search_id"] && x["product"] == row["product"])
                {
                    return invalid("Choose a saved search for this item");
                }
                add_search(&mut c, d["search_id"].clone())
            }
            c["draft"] = d.clone();
            event(
                &mut c,
                ws.now,
                "Draft saved",
                s(&d["text"]),
                "user",
                Value::Null,
                Value::Null,
            );
            changed = true
        }
        "request" => {
            if let Some(existing) = arr(&c["actions"])
                .iter()
                .find(|a| a["id"] == args["request_id"])
            {
                if existing["kind"] != args["kind"] {
                    return invalid("Action ID already belongs to another operation");
                }
            } else {
                let send = args["kind"] == "send";
                assert_clear(&blockers(
                    ws,
                    &c,
                    if send {
                        "request_send"
                    } else {
                        "request_check"
                    },
                    &guard,
                    row,
                    None,
                ))?;
                let a = json!({"id":args["request_id"],"kind":args["kind"],"status":"awaiting_handoff","requested_at":util::iso(ws.now),"started_at":null,"confirmed_sent_at":null,"finished_at":null,"browser":browser(&ws.config,row["source"].as_str().unwrap_or("facebook_marketplace")),"manual_only":ws.mode=="sample"||c["target"]["source"]!="facebook_marketplace","worker_id":null,"lease_token":null,"lease_expires_at":null,"draft":if send{c["draft"].clone()}else{Value::Null},"identity":null,"evidence":null,"reason":null});
                let text = if send {
                    s(&c["draft"]["text"])
                } else {
                    "Check this conversation"
                }
                .to_string();
                push(&mut c["actions"], a);
                event(
                    &mut c,
                    ws.now,
                    if send {
                        "Message requested"
                    } else {
                        "Reply check requested"
                    },
                    &text,
                    "user",
                    args["request_id"].clone(),
                    Value::Null,
                );
                changed = true
            }
        }
        "outcome" => {
            assert_clear(&blockers(ws, &c, "outcome", &guard, row, None))?;
            if args["outcome"] == "bought" {
                for id in arr(&args["search_ids"]) {
                    if !arr(&ws.config["searches"])
                        .iter()
                        .any(|x| x["id"] == *id && x["product"] == row["product"])
                    {
                        return invalid("Choose related buying goals to fulfil");
                    }
                    add_search(&mut c, id.clone())
                }
            }
            c["outcome"] = args["outcome"].clone();
            event(
                &mut c,
                ws.now,
                "Outcome recorded",
                s(&args["outcome"]),
                "user",
                Value::Null,
                Value::Null,
            );
            changed = true
        }
        "correct" => {
            check_revision(&c, &args)?;
            let Some(i) = arr(&c["messages"])
                .iter()
                .position(|m| m["id"] == args["message_id"] && m["direction"] == "incoming")
            else {
                return invalid("Choose a seller message");
            };
            let mut m = c["messages"][i].clone();
            facets_evidence(&json!({"text":m["text"],"facets":args["facets"]}))?;
            let outcome_at = arr(&c["events"])
                .iter()
                .rposition(|e| e["kind"] == "Outcome recorded")
                .map(|i| i as i64)
                .unwrap_or(-1);
            let observed_at = arr(&c["events"])
                .iter()
                .position(|e| e["message_id"] == m["id"])
                .map(|i| i as i64)
                .unwrap_or(-1);
            let auto = m["facets"]["availability"] == "unavailable"
                && args["facets"]["availability"] != "unavailable"
                && c["outcome"] == "unavailable"
                && outcome_at < observed_at;
            event(
                &mut c,
                ws.now,
                "Classification corrected",
                &serde_json::to_string(&json!({"previous":m["facets"],"next":args["facets"]}))?,
                "user",
                Value::Null,
                m["id"].clone(),
            );
            m["facets"] = args["facets"].clone();
            c["messages"][i] = m.clone();
            if latest_incoming(&c).is_some_and(|x| x["id"] == m["id"]) {
                if auto {
                    c["outcome"] = json!("open")
                }
                c["agreed_price_minor"] = Value::Null;
                classify(&mut c, &m)
            }
            changed = true
        }
        "manual" => {
            check_revision(&c, &args)?;
            if !arr(&c["messages"]).iter().any(|m| {
                m["external_id"] == args["message"]["external_id"]
                    && m["provenance"] == "user_reported"
            }) {
                if args["direction"] == "outgoing" {
                    let i=arr(&c["actions"]).iter().position(|a|a["id"]==args["action_id"]&&a["kind"]=="send").ok_or_else(||Error::validation("Confirm the exact pending message after the browser action has stopped"))?;
                    let mut a = c["actions"][i].clone();
                    if !contains(
                        &["awaiting_handoff", "requested", "uncertain"],
                        &a["status"],
                    ) || a["draft"]["text"] != args["message"]["text"]
                    {
                        return invalid(
                            "Confirm the exact pending message after the browser action has stopped",
                        );
                    }
                    outgoing(&mut c, &mut a, ws.now, "user_reported")?;
                    c["actions"][i] = a
                } else {
                    facets_evidence(&args["message"])?;
                    let mut m = args["message"].clone();
                    m["id"] = json!(util::id());
                    m["direction"] = json!("incoming");
                    m["observed_at"] = json!(util::iso(ws.now));
                    m["provenance"] = json!("user_reported");
                    m["action_id"] = Value::Null;
                    m["draft"] = Value::Null;
                    push(&mut c["messages"], m.clone());
                    c["latest_incoming_at"] = json!(util::iso(ws.now));
                    classify(&mut c, &m);
                    event(
                        &mut c,
                        ws.now,
                        "Seller reply recorded by you",
                        s(&m["text"]),
                        "user",
                        Value::Null,
                        m["id"].clone(),
                    )
                }
                changed = true
            }
        }
        _ => {
            let i = arr(&c["actions"])
                .iter()
                .position(|a| a["id"] == args["action_id"])
                .ok_or_else(|| Error::validation("This action no longer exists"))?;
            let mut a = c["actions"][i].clone();
            match operation {
                "handoff" => {
                    if a["status"] == "awaiting_handoff" {
                        a["status"] = json!("requested");
                        event(
                            &mut c,
                            ws.now,
                            "Request handed to chat",
                            "Awaiting browser execution",
                            "user",
                            a["id"].clone(),
                            Value::Null,
                        );
                        changed = true
                    }
                }
                "cancel" => {
                    assert_clear(&blockers(ws, &c, "cancel", &guard, row, Some(&a)))?;
                    a["status"] = json!("cancelled");
                    a["finished_at"] = json!(util::iso(ws.now));
                    event(
                        &mut c,
                        ws.now,
                        "Action cancelled",
                        "Cancelled before sending",
                        "user",
                        a["id"].clone(),
                        Value::Null,
                    );
                    changed = true
                }
                "claim" => {
                    if contains(&["sent", "checked", "not_sent", "cancelled"], &a["status"]) {
                        execution = json!({"action_id":a["id"],"lease_token":null,"send_permitted":false,"reconcile_required":false})
                    } else {
                        assert_clear(&blockers(ws, &c, "claim", &guard, row, Some(&a)))?;
                        let reconcile = contains(&["uncertain", "ready_to_send"], &a["status"]);
                        a["worker_id"] = args["worker_id"].clone();
                        if let Some(e) = args.get("execution") {
                            a["execution"] = e.clone()
                        } else {
                            a.as_object_mut().unwrap().remove("execution");
                        }
                        a["lease_token"] = json!(util::id());
                        a["lease_expires_at"] = json!(util::iso(ws.now + 5 * 60_000));
                        if a["started_at"].is_null() {
                            a["started_at"] = json!(util::iso(ws.now))
                        }
                        a["status"] = json!(if reconcile { "uncertain" } else { "running" });
                        a["reason"] = Value::Null;
                        execution = json!({"action_id":a["id"],"lease_token":a["lease_token"],"send_permitted":false,"reconcile_required":reconcile});
                        event(
                            &mut c,
                            ws.now,
                            if reconcile {
                                "Reconciliation started"
                            } else {
                                "Browser action started"
                            },
                            "Thread must be verified before proceeding",
                            "browser",
                            a["id"].clone(),
                            Value::Null,
                        );
                        changed = true
                    }
                }
                "prepare" => {
                    assert_clear(&lease_blockers(&a, &guard, ws.now))?;
                    let readiness = draft_blockers(&c, &a["draft"], row, ws.now);
                    let guards = blockers(ws, &c, "permit", &guard, row, Some(&a));
                    assert_clear(
                        &guards
                            .into_iter()
                            .filter(|i| {
                                !readiness.iter().any(|x| x["code"] == i["code"])
                                    && (readiness.is_empty() || i["code"] != "conversation_closed")
                            })
                            .collect::<Vec<_>>(),
                    )?;
                    if !readiness.is_empty() {
                        a["status"] = json!("blocked");
                        a["reason"] = json!(
                            "Update collection time, review the latest reply or recheck availability before sending"
                        );
                        a["finished_at"] = json!(util::iso(ws.now));
                        event(
                            &mut c,
                            ws.now,
                            "Action paused",
                            s(&a["reason"]),
                            "browser",
                            a["id"].clone(),
                            Value::Null,
                        )
                    } else {
                        a["identity"] = args["identity"].clone();
                        a["status"] = json!("ready_to_send");
                        execution = json!({"action_id":a["id"],"lease_token":a["lease_token"],"send_permitted":true,"reconcile_required":false});
                        event(
                            &mut c,
                            ws.now,
                            "Send permitted",
                            "Approved text and conversation verified",
                            "browser",
                            a["id"].clone(),
                            Value::Null,
                        )
                    }
                    changed = true
                }
                "complete" => {
                    if contains(&["sent", "checked", "not_sent"], &a["status"]) {
                        if a["status"] != args["result"] {
                            return invalid("Action already has a different result");
                        }
                    } else {
                        assert_clear(&blockers(ws, &c, "result", &guard, row, Some(&a)))?;
                        match s(&args["result"]) {
                            "sent" => {
                                let identity = if present(&args["identity"]) {
                                    args["identity"].clone()
                                } else {
                                    a["identity"].clone()
                                };
                                a["identity"] = identity;
                                outgoing(&mut c, &mut a, ws.now, "browser")?
                            }
                            "checked" => {
                                if args["identity"].is_null() {
                                    return invalid("Confirm a reply check in its verified thread");
                                }
                                a["identity"] = args["identity"].clone();
                                for message in arr(&args["messages"]) {
                                    facets_evidence(message)?;
                                    if let Some(duplicate) = arr(&c["messages"]).iter().find(|m| {
                                        m["direction"] == "incoming"
                                            && m["provenance"] == "browser"
                                            && m["external_id"] == message["external_id"]
                                    }) {
                                        if duplicate["text"] != message["text"] {
                                            return invalid(
                                                "Conflicting message identity; inspect the thread again",
                                            );
                                        }
                                        continue;
                                    }
                                    let mut m = message.clone();
                                    m["id"] = json!(util::id());
                                    m["direction"] = json!("incoming");
                                    m["observed_at"] = json!(util::iso(ws.now));
                                    m["provenance"] = json!("browser");
                                    m["action_id"] = a["id"].clone();
                                    m["draft"] = Value::Null;
                                    push(&mut c["messages"], m.clone());
                                    c["latest_incoming_at"] = json!(util::iso(ws.now));
                                    classify(&mut c, &m);
                                    event(
                                        &mut c,
                                        ws.now,
                                        "Seller reply observed",
                                        s(&m["text"]),
                                        "browser",
                                        a["id"].clone(),
                                        m["id"].clone(),
                                    );
                                }
                                c["last_checked_at"] = json!(util::iso(ws.now));
                                a["status"] = json!("checked");
                                event(
                                    &mut c,
                                    ws.now,
                                    "Reply check completed",
                                    if arr(&args["messages"]).is_empty() {
                                        "No new seller reply observed"
                                    } else {
                                        "Seller messages inspected"
                                    },
                                    "browser",
                                    a["id"].clone(),
                                    Value::Null,
                                )
                            }
                            _ => {
                                if args["result"] == "not_sent" && a["kind"] == "send" {
                                    a["identity"] = args["identity"].clone()
                                }
                                a["status"] = args["result"].clone();
                                a["reason"] = args["evidence"].clone();
                                event(
                                    &mut c,
                                    ws.now,
                                    if args["result"] == "uncertain" {
                                        "Send needs verification"
                                    } else {
                                        "Action stopped"
                                    },
                                    s(&args["evidence"]),
                                    "browser",
                                    a["id"].clone(),
                                    Value::Null,
                                )
                            }
                        }
                        a["evidence"] = args["evidence"].clone();
                        a["finished_at"] = json!(util::iso(ws.now));
                        a["lease_expires_at"] = Value::Null;
                        a["lease_token"] = Value::Null;
                        changed = true
                    }
                }
                _ => return invalid("Unsupported seller_conversation action"),
            };
            c["actions"][i] = a;
        }
    }
    if changed {
        if c["phase"] == "accepted" && c["collection_plan"].is_null() {
            let proposed = arr(&c["messages"])
                .iter()
                .rev()
                .find(|m| m["direction"] == "outgoing" && present(&m["draft"]["collection"]))
                .map(|m| m["draft"].clone())
                .unwrap_or(Value::Null);
            c["collection_plan"] = json!({"purpose":proposed["collection_purpose"].as_str().unwrap_or("collection"),"status":if present(&proposed["collection"]){"proposed"}else{"draft"},"when":proposed["collection"],"pickup_location":null,"demonstration":if row["product"]=="espresso_machine"{json!("espresso extraction and, if included, the grinder")}else{Value::Null},"evidence":null,"seller_message_id":null,"provenance":"user_reported"})
        }
        c["version"] = json!(c["version"].as_u64().unwrap_or(0) + 1);
        c["updated_at"] = json!(util::iso(ws.now));
        save(ws, &c)?
    }
    let mut result = json!({"conversation":c});
    if !execution.is_null() {
        result["execution"] = execution
    }
    Ok(result)
}
fn check_revision(c: &Value, a: &Value) -> Result<()> {
    if c["version"] != a["expected_version"] {
        invalid("Conversation changed elsewhere. Refresh it before editing or sending.")
    } else {
        Ok(())
    }
}
fn add_search(c: &mut Value, id: Value) {
    if !arr(&c["search_ids"]).contains(&id) {
        push(&mut c["search_ids"], id)
    }
}
fn dedup(v: &mut Vec<Value>) {
    let mut seen = HashSet::new();
    v.retain(|x| seen.insert(x.to_string()));
}
fn validate_collection(c: &Value) -> Result<()> {
    if c.is_null() {
        return Ok(());
    }
    if s(&c["timezone"]).parse::<Tz>().is_err() {
        return invalid("Choose a valid time zone");
    }
    if present(&c["end_time"]) && (c["time"].is_null() || s(&c["end_time"]) <= s(&c["time"])) {
        return invalid("Collection window must end after it starts");
    }
    Ok(())
}
fn validate_draft(d: &Value) -> Result<()> {
    if contains(&["offer", "accept"], &d["intent"]) && d["price_minor"].is_null() {
        return invalid("Enter an offer price");
    }
    validate_collection(&d["collection"])
}
fn validate_plan(p: &Value) -> Result<()> {
    if p["status"] == "confirmed"
        && (p["when"].is_null() || p["pickup_location"].is_null() || p["evidence"].is_null())
    {
        return invalid("A confirmed plan needs a date, pickup location and supporting evidence");
    }
    validate_collection(&p["when"])
}
pub fn command(ws: &mut Workspace, action: &str, args: &Value) -> Result<Value> {
    let operation = ACTIONS
        .iter()
        .position(|x| *x == action)
        .map(|i| OPS[i])
        .ok_or_else(|| Error::validation("Unknown seller operation"))?;
    if [
        "request_seller_action",
        "claim_seller_action",
        "issue_message_send_permit",
    ]
    .contains(&action)
    {
        let sums = summaries(ws)?;
        let current = sums
            .iter()
            .find(|x| x["listing_key"] == args["listing_key"]);
        let fulfilled = fulfilled_searches(&sums);
        if let Some(c) = current {
            let reconcile =
                action == "claim_seller_action" && c["pending_action"]["status"] == "uncertain";
            let reply = action == "request_seller_action" && args["kind"] == "check";
            if arr(&c["search_ids"])
                .iter()
                .any(|id| fulfilled.contains(s(id)))
                && c["outcome"] != "bought"
                && !reconcile
                && !reply
            {
                return invalid(
                    "This buying goal has been fulfilled. Reopen the purchased conversation before further outreach.",
                );
            }
        }
    }
    let row = crate::listings::find(ws, s(&args["listing_key"]))?
        .ok_or_else(|| Error::validation("Choose a saved listing in this workspace"))?;
    let result = handle(ws, operation, args, &row)?;
    let c = &result["conversation"];
    let mut out = json!({"seller_conversation":c,"seller_workflow":workflow(ws,c,&row)});
    if let Some(e) = result.get("execution") {
        out["execution"] = e.clone()
    }
    Ok(out)
}

pub fn summary(c: &Value, now: i64) -> Value {
    let p = pending(c);
    let expiry =
        p.is_some_and(|a| present(&a["lease_expires_at"]) && ts(&a["lease_expires_at"]) <= now);
    let label = if p.is_some_and(|a| a["kind"] == "send" && (a["status"] == "uncertain" || expiry))
    {
        "Check send"
    } else if let Some(a) = p {
        if a["kind"] == "send" {
            if a["manual_only"] == true {
                "Message ready"
            } else if a["status"] == "awaiting_handoff" {
                "Continue in chat"
            } else {
                "Sending"
            }
        } else if a["status"] == "awaiting_handoff" {
            "Continue in chat"
        } else {
            "Checking replies"
        }
    } else if c["outcome"] != "open" {
        match s(&c["outcome"]) {
            "bought" => "Bought",
            "withdrawn" => "Withdrawn",
            _ => "Unavailable",
        }
    } else if arr(&c["actions"])
        .last()
        .is_some_and(|a| a["status"] == "blocked")
    {
        "Action needed"
    } else {
        match s(&c["phase"]) {
            "not_contacted" => {
                if present(&c["draft"]) {
                    "Draft"
                } else {
                    "Not contacted"
                }
            }
            "awaiting_reply" => "Awaiting reply",
            "question" => "Needs reply",
            "counteroffer" => "Counteroffer",
            "accepted" => "Offer accepted",
            "declined" => "Offer declined",
            _ => "Needs review",
        }
    };
    let action_label = if c["outcome"] != "open" {
        "View history"
    } else if p.is_some() {
        if label == "Check send" {
            "Verify send"
        } else {
            "Continue action"
        }
    } else if c["phase"] == "accepted" {
        if c["collection_plan"]["status"] == "confirmed" {
            "Confirm purchase"
        } else {
            "Arrange collection"
        }
    } else if c["phase"] == "counteroffer" {
        "Review counteroffer"
    } else if contains(&["question", "needs_review"], &c["phase"]) {
        "Review reply"
    } else if c["phase"] == "awaiting_reply" {
        "Check replies"
    } else if present(&c["draft"]) {
        "Review message"
    } else {
        "Prepare message"
    };
    let price = if present(&c["agreed_price_minor"]) {
        c["agreed_price_minor"].clone()
    } else {
        latest_incoming(c)
            .map(|m| &m["facets"]["price_minor"])
            .filter(|v| present(v))
            .unwrap_or(&c["draft"]["price_minor"])
            .clone()
    };
    let mut r = json!({"search_ids":c["search_ids"],"collection_plan":c["collection_plan"],"title":c["target"]["title"],"url":c["target"]["url"],"draft_text":c["draft"]["text"],"verification_questions":c["draft"].get("verification_questions").cloned().unwrap_or(json!([])),"label":label,"action_label":action_label,"price_minor":price,"currency":c["target"]["currency"],"pending_action":p.cloned().unwrap_or(Value::Null)});
    for key in [
        "id",
        "listing_key",
        "version",
        "phase",
        "outcome",
        "agreed_price_minor",
        "first_sent_at",
        "latest_sent_at",
        "latest_incoming_at",
        "last_checked_at",
        "updated_at",
    ] {
        r[key] = c[key].clone()
    }
    r
}
pub fn fulfilled_searches(conversations: &[Value]) -> HashSet<String> {
    conversations
        .iter()
        .filter(|c| c["outcome"] == "bought")
        .flat_map(|c| arr(&c["search_ids"]).iter().map(|v| s(v).to_string()))
        .collect()
}
pub fn buying_questions(row: &Value, search: &Value) -> Vec<Value> {
    let checks =
        crate::listings::verification_checks(row, &search["discovery"]["verification_checks"]);
    let unresolved: Vec<_> = checks
        .iter()
        .filter(|c| contains(&["unknown", "conflicting"], &c["state"]))
        .collect();
    let mut questions = vec![];
    if unresolved.iter().any(|c| {
        contains(
            &[
                "functional",
                "functionality",
                "working",
                "working_condition",
            ],
            &c["id"],
        )
    }) {
        questions.push(json!("Does it all work okay?"))
    } else if unresolved.iter().any(|c| c["id"] == "condition") {
        questions.push(json!("Is it in good condition?"))
    }
    let part = |id: &str| match id {
        "portafilter" => Some("the portafilter"),
        "filter_baskets" => Some("the baskets"),
        "tamper" => Some("the tamper"),
        "water_tank" => Some("the water tank"),
        "charger" => Some("the charger"),
        "power_cable" => Some("the power cable"),
        "remote" => Some("the remote"),
        _ => None,
    };
    let regex=regex::Regex::new(r"(?i)(?:^|[ _])(?:accessories|package_contents|included_parts|completeness|complete)(?:$|[ _])").unwrap();
    let contents: Vec<_> = unresolved
        .into_iter()
        .filter(|c| {
            part(s(&c["id"])).is_some()
                || regex.is_match(&format!("{} {}", s(&c["id"]), s(&c["label"])))
        })
        .collect();
    if !contents.is_empty() {
        questions.push(json!(if contents.len() == 1 {
            part(s(&contents[0]["id"]))
                .map(|p| format!("Does it include {p}?"))
                .unwrap_or_else(|| "Are all the parts and accessories included?".to_string())
        } else {
            "Are all the parts and accessories included?".to_string()
        }))
    }
    questions
}
pub fn search_offer_price(search: &Value, include_target: bool) -> Option<i64> {
    let fields = arr(&search["definition"]["fields"]);
    let values = &search["values"];
    if include_target
        && let Some(f) = fields.iter().find(|f| {
            f["id"] == "target_price_minor"
                && crate::searches::is_visible(f, values, &search["definition"])
        })
        && let Some(n) = values[s(&f["id"])].as_i64().filter(|n| *n > 0)
    {
        return Some(n);
    }
    fields
        .iter()
        .filter(|f| {
            f["match"]["attribute"] == "price_minor"
                && f["match"]["importance"] == "required"
                && crate::searches::is_visible(f, values, &search["definition"])
        })
        .filter_map(|f| {
            let v = &values[s(&f["id"])];
            match s(&f["match"]["operator"]) {
                "lte" => v.as_i64(),
                "range" => v["max"].as_i64(),
                _ => None,
            }
            .filter(|n| *n > 0)
        })
        .min()
}
pub fn opening_draft(row: &Value, search: &Value) -> Value {
    let asking = row["price_minor"].as_i64();
    let currency = row["currency"].as_str().unwrap_or("GBP");
    let period = row["price_period"].as_str().unwrap_or("once");
    let target = search_offer_price(search, true);
    let proposed = if search["definition"]["price"]["currency"] != currency
        || search["definition"]["price"]["period"] != period
    {
        asking
    } else {
        match (asking, target) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    };
    let firm = regex::Regex::new(r"(?i)\b(price (?:is )?firm|no offers|non[- ]negotiable)\b")
        .unwrap()
        .is_match(s(&row["description"]));
    let price = match (proposed, asking) {
        (Some(p), Some(a)) if p < a && !firm => Some(p),
        _ => None,
    };
    let mut d = json!({"search_id":search["id"],"price_minor":price,"currency":currency,"price_period":period,"intent":if price.is_some(){"offer"}else{"message"},"collection":null,"responds_to":null,"verification_questions":buying_questions(row,search),"text":"Draft"});
    d["text"] = json!(offer_message(&d));
    d
}
// Small locale data replaces the JavaScript Intl runtime for generated seller
// wording. Unknown ISO-shaped codes retain the standard code-and-space form.
pub fn currency_text(minor: i64, currency: &str) -> String {
    static FORMATS: OnceLock<Value> = OnceLock::new();
    let formats = FORMATS.get_or_init(|| {
        serde_json::from_str(include_str!("currency_formats.json")).expect("currency formats")
    });
    let precision = formats[currency]["digits"].as_u64().unwrap_or(2) as u32;
    let divisor = 10_i64.pow(precision);
    let digits = (minor / divisor).to_string();
    let mut whole = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            whole.push(',')
        }
        whole.push(c)
    }
    let number = if precision == 0 {
        whole
    } else {
        format!(
            "{whole}.{:0width$}",
            minor % divisor,
            width = precision as usize
        )
    };
    let prefix = formats[currency]["prefix"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{currency}\u{a0}"));
    format!("{prefix}{number}")
}

pub fn offer_message(d: &Value) -> String {
    let mut questions = arr(&d["verification_questions"]).to_vec();
    dedup(&mut questions);
    let price = d["price_minor"]
        .as_i64()
        .map(|p| currency_text(p, s(&d["currency"])))
        .unwrap_or_default();
    let period = match s(&d["price_period"]) {
        "month" => " per month",
        "week" => " per week",
        _ => "",
    };
    let intent = s(&d["intent"]);
    let viewing = d["collection_purpose"] == "viewing";
    let mut message = match intent {
        "arrange" => format!(
            "Thanks, could we arrange {}?",
            if viewing { "a viewing" } else { "collection" }
        ),
        "accept" => format!(
            "Thanks, {price}{period} works for me{}.",
            if questions.is_empty() {
                ""
            } else {
                ", subject to confirming the details below"
            }
        ),
        "decline" => "Thanks for getting back to me. I'll leave it for now.".to_string(),
        "message" => "Hi, is this still available?".to_string(),
        _ => {
            if d["price_minor"].is_null() {
                "Hi, is this still available?".to_string()
            } else {
                format!("Hi, would you consider {price}{period}?")
            }
        }
    };
    if !questions.is_empty() && intent != "decline" {
        message.push(' ');
        message.push_str(&questions.iter().map(s).collect::<Vec<_>>().join(" "))
    }
    if present(&d["collection"]) && ["accept", "arrange"].contains(&intent) {
        let c = &d["collection"];
        if let Ok(date) = chrono::NaiveDate::parse_from_str(s(&c["date"]), "%Y-%m-%d") {
            let day = date.format("%A %-d %B");
            let clock = if let Some(time) = c["time"].as_str() {
                if let Some(end) = c["end_time"].as_str() {
                    format!(" between {time} and {end}")
                } else {
                    format!(" around {time}")
                }
            } else {
                String::new()
            };
            message.push_str(&format!(
                " {} {} on {day}{clock}, if that suits you.",
                if questions.is_empty() {
                    "I can"
                } else {
                    "If those details check out, I can"
                },
                if viewing { "view it" } else { "collect" }
            ));
        }
    }
    message
}
pub fn recommendations(
    state: &Value,
    search_id: Option<&str>,
    keys: Option<&[Value]>,
) -> Vec<Value> {
    let fulfilled = fulfilled_searches(arr(&state["seller_conversations"]));
    let searches = arr(&state["searches"]);
    let mut candidates: Vec<&Value> = arr(&state["decisions"])
        .iter()
        .filter(|d| {
            let row = &d["listing"];
            let Some(search) = searches.iter().find(|x| x["id"] == d["search_id"]) else {
                return false;
            };
            if fulfilled.contains(s(&search["id"]))
                || search_id.is_some_and(|id| search["id"] != id)
                || keys.is_some_and(|keys| !keys.contains(&row["key"]))
            {
                return false;
            }
            if search["enabled"] != true
                && !arr(&state["search_runs"]).iter().any(|r| {
                    r["search_id"] == search["id"]
                        && arr(&r["listing_keys"]).contains(&row["key"])
                        && contains(&["completed", "partial"], &r["phase"])
                })
            {
                return false;
            }
            let conversation = arr(&state["seller_conversations"])
                .iter()
                .find(|c| c["listing_key"] == row["key"]);
            row["availability"] == "active"
                && (row["check_outcome"].is_null() || row["check_outcome"] == "success")
                && (if present(&d["suitability"]) {
                    d["suitability"] != "unsuitable"
                } else {
                    contains(
                        &["qualifies", "not_deal", "insufficient_comparables"],
                        &d["status"],
                    )
                })
                && conversation.is_none_or(|c| c["outcome"] == "open")
                && arr(&state["config"]["feedback"])
                    .iter()
                    .rev()
                    .find(|f| f["search_id"] == search["id"] && f["listing_key"] == row["key"])
                    .is_none_or(|f| f["action"] != "dismiss")
        })
        .collect();
    candidates.sort_by(|a, b| {
        (b["suitability"] == "suitable")
            .cmp(&(a["suitability"] == "suitable"))
            .then_with(|| {
                b["preference_score"]
                    .as_f64()
                    .unwrap_or(0.0)
                    .total_cmp(&a["preference_score"].as_f64().unwrap_or(0.0))
            })
            .then_with(|| (b["verification"] == "complete").cmp(&(a["verification"] == "complete")))
            .then_with(|| {
                a["setup_total_minor"]
                    .as_i64()
                    .or_else(|| a["listing"]["price_minor"].as_i64())
                    .unwrap_or(i64::MAX)
                    .cmp(
                        &b["setup_total_minor"]
                            .as_i64()
                            .or_else(|| b["listing"]["price_minor"].as_i64())
                            .unwrap_or(i64::MAX),
                    )
            })
            .then_with(|| s(&a["listing"]["key"]).cmp(s(&b["listing"]["key"])))
    });
    let mut seen = HashSet::new();
    candidates.into_iter().filter(|d|seen.insert(s(&d["listing"]["key"]).to_string())).take(3).map(|d|{let row=&d["listing"];let search=searches.iter().find(|x|x["id"]==d["search_id"]).unwrap();let questions=buying_questions(row,search);let ready=d["suitability"]=="suitable"&&d["verification"]=="complete"&&questions.is_empty();let price=opening_draft(row,search)["price_minor"].clone();json!({"asking_price_minor":row["price_minor"],"proposed_price_minor":price,"agreed_price_minor":null,"currency":row["currency"].as_str().unwrap_or("GBP"),"listing_key":row["key"],"search_id":search["id"],"title":row["title"],"url":row["url"],"label":if ready{if price.is_null(){"Review message"}else{"Review offer"}}else{"Verify details"},"readiness":if ready{"ready_to_offer"}else{"verify_and_negotiate"},"reasons":d["reasons"],"questions":questions,"draft_text":null,"priority":4})}).collect()
}
pub fn next_steps(state: &Value) -> Value {
    let fulfilled = fulfilled_searches(arr(&state["seller_conversations"]));
    let mut items:Vec<Value>=arr(&state["seller_conversations"]).iter().filter(|c|c["outcome"]=="open"&&(!arr(&c["search_ids"]).iter().any(|id|fulfilled.contains(s(id)))||c["pending_action"]["status"]=="uncertain")&&(present(&c["draft_text"])||present(&c["first_sent_at"])||present(&c["pending_action"]))).map(|c|{let first=present(&c["first_sent_at"]);let related=|d:&&Value|d["listing"]["key"]==c["listing_key"]&&arr(&c["search_ids"]).contains(&d["search_id"]);let decision=arr(&state["decisions"]).iter().find(related);let mut reasons=vec![c["label"].clone()];if !first&&let Some(d)=decision{reasons.extend_from_slice(arr(&d["reasons"]))}let verify=!first&&(!arr(&c["verification_questions"]).is_empty()||arr(&state["decisions"]).iter().filter(related).any(|d|d["verification"]!="complete"));json!({"asking_price_minor":arr(&state["decisions"]).iter().find(|d|d["listing"]["key"]==c["listing_key"]).map(|d|d["listing"]["price_minor"].clone()).unwrap_or(Value::Null),"proposed_price_minor":if c["phase"]=="accepted"{Value::Null}else{c["price_minor"].clone()},"agreed_price_minor":c["agreed_price_minor"],"currency":c["currency"],"listing_key":c["listing_key"],"search_id":arr(&c["search_ids"]).first().cloned().unwrap_or(Value::Null),"title":c["title"],"url":c["url"],"label":c["action_label"],"readiness":if verify{"verify_and_negotiate"}else{"conversation"},"reasons":reasons,"questions":c["verification_questions"],"draft_text":c["draft_text"],"priority":if contains(&["Check send","Action needed"],&c["label"]){0}else if contains(&["Counteroffer","Needs reply","Needs review"],&c["label"]){1}else if c["phase"]=="accepted"{2}else if first{5}else{3}})}).collect();
    let mut seen: HashSet<String> = items
        .iter()
        .map(|c| s(&c["listing_key"]).to_string())
        .collect();
    for item in recommendations(state, None, None) {
        if seen.insert(s(&item["listing_key"]).to_string()) {
            items.push(item)
        }
    }
    items.sort_by(|a, b| {
        a["priority"]
            .as_i64()
            .cmp(&b["priority"].as_i64())
            .then_with(|| s(&a["title"]).cmp(s(&b["title"])))
    });
    json!(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _dir: tempfile::TempDir,
        ws: Workspace,
        row: Value,
        identity: Value,
        draft: Value,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mut ws = Workspace::open(dir.path(), "live", "seller-test-context").unwrap();
            ws.now = util::time("2026-10-04T14:00:00Z").unwrap();
            let row = json!({"key":"facebook_marketplace:123456789012345","listing_id":"123456789012345","title":"Fictional monitor","url":"https://www.facebook.com/marketplace/item/123456789012345/","source":"facebook_marketplace","product":"mac_mini","currency":"GBP","price_period":"once","price_minor":20000,"availability":"active","seller_profile_url":"https://www.facebook.com/marketplace/profile/12345/"});
            let stamp = util::iso(ws.now);
            let ctx = ws.access_context.clone();
            ws.config["browser_access"] = json!([{"browser":"in_app","browser_id":"iab","status":"available","host":"Codex","profile":"Test profile","evidence":"Simulated browser access","blocked_domains":[],"checked_at":stamp,"context_id":ctx}]);
            ws.config["platform_sessions"] = json!([{"marketplace":"facebook_marketplace","browser":"in_app","browser_id":"iab","host":"Codex","profile":"Test profile","status":"signed_in","evidence":"Simulated buyer account","checked_at":stamp,"context_id":ctx}]);
            ws.config["listing_contacts"] = json!([{"listing_key":row["key"],"listing_url":row["url"],"marketplace":"facebook_marketplace","browser":"in_app","host":"Codex","profile":"Test profile","message":"available","offer":"unavailable","external_contact":false,"evidence":"Simulated message interface","checked_at":stamp,"context_id":ctx}]);
            let identity = json!({"listing_url":row["url"],"listing_id":row["listing_id"],"seller_profile_url":row["seller_profile_url"],"buyer_identity":"Test buyer","thread_url":"https://www.facebook.com/messages/t/123456/","host":"Codex","profile":"Test profile","evidence":"Simulated exact identity"});
            let draft = json!({"price_minor":18000,"currency":"GBP","price_period":"once","collection":null,"text":"Hi, would you consider £180 for the monitor?","intent":"offer","responds_to":null});
            Self {
                _dir: dir,
                ws,
                row,
                identity,
                draft,
            }
        }
        fn call(&mut self, op: &str, mut args: Value) -> Result<Value> {
            args["mode"] = json!(self.ws.mode);
            args["listing_key"] = self.row["key"].clone();
            self.ws.db.execute_batch("BEGIN IMMEDIATE").unwrap();
            let result = handle(&mut self.ws, op, &args, &self.row);
            self.ws
                .db
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .unwrap();
            result
        }
        fn conversation(&mut self) -> Value {
            self.call("get", json!({})).unwrap()["conversation"].clone()
        }
        fn request(&mut self, kind: &str) -> Value {
            let mut c = self.conversation();
            if kind == "send" {
                c = self
                    .call(
                        "save",
                        json!({"expected_version":c["version"],"draft":self.draft}),
                    )
                    .unwrap()["conversation"]
                    .clone()
            }
            let r = self
                .call(
                    "request",
                    json!({"expected_version":c["version"],"request_id":util::id(),"kind":kind}),
                )
                .unwrap();
            arr(&r["conversation"]["actions"]).last().unwrap().clone()
        }
        fn claim(&mut self, a: &Value) -> Value {
            self.call(
                "claim",
                json!({"action_id":a["id"],"worker_id":"native-worker"}),
            )
            .unwrap()["execution"]["lease_token"]
                .clone()
        }
        fn permit(&mut self, a: &Value, token: &Value) -> Result<Value> {
            self.call(
                "prepare",
                json!({"action_id":a["id"],"lease_token":token,"identity":self.identity}),
            )
        }
    }
    #[test]
    fn reviewed_send_is_immutable_one_use_and_exact() {
        let mut f = Fixture::new();
        let a = f.request("send");
        let version = f.conversation()["version"].clone();
        let mut other = f.draft.clone();
        other["text"] = json!("Changed wording");
        assert!(
            f.call("save", json!({"expected_version":version,"draft":other}))
                .is_err()
        );
        let token = f.claim(&a);
        let r = f.permit(&a, &token).unwrap();
        assert_eq!(r["execution"]["send_permitted"], true);
        assert!(f.permit(&a, &token).is_err());
        assert!(f.call("complete",json!({"action_id":a["id"],"lease_token":token,"result":"sent","evidence":"Some other message"})).is_err());
        let args = json!({"action_id":a["id"],"lease_token":token,"result":"sent","evidence":format!("Outgoing bubble: {}",s(&f.draft["text"]))});
        let r = f.call("complete", args.clone()).unwrap();
        assert_eq!(r["conversation"]["messages"][0]["provenance"], "browser");
        assert_eq!(r["conversation"]["phase"], "awaiting_reply");
        let version = r["conversation"]["version"].clone();
        let replay = f.call("complete", args).unwrap();
        assert_eq!(replay["conversation"]["version"], version);
        assert_eq!(arr(&replay["conversation"]["messages"]).len(), 1);
    }
    #[test]
    fn expired_executor_can_reconcile_but_never_resend() {
        let mut f = Fixture::new();
        let a = f.request("send");
        let old = f.claim(&a);
        f.permit(&a, &old).unwrap();
        f.ws.now += 5 * 60_000 + 1;
        let c = f.conversation();
        assert_eq!(c["actions"][0]["status"], "uncertain");
        assert!(f.call("cancel", json!({"action_id":a["id"]})).is_err());
        let claimed = f
            .call(
                "claim",
                json!({"action_id":a["id"],"worker_id":"reconcile-worker"}),
            )
            .unwrap();
        assert_eq!(claimed["execution"]["reconcile_required"], true);
        assert_eq!(claimed["execution"]["send_permitted"], false);
        let token = &claimed["execution"]["lease_token"];
        assert!(f.permit(&a, token).is_err());
        assert!(f.call("complete",json!({"action_id":a["id"],"lease_token":old,"result":"not_sent","evidence":"Verified absent","identity":f.identity})).is_err());
        let r=f.call("complete",json!({"action_id":a["id"],"lease_token":token,"result":"not_sent","evidence":"Verified no outgoing message","identity":f.identity})).unwrap();
        assert_eq!(r["conversation"]["actions"][0]["status"], "not_sent");
        let next = f.request("send");
        assert_ne!(next["id"], a["id"]);
    }
    #[test]
    fn reconciliation_rejects_wrong_profile_and_accepts_exact_saved_message() {
        let mut f = Fixture::new();
        let a = f.request("send");
        let token = f.claim(&a);
        f.permit(&a, &token).unwrap();
        f.call("complete",json!({"action_id":a["id"],"lease_token":token,"result":"uncertain","evidence":"Browser interrupted after click"})).unwrap();
        let token = f.claim(&a);
        let mut wrong = f.identity.clone();
        wrong["profile"] = json!("Other profile");
        let mut args = json!({"action_id":a["id"],"lease_token":token,"result":"sent","identity":wrong,"evidence":format!("Observed {}",s(&f.draft["text"]))});
        assert!(f.call("complete", args.clone()).is_err());
        args["identity"] = f.identity.clone();
        assert_eq!(
            f.call("complete", args).unwrap()["conversation"]["actions"][0]["status"],
            "sent"
        );
    }
    #[test]
    fn sample_and_stale_signed_out_profiles_never_claim() {
        let mut f = Fixture::new();
        let a = f.request("send");
        f.ws.config["platform_sessions"][0]["status"] = json!("signed_out");
        assert!(
            f.call("claim", json!({"action_id":a["id"],"worker_id":"worker"}))
                .is_err()
        );
        f.ws.config["platform_sessions"][0]["status"] = json!("signed_in");
        f.ws.now += 31 * 60_000;
        assert!(
            f.call("claim", json!({"action_id":a["id"],"worker_id":"worker"}))
                .is_err()
        );
        f.ws.mode = "sample".into();
        assert!(
            f.call("claim", json!({"action_id":a["id"],"worker_id":"worker"}))
                .is_err()
        );
    }
    #[test]
    fn changed_reply_pauses_action_before_permit() {
        let mut f = Fixture::new();
        let a = f.request("send");
        let token = f.claim(&a);
        let c = f.conversation();
        let mut facets = empty_facets();
        facets["unclear"] = json!(false);
        facets["price"] = json!("firm");
        facets["price_minor"] = json!(20000);
        facets["supporting_text"] = json!("Price is firm");
        f.call("manual",json!({"expected_version":c["version"],"direction":"incoming","message":{"external_id":"reply-1","text":"Price is firm","platform_at":null,"facets":facets}})).unwrap();
        let r = f.permit(&a, &token).unwrap();
        assert!(r.get("execution").is_none());
        assert_eq!(r["conversation"]["actions"][0]["status"], "blocked");
        assert_eq!(r["conversation"]["phase"], "counteroffer");
    }
    #[test]
    fn checked_replies_keep_evidence_and_deduplicate() {
        let mut f = Fixture::new();
        let a = f.request("check");
        let token = f.claim(&a);
        let mut facets = empty_facets();
        facets["unclear"] = json!(false);
        facets["price"] = json!("counter");
        facets["price_minor"] = json!(19000);
        facets["collection"] = json!("proposal");
        facets["supporting_text"] = json!("£190 tomorrow");
        let message = json!({"external_id":"platform-message-1","text":"I can do £190 tomorrow","platform_at":null,"facets":facets});
        let r=f.call("complete",json!({"action_id":a["id"],"lease_token":token,"result":"checked","evidence":"Observed exact reply","identity":f.identity,"messages":[message.clone(),message]})).unwrap();
        assert_eq!(arr(&r["conversation"]["messages"]).len(), 1);
        assert_eq!(r["conversation"]["phase"], "counteroffer");
        assert_eq!(
            r["conversation"]["messages"][0]["facets"]["collection"],
            "proposal"
        );
        let a = f.request("check");
        let token = f.claim(&a);
        f.call("complete",json!({"action_id":a["id"],"lease_token":token,"result":"checked","evidence":"No new reply","identity":f.identity,"messages":[]})).unwrap();
        assert_eq!(f.conversation()["phase"], "counteroffer");
    }
    #[test]
    fn collection_confirmation_requires_saved_exact_seller_evidence() {
        let mut f = Fixture::new();
        let c = f.conversation();
        let plan = json!({"purpose":"collection","status":"confirmed","when":{"date":"2026-10-10","time":"14:00","end_time":null,"timezone":"Europe/London"},"pickup_location":"Example pickup","demonstration":null,"evidence":"See you there","seller_message_id":"missing","provenance":"seller_message"});
        assert!(
            f.call("plan", json!({"expected_version":c["version"],"plan":plan}))
                .is_err()
        );
        assert!(collection_expired(
            &json!({"date":"2026-10-04","time":"15:00","end_time":null,"timezone":"Europe/London"}),
            f.ws.now
        ));
        assert!(!collection_expired(
            &json!({"date":"2026-10-04","time":"14:00","end_time":"16:00","timezone":"Europe/London"}),
            f.ws.now
        ));
    }
    #[test]
    fn summaries_and_descriptors_never_issue_execution_permits() {
        let mut f = Fixture::new();
        let a = f.request("send");
        let token = f.claim(&a);
        f.permit(&a, &token).unwrap();
        let c = f.conversation();
        let w = workflow(&f.ws, &c, &f.row);
        let permit = arr(&w["actions"])
            .iter()
            .find(|a| a["event"] == "permit")
            .unwrap();
        assert_eq!(permit["availability"], "blocked");
        assert!(w.get("execution").is_none());
        assert_eq!(summary(&c, f.ws.now)["label"], "Sending");
        f.ws.now += 6 * 60_000;
        assert_eq!(summary(&c, f.ws.now)["label"], "Check send");
    }
    #[test]
    fn all_5280_legacy_guard_decisions_match_native_protocol() {
        let corpus: Value =
            serde_json::from_str(include_str!("seller_parity_fixture.json")).unwrap();
        let mut f = Fixture::new();
        f.ws.now = corpus["now"].as_i64().unwrap();
        f.ws.access_context = s(&corpus["context_id"]).to_string();
        for case in arr(&corpus["cases"]) {
            let status = s(&case[0]);
            let variant = &corpus["variants"][case[3].as_u64().unwrap() as usize];
            f.ws.config = corpus["config"].clone();
            if variant["routeValid"] == false {
                f.ws.config["platforms"]["facebook_marketplace"] =
                    json!({"enabled":false,"browser":"default"})
            }
            let mut c = corpus["conversation"].clone();
            let mut a = c["actions"][0].clone();
            a["status"] = case[0].clone();
            a["kind"] = case[1].clone();
            a["worker_id"] = if case[2].is_null() {
                Value::Null
            } else {
                json!("worker")
            };
            a["lease_token"] = if case[2].is_null() {
                Value::Null
            } else {
                json!("lease")
            };
            a["lease_expires_at"] = case[2]
                .as_i64()
                .map(util::iso)
                .map(Value::String)
                .unwrap_or(Value::Null);
            a = expired(&a, f.ws.now);
            c["actions"] = json!([a]);
            if variant["conversationOpen"] == false {
                c["outcome"] = json!("bought")
            }
            let mut identity = corpus["identity"].clone();
            if variant["identityValid"] == false {
                identity["listing_id"] = json!("wrong")
            }
            let mut args = json!({"lease_token":variant["token"].as_str().unwrap_or("lease"),"identity":identity,"evidence":if variant["evidencePresent"]==false{"".to_string()}else if variant["evidenceMatches"]==false{"Different text".to_string()}else{format!("Bubble: {}",s(&a["draft"]["text"]))}});
            if variant["workerPresent"] != false {
                args["worker_id"] = json!("worker")
            }
            let mut row = corpus["row"].clone();
            if variant["draftReady"] == false {
                row["availability"] = json!("unknown")
            }
            let mut decisions = vec![
                ["sent", "checked", "not_sent", "cancelled"].contains(&status)
                    || blockers(&f.ws, &c, "claim", &args, &row, Some(&a)).is_empty(),
                blockers(&f.ws, &c, "cancel", &args, &row, Some(&a)).is_empty(),
            ];
            let readiness = draft_blockers(&c, &a["draft"], &row, f.ws.now);
            let permit = blockers(&f.ws, &c, "permit", &args, &row, Some(&a));
            decisions.push(permit.iter().all(|i| {
                readiness.iter().any(|x| x["code"] == i["code"])
                    || (!readiness.is_empty() && i["code"] == "conversation_closed")
            }));
            for result in ["sent", "checked", "not_sent", "blocked", "uncertain"] {
                args["result"] = json!(result);
                decisions.push(
                    (contains(&["sent", "checked", "not_sent"], &a["status"])
                        && a["status"] == result)
                        || blockers(&f.ws, &c, "result", &args, &row, Some(&a)).is_empty(),
                )
            }
            for (i, decision) in decisions.iter().enumerate() {
                assert_eq!(
                    *decision,
                    case[i + 4].as_bool().unwrap(),
                    "case {case}, decision {i}"
                )
            }
        }
        assert_eq!(arr(&corpus["cases"]).len() * 8, 5280);
    }
    #[test]
    fn generated_wording_preserves_currency_units_and_collection_dates() {
        assert_eq!(currency_text(180000, "GBP"), "£1,800.00");
        assert_eq!(currency_text(18000, "CAD"), "CA$180.00");
        assert_eq!(currency_text(18000, "JPY"), "JP¥18,000");
        assert_eq!(currency_text(18000, "KWD"), "KWD\u{a0}18.000");
        let draft = json!({"price_minor":180000,"currency":"GBP","price_period":"month","intent":"accept","collection":{"date":"2026-10-25","time":"19:00","end_time":"20:00","timezone":"Europe/London"},"verification_questions":[]});
        let text = offer_message(&draft);
        assert!(text.contains("£1,800.00 per month"));
        assert!(text.contains("Sunday 25 October between 19:00 and 20:00"));
        assert!(!collection_expired(
            &draft["collection"],
            util::time("2026-10-25T19:30:00Z").unwrap()
        ));
        assert!(collection_expired(
            &draft["collection"],
            util::time("2026-10-25T20:00:00Z").unwrap()
        ));
    }
}
