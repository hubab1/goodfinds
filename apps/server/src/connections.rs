//! Connection checks share the workspace writer transaction through an attached
//! database, so cancellation, route changes and observation commits are fenced.
use crate::{
    contracts,
    error::{Error, Result},
    storage::Workspace,
    util,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
const MARKETPLACES: &[&str] = &[
    "facebook_marketplace",
    "ebay",
    "vinted",
    "gumtree",
    "autotrader",
    "craigslist",
];
const DOMAINS: &[&str] = &[
    "www.facebook.com",
    "www.ebay.co.uk",
    "www.vinted.co.uk",
    "www.gumtree.com",
    "www.autotrader.co.uk",
    "www.craigslist.org",
];
pub const ACTIONS: &[&str] = &[
    "start_goodfinds_connection_check",
    "get_goodfinds_connection_check",
    "claim_goodfinds_connection_check",
    "renew_goodfinds_connection_check",
    "complete_goodfinds_connection_check",
    "interrupt_goodfinds_connection_check",
    "cancel_goodfinds_connection_check",
];
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn invalid<T>(message: &str) -> Result<T> {
    Err(Error::validation(message))
}
fn active(r: &Value) -> bool {
    r["status"] == "queued" || r["status"] == "running"
}
fn domain(m: &str) -> &str {
    MARKETPLACES
        .iter()
        .position(|x| *x == m)
        .map(|i| DOMAINS[i])
        .unwrap_or("")
}
pub fn init(ws: &Workspace) -> Result<()> {
    ws.db.execute_batch("CREATE TABLE IF NOT EXISTS checks.connection_checks (id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,context_id TEXT NOT NULL,target_scope_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,document_json TEXT NOT NULL CHECK(json_valid(document_json))); CREATE UNIQUE INDEX IF NOT EXISTS checks.connection_checks_active_by_scope ON connection_checks(context_id,target_scope_hash) WHERE status IN ('queued','running');")?;
    Ok(())
}
fn save(ws: &Workspace, r: &Value) -> Result<()> {
    ws.db.execute("INSERT INTO checks.connection_checks(id,request_id,context_id,target_scope_hash,status,created_at,document_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,document_json=excluded.document_json",params![s(&r["id"]),s(&r["request_id"]),s(&r["context_id"]),s(&r["target_scope_hash"]),s(&r["status"]),s(&r["created_at"]),serde_json::to_string(r)?])?;
    Ok(())
}
fn update(ws: &Workspace, r: &mut Value) {
    r["version"] = json!(r["version"].as_i64().unwrap_or(0) + 1);
    r["updated_at"] = json!(util::iso(ws.now));
}
fn recover(ws: &Workspace) -> Result<()> {
    let mut q = ws.db.prepare(
        "SELECT document_json FROM checks.connection_checks WHERE status IN ('queued','running')",
    )?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let mut run: Value = serde_json::from_str(&raw?)?;
        let start = util::time(
            run["worker"]["claimed_at"]
                .as_str()
                .unwrap_or(s(&run["created_at"])),
        )?;
        if run["lease_expires_at_ms"].as_i64().unwrap_or(0) <= ws.now
            || (run["status"] == "running" && start + 5 * 60_000 <= ws.now)
        {
            run["message"] = json!(if run["status"] == "queued" {
                "No background worker started. Try again."
            } else {
                "Check stopped or timed out. Try again."
            });
            run["status"] = json!("interrupted");
            run["lease_expires_at_ms"] = json!(0);
            update(ws, &mut run);
            save(ws, &run)?
        }
    }
    Ok(())
}
fn query<P: rusqlite::Params>(ws: &Workspace, sql: &str, p: P) -> Result<Option<Value>> {
    let raw: Option<String> = ws.db.query_row(sql, p, |r| r.get(0)).optional()?;
    raw.map(|s| {
        let mut r: Value = serde_json::from_str(&s)?;
        if r.get("version").is_none() {
            r["version"] = json!(1)
        }
        if r.get("worker").is_none() {
            r["worker"] = Value::Null
        }
        Ok(r)
    })
    .transpose()
}
fn find(ws: &Workspace, id: Option<&str>) -> Result<Option<Value>> {
    if let Some(id) = id {
        query(
            ws,
            "SELECT document_json FROM checks.connection_checks WHERE id=? AND context_id=?",
            params![id, ws.access_context],
        )
    } else {
        query(
            ws,
            "SELECT document_json FROM checks.connection_checks WHERE context_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            [&ws.access_context],
        )
    }
}
fn targets(ws: &Workspace, selected: &Value) -> Result<Vec<Value>> {
    let mut out = vec![];
    for m in MARKETPLACES {
        if !selected.is_null() && !arr(selected).iter().any(|v| v == m) {
            continue;
        }
        if ws.config["platforms"][m]["enabled"] == false {
            if !selected.is_null() {
                return invalid("Enable this marketplace first.");
            }
            continue;
        }
        let pref = s(&ws.config["platforms"][m]["browser"]);
        let browser = if pref.is_empty() || pref == "default" {
            s(&ws.config["browser_preference"])
        } else {
            pref
        };
        let device = crate::storage::device_browser();
        out.push(json!({"marketplace":m,"browser":browser,"browser_id":if browser=="in_app"{json!("iab")}else{device["id"].clone()}}));
    }
    if out.is_empty() {
        return invalid("Choose a marketplace to check.");
    }
    Ok(out)
}
fn compact_hash(v: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).expect("JSON value"))
    )
}
fn ordered(v: &Value, keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for key in keys {
        if let Some(value) = v.get(key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(out)
}
fn observations_hash(observations: &Value) -> String {
    let values:Vec<Value>=arr(observations).iter().map(|o|json!({"marketplace":o["marketplace"],"access":ordered(&o["access"],&["browser","browser_id","status","host","profile","evidence","blocked_domains"]),"session":if o["session"].is_null(){Value::Null}else{ordered(&o["session"],&["marketplace","browser","browser_id","host","profile","status","evidence"])}})).collect();
    compact_hash(&json!(values))
}
fn scope_hash(context: &str, targets: &Value) -> String {
    compact_hash(&json!({"context":context,"targets":targets}))
}
fn scope(ws: &Workspace, r: &Value) -> Result<()> {
    let selected = json!(
        arr(&r["targets"])
            .iter()
            .map(|t| t["marketplace"].clone())
            .collect::<Vec<_>>()
    );
    if ws.mode == "sample"
        || r["context_id"] != ws.access_context
        || scope_hash(&ws.access_context, &json!(targets(ws, &selected)?))
            != s(&r["target_scope_hash"])
    {
        invalid("Browser selection changed. Start a new check.")
    } else {
        Ok(())
    }
}
fn version(r: &Value, args: &Value) -> Result<()> {
    if r["version"] != args["expected_version"] {
        Err(Error::conflict(
            "connection_check",
            r["version"].to_string(),
        ))
    } else {
        Ok(())
    }
}
fn owns(r: &Value, worker: &Value) -> Result<()> {
    if r["status"] != "running" || r["worker"]["id"] != *worker {
        invalid("This worker no longer owns an active check. Stop browsing.")
    } else {
        Ok(())
    }
}
fn result(run: Option<Value>) -> Value {
    let public = run.map(|mut r| {
        for key in [
            "target_scope_hash",
            "owner_process_id",
            "lease_expires_at_ms",
            "input_marketplaces",
            "completion_token",
            "observations_hash",
        ] {
            r.as_object_mut().unwrap().remove(key);
        }
        r
    });
    json!({"run":public,"execution":crate::sellers::execution_policy("collection")})
}
fn validate_observations(run: &Value, observations: &Value) -> Result<()> {
    let mut seen = HashSet::new();
    let mut identities = BTreeMap::new();
    for o in arr(observations) {
        let Some(t) = arr(&run["targets"])
            .iter()
            .find(|t| t["marketplace"] == o["marketplace"])
        else {
            return invalid("Wrong marketplace in check results.");
        };
        if !seen.insert(s(&o["marketplace"]).to_string()) {
            return invalid("Wrong marketplace in check results.");
        }
        let a = &o["access"];
        if a["browser"] != t["browser"]
            || s(&a["browser_id"]).is_empty()
            || (!t["browser_id"].is_null() && a["browser_id"] != t["browser_id"])
        {
            return invalid("Check results must match the selected browser.");
        }
        let identity = json!([a["browser_id"], a["host"], a["profile"]]);
        if identities
            .insert(s(&t["browser"]).to_string(), identity.clone())
            .is_some_and(|old| old != identity)
        {
            return invalid("Check results have inconsistent browser profiles.");
        }
        let session = &o["session"];
        if !session.is_null()
            && (a["status"] != "available"
                || session["marketplace"] != t["marketplace"]
                || ["browser", "browser_id", "host", "profile"]
                    .iter()
                    .any(|k| session[k] != a[k]))
        {
            return invalid("Check results have inconsistent sign-in evidence.");
        }
    }
    Ok(())
}
pub fn command(ws: &mut Workspace, action: &str, input: &Value) -> Result<Value> {
    let op = match action {
        "start_goodfinds_connection_check" | "start" => "start",
        "get_goodfinds_connection_check" | "read" => "read",
        "claim_goodfinds_connection_check" | "claim" => "claim",
        "renew_goodfinds_connection_check" | "renew" => "renew",
        "complete_goodfinds_connection_check" | "complete" => "complete",
        "interrupt_goodfinds_connection_check" | "interrupt" => "interrupt",
        "cancel_goodfinds_connection_check" | "cancel" => "cancel",
        _ => return invalid("Unknown connection check action"),
    };
    let args = contracts::parse(&format!("{op}ConnectionCheckSchema"), input)?;
    recover(ws)?;
    if op == "start" {
        let mut selected = arr(&args["marketplaces"]).to_vec();
        selected.sort_by(|a, b| s(a).cmp(s(b)));
        selected.dedup();
        let selected = if args["marketplaces"].is_null() {
            Value::Null
        } else {
            json!(selected)
        };
        if let Some(old) = query(
            ws,
            "SELECT document_json FROM checks.connection_checks WHERE request_id=?",
            [s(&args["request_id"])],
        )? {
            if old["context_id"] != ws.access_context || old["input_marketplaces"] != selected {
                return invalid("Start a new check for this selection.");
            }
            return Ok(result(Some(old)));
        }
        let revision = ws.revisions()?["settings"].clone();
        if args["expected_entity_revision"] != revision {
            return Err(Error::conflict("settings", s(&revision)));
        }
        let targets = json!(targets(ws, &args["marketplaces"])?);
        let hash = scope_hash(&ws.access_context, &targets);
        if let Some(old) = query(
            ws,
            "SELECT document_json FROM checks.connection_checks WHERE context_id=? AND target_scope_hash=? AND status IN ('queued','running') LIMIT 1",
            params![ws.access_context, hash],
        )? {
            return Ok(result(Some(old)));
        }
        let live = ws.mode == "live";
        let r = json!({"id":util::id(),"request_id":args["request_id"],"version":1,"context_id":ws.access_context,"input_marketplaces":selected,"target_scope_hash":hash,"owner_process_id":owner_process(),"lease_expires_at_ms":if live{ws.now+2*60_000}else{0},"status":if live{"queued"}else{"unavailable"},"worker":null,"message":if live{"Waiting for a background check…"}else{"Try this with your saved searches."},"created_at":util::iso(ws.now),"updated_at":util::iso(ws.now),"targets":targets,"results":[]});
        save(ws, &r)?;
        return Ok(result(Some(r)));
    }
    let found = find(ws, args["run_id"].as_str())?;
    if op == "read" {
        return Ok(result(found));
    }
    let mut r = found
        .ok_or_else(|| Error::validation("Read the check in its original Goodfinds connection."))?;
    match op {
        "claim" => {
            scope(ws, &r)?;
            if r["status"] == "running"
                && r["worker"]["id"] == args["worker_id"]
                && r["worker"]["agent_id"] == args["agent_id"]
            {
                owns(&r, &args["worker_id"])?;
                return Ok(result(Some(r)));
            }
            version(&r, &args)?;
            if r["status"] != "queued" {
                return invalid("This check cannot be claimed. Read its current progress.");
            }
            if args["agent_id"] == args["parent_thread_id"] {
                return invalid("Delegate the check to a native subagent.");
            }
            r["status"] = json!("running");
            r["message"] = json!("Checking…");
            r["lease_expires_at_ms"] = json!(ws.now + 2 * 60_000);
            r["worker"] = json!({"id":args["worker_id"],"agent_id":args["agent_id"],"claimed_at":util::iso(ws.now),"last_heartbeat_at":util::iso(ws.now)});
            for key in ["parent_thread_id", "execution"] {
                if let Some(v) = args.get(key) {
                    r["worker"][key] = v.clone()
                }
            }
        }
        "renew" => {
            owns(&r, &args["worker_id"])?;
            scope(ws, &r)?;
            r["lease_expires_at_ms"] = json!(ws.now + 2 * 60_000);
            r["worker"]["last_heartbeat_at"] = json!(util::iso(ws.now))
        }
        "interrupt" => {
            if r["status"] == args["status"]
                && r["message"] == args["reason"]
                && (r["worker"].is_null() || r["worker"]["id"] == args["worker_id"])
            {
                return Ok(result(Some(r)));
            }
            version(&r, &args)?;
            if r["status"] == "running" {
                owns(&r, &args["worker_id"])?
            } else if r["status"] != "queued" {
                return invalid("This check has already stopped.");
            }
            r["status"] = args["status"].clone();
            r["message"] = args["reason"].clone();
            r["lease_expires_at_ms"] = json!(0)
        }
        "cancel" => {
            if !active(&r) {
                return Ok(result(Some(r)));
            }
            r["status"] = json!("cancelled");
            r["message"] = json!("Check cancelled.");
            r["lease_expires_at_ms"] = json!(0)
        }
        "complete" => {
            let hash = observations_hash(&args["observations"]);
            if r["status"] == "complete"
                && r["worker"]["id"] == args["worker_id"]
                && r["observations_hash"] == hash
            {
                return Ok(result(Some(r)));
            }
            owns(&r, &args["worker_id"])?;
            version(&r, &args)?;
            scope(ws, &r)?;
            validate_observations(&r, &args["observations"])?;
            // No await or release of the writer lock occurs between the ownership fence
            // and the paired access/session write. A competing cancel must precede or
            // follow this entire transaction, never interleave with its evidence writes.
            update(ws, &mut r);
            report(
                ws,
                "report_connections",
                &json!({"context_id":ws.access_context,"reports":args["observations"]}),
            )?;
            r["status"] = json!("complete");
            r["message"] = json!(
                if arr(&args["observations"]).len() == arr(&r["targets"]).len() {
                    "Check complete."
                } else {
                    "Some marketplaces couldn’t be checked. Their status remains unknown."
                }
            );
            r["lease_expires_at_ms"] = json!(0);
            r["observations_hash"] = json!(hash);
            r["results"]=json!(arr(&r["targets"]).iter().map(|t|{let o=arr(&args["observations"]).iter().find(|o|o["marketplace"]==t["marketplace"]);let session=o.map(|o|&o["session"]);let status=session.map(|s|s["status"].as_str().unwrap_or("unknown")).filter(|s|["signed_in","signed_out"].contains(s)).unwrap_or("unknown");json!({"marketplace":t["marketplace"],"browser":t["browser"],"status":status,"checked_at":if session.is_some_and(|s|!s.is_null()){json!(util::iso(ws.now))}else{Value::Null}})}).collect::<Vec<_>>());
        }
        _ => unreachable!(),
    }
    update(ws, &mut r);
    save(ws, &r)?;
    Ok(result(Some(r)))
}
fn owner_process() -> &'static str {
    static OWNER: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    OWNER.get_or_init(util::id)
}
pub fn close(ws: &Workspace) -> Result<()> {
    recover(ws)?;
    let mut q = ws.db.prepare(
        "SELECT document_json FROM checks.connection_checks WHERE status IN ('queued','running')",
    )?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let mut r: Value = serde_json::from_str(&raw?)?;
        if r["owner_process_id"] == owner_process() {
            r["status"] = json!("interrupted");
            r["message"] = json!("Check stopped. Try again.");
            r["lease_expires_at_ms"] = json!(0);
            update(ws, &mut r);
            save(ws, &r)?
        }
    }
    Ok(())
}
fn stamp(mut r: Value, ws: &Workspace) -> Value {
    r["checked_at"] = json!(util::iso(ws.now));
    r["context_id"] = json!(ws.access_context);
    r
}
fn capped_append(
    existing: &Value,
    report: Value,
    keep: impl Fn(&Value) -> bool,
    limit: usize,
) -> Value {
    let mut values: Vec<Value> = arr(existing).iter().filter(|x| keep(x)).cloned().collect();
    values.push(report);
    if values.len() > limit {
        values.drain(..values.len() - limit);
    }
    json!(values)
}
pub fn report(ws: &mut Workspace, action: &str, args: &Value) -> Result<()> {
    if args["context_id"] != ws.access_context {
        return invalid("Refresh Goodfinds before reporting browser access");
    }
    let mut candidate = ws.config.clone();
    match action {
        "report_browser_access" => {
            let r = contracts::parse("accessReportSchema", &args["report"])?;
            candidate["browser_access"] = capped_append(
                &candidate["browser_access"],
                stamp(r.clone(), ws),
                |x| x["browser"] != r["browser"],
                20,
            )
        }
        "report_marketplace_session" => {
            let r = contracts::parse("sessionReportSchema", &args["report"])?;
            candidate["platform_sessions"] = capped_append(
                &candidate["platform_sessions"],
                stamp(r.clone(), ws),
                |x| {
                    ["marketplace", "browser", "host", "profile"]
                        .iter()
                        .any(|k| x[k] != r[k])
                },
                100,
            )
        }
        "report_listing_contact" => {
            let r = contracts::parse("listingContactReportSchema", &args["report"])?;
            if (r["offer_note"] == "available" || !r["offer_limits"].is_null())
                && r["offer"] != "available"
            {
                return invalid("Offer limits and notes need an observed offer interface");
            }
            if r["offer_limits"]["minimum_minor"]
                .as_i64()
                .zip(r["offer_limits"]["maximum_minor"].as_i64())
                .is_some_and(|(min, max)| min > max)
            {
                return invalid("Offer minimum exceeds the maximum");
            }
            let row = crate::listings::find(ws, s(&r["listing_key"]))?;
            if row.is_none_or(|row| {
                row["source"] != r["marketplace"]
                    || !crate::sellers::same_listing_url(s(&row["url"]), s(&r["listing_url"]))
            }) {
                return invalid("Contact evidence must match the saved listing and marketplace");
            }
            candidate["listing_contacts"] = capped_append(
                &candidate["listing_contacts"],
                stamp(r.clone(), ws),
                |x| x["listing_key"] != r["listing_key"] || x["browser"] != r["browser"],
                5000,
            )
        }
        "report_connections" => {
            if !(1..=6).contains(&arr(&args["reports"]).len()) {
                return invalid("Provide between one and six connection observations");
            }
            let observations: Vec<Value> = arr(&args["reports"])
                .iter()
                .map(|o| contracts::parse("connectionCheckObservationSchema", o))
                .collect::<Result<_>>()?;
            let mut seen = HashSet::new();
            let mut routes: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
            for o in &observations {
                let access = &o["access"];
                let session = &o["session"];
                let route = routes.entry(s(&access["browser"]).to_string()).or_default();
                let previous = route.first().map(|x| &x["access"]);
                if !seen.insert(s(&o["marketplace"]).to_string())
                    || s(&access["browser_id"]).is_empty()
                    || previous.is_some_and(|p| {
                        ["browser_id", "host", "profile"]
                            .iter()
                            .any(|k| p[k] != access[k])
                    })
                    || (!session.is_null()
                        && (access["status"] != "available"
                            || session["marketplace"] != o["marketplace"]
                            || ["browser", "browser_id", "host", "profile"]
                                .iter()
                                .any(|k| session[k] != access[k])))
                {
                    return invalid("Check results must match the selected browser.");
                }
                route.push(o)
            }
            for route in routes.values() {
                let available = route.iter().any(|o| o["access"]["status"] == "available");
                let global = route.iter().any(|o| {
                    arr(&o["access"]["blocked_domains"])
                        .iter()
                        .any(|d| d == "*")
                        || o["access"]["status"] == "not_connected"
                        || (o["access"]["status"] == "unavailable"
                            && arr(&o["access"]["blocked_domains"]).is_empty())
                });
                if available && global {
                    return invalid("Check results disagree about browser access.");
                }
            }
            for route in routes.values() {
                let o = route
                    .iter()
                    .find(|o| o["access"]["status"] == "available")
                    .unwrap_or(&route[0]);
                let access = &o["access"];
                let checked: Vec<&str> = route
                    .iter()
                    .filter(|o| o["access"]["status"] == "available")
                    .map(|o| domain(s(&o["marketplace"])))
                    .collect();
                let mut blocks: Vec<Value> = arr(&candidate["browser_access"])
                    .iter()
                    .filter(|x| {
                        ["browser", "browser_id", "host", "profile"]
                            .iter()
                            .all(|k| x[k] == access[k])
                            && x["context_id"] == ws.access_context
                    })
                    .flat_map(|x| arr(&x["blocked_domains"]))
                    .filter(|b| {
                        !checked.iter().any(|d| {
                            s(b) == "*" || *d == s(b) || d.ends_with(&format!(".{}", s(b)))
                        })
                    })
                    .cloned()
                    .collect();
                for item in route {
                    let a = &item["access"];
                    let explicit = arr(&a["blocked_domains"]);
                    if a["status"] == "available" || !explicit.is_empty() {
                        blocks.extend_from_slice(explicit)
                    } else if a["status"] == "denied" || a["status"] == "unknown" {
                        blocks.push(json!(domain(s(&item["marketplace"]))))
                    }
                }
                let mut seen = HashSet::new();
                blocks.retain(|b| seen.insert(b.to_string()));
                let mut r = access.clone();
                r["blocked_domains"] = json!(blocks);
                candidate["browser_access"] = capped_append(
                    &candidate["browser_access"],
                    stamp(r, ws),
                    |x| x["browser"] != access["browser"],
                    20,
                )
            }
            for o in observations {
                let session = &o["session"];
                if !session.is_null() {
                    candidate["platform_sessions"] = capped_append(
                        &candidate["platform_sessions"],
                        stamp(session.clone(), ws),
                        |x| {
                            ["marketplace", "browser", "browser_id", "host", "profile"]
                                .iter()
                                .any(|k| x[k] != session[k])
                        },
                        100,
                    )
                }
            }
        }
        _ => return invalid("Unknown connection report"),
    };
    ws.config = candidate;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        _dir: tempfile::TempDir,
        ws: Workspace,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let mut ws = Workspace::open(dir.path(), "live", "connection-test-context").unwrap();
            ws.now = util::time("2026-10-04T14:00:00Z").unwrap();
            Self { _dir: dir, ws }
        }
        fn call(&mut self, action: &str, mut args: Value) -> Result<Value> {
            args["mode"] = json!(self.ws.mode);
            self.ws.db.execute_batch("BEGIN IMMEDIATE").unwrap();
            let old = self.ws.config.clone();
            let result = command(&mut self.ws, action, &args).and_then(|r| {
                self.ws.save_config()?;
                Ok(r)
            });
            self.ws
                .db
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .unwrap();
            if result.is_err() {
                self.ws.config = old
            }
            result
        }
        fn start(&mut self) -> Value {
            let revision = self.ws.revisions().unwrap()["settings"].clone();
            self.call("start",json!({"expected_entity_revision":revision,"request_id":util::id(),"marketplaces":["facebook_marketplace","ebay"]})).unwrap()["run"].clone()
        }
        fn claim(&mut self, r: &Value) -> Value {
            self.call("claim",json!({"run_id":r["id"],"expected_version":r["version"],"worker_id":util::id(),"agent_id":"native-child","parent_thread_id":"parent","execution":{"profile":"collection","model":"gpt-6-luna","reasoning_effort":"xhigh"}})).unwrap()["run"].clone()
        }
        fn observations(&self) -> Value {
            json!([{"marketplace":"facebook_marketplace","access":{"browser":"in_app","browser_id":"iab","host":"Codex","profile":"Test profile","status":"available","evidence":"Simulated native browser access","blocked_domains":[]},"session":{"marketplace":"facebook_marketplace","browser":"in_app","browser_id":"iab","host":"Codex","profile":"Test profile","status":"signed_in","evidence":"Simulated visible sign-in"}}])
        }
        fn completion(&self, r: &Value) -> Value {
            json!({"run_id":r["id"],"expected_version":r["version"],"worker_id":r["worker"]["id"],"observations":self.observations()})
        }
    }
    #[test]
    fn queue_claim_partial_complete_exact_retry_and_observation_fencing() {
        let mut f = Fixture::new();
        let queued = f.start();
        assert_eq!(queued["status"], "queued");
        assert!(queued["worker"].is_null());
        let duplicate = f.start();
        assert_eq!(duplicate["id"], queued["id"]);
        let running = f.claim(&queued);
        assert_eq!(running["status"], "running");
        assert_eq!(running["worker"]["execution"]["model"], "gpt-6-luna");
        let args = f.completion(&running);
        let result = f.call("complete", args.clone()).unwrap();
        assert_eq!(result["run"]["status"], "complete");
        assert_eq!(result["run"]["results"][0]["status"], "signed_in");
        assert_eq!(result["run"]["results"][1]["status"], "unknown");
        assert!(result["run"]["results"][1]["checked_at"].is_null());
        let revision = f.ws.revisions().unwrap();
        let replay = f.call("complete", args.clone()).unwrap();
        assert_eq!(replay["run"]["version"], result["run"]["version"]);
        assert_eq!(f.ws.revisions().unwrap(), revision);
        let mut other = args;
        other["observations"][0]["session"]["status"] = json!("signed_out");
        assert!(f.call("complete", other).is_err());
        assert_eq!(f.ws.config["platform_sessions"][0]["status"], "signed_in");
    }
    #[test]
    fn cancellation_in_another_connection_prevents_late_evidence() {
        let mut f = Fixture::new();
        let queued = f.start();
        let running = f.claim(&queued);
        let mut other = Workspace::open(f._dir.path(), "live", "connection-test-context").unwrap();
        other.now = f.ws.now;
        other.db.execute_batch("BEGIN IMMEDIATE").unwrap();
        command(
            &mut other,
            "cancel",
            &json!({"mode":"live","run_id":running["id"]}),
        )
        .unwrap();
        other.db.execute_batch("COMMIT").unwrap();
        let old = f.ws.config.clone();
        assert!(f.call("complete", f.completion(&running)).is_err());
        assert_eq!(f.ws.config, old);
        assert!(
            f.call(
                "renew",
                json!({"run_id":running["id"],"worker_id":running["worker"]["id"]})
            )
            .is_err()
        );
        assert_eq!(
            f.call("read", json!({"run_id":running["id"]})).unwrap()["run"]["status"],
            "cancelled"
        );
    }
    #[test]
    fn changed_routes_and_inconsistent_profiles_are_rejected_atomically() {
        let mut f = Fixture::new();
        let queued = f.start();
        let running = f.claim(&queued);
        let mut wrong = f.completion(&running);
        wrong["observations"][0]["session"]["profile"] = json!("Other profile");
        assert!(f.call("complete", wrong).is_err());
        assert!(arr(&f.ws.config["browser_access"]).is_empty());
        f.ws.config["platforms"]["facebook_marketplace"] =
            json!({"enabled":true,"browser":"external"});
        assert!(f.call("complete", f.completion(&running)).is_err());
        assert!(arr(&f.ws.config["platform_sessions"]).is_empty());
    }
    #[test]
    fn expiry_and_total_timeout_cannot_be_renewed() {
        let mut f = Fixture::new();
        let queued = f.start();
        f.ws.now += 2 * 60_000 + 1;
        assert_eq!(
            f.call("read", json!({"run_id":queued["id"]})).unwrap()["run"]["status"],
            "interrupted"
        );
        assert!(f.call("claim",json!({"run_id":queued["id"],"expected_version":queued["version"],"worker_id":util::id(),"agent_id":"child"})).is_err());
        let queued = f.start();
        let running = f.claim(&queued);
        for _ in 0..4 {
            f.ws.now += 60_000;
            f.call(
                "renew",
                json!({"run_id":running["id"],"worker_id":running["worker"]["id"]}),
            )
            .unwrap();
        }
        f.ws.now += 60_000;
        assert!(
            f.call(
                "renew",
                json!({"run_id":running["id"],"worker_id":running["worker"]["id"]})
            )
            .is_err()
        );
    }
    #[test]
    fn context_and_sample_isolation_are_enforced() {
        let mut f = Fixture::new();
        let queued = f.start();
        f.ws.access_context = "another-context".into();
        assert!(f.call("read", json!({"run_id":queued["id"]})).unwrap()["run"].is_null());
        assert!(f.call("claim",json!({"run_id":queued["id"],"expected_version":queued["version"],"worker_id":util::id(),"agent_id":"child"})).is_err());
        let dir = tempfile::tempdir().unwrap();
        let mut sample = Workspace::open(dir.path(), "sample", "sample-context").unwrap();
        let revision = sample.revisions().unwrap()["settings"].clone();
        let result=command(&mut sample,"start",&json!({"mode":"sample","expected_entity_revision":revision,"request_id":util::id(),"marketplaces":["facebook_marketplace"]})).unwrap();
        assert_eq!(result["run"]["status"], "unavailable");
    }
    #[test]
    fn site_blocks_do_not_falsely_disconnect_other_sites() {
        let mut f = Fixture::new();
        let queued = f.start();
        let running = f.claim(&queued);
        let mut args = f.completion(&running);
        let mut ebay = args["observations"][0].clone();
        ebay["marketplace"] = json!("ebay");
        ebay["session"] = Value::Null;
        ebay["access"]["status"] = json!("denied");
        args["observations"].as_array_mut().unwrap().push(ebay);
        f.call("complete", args).unwrap();
        assert_eq!(f.ws.config["browser_access"][0]["status"], "available");
        assert_eq!(
            f.ws.config["browser_access"][0]["blocked_domains"],
            json!(["www.ebay.co.uk"])
        );
        assert!(crate::sellers::access_available(
            &f.ws.config["browser_access"],
            "in_app",
            &f.ws.access_context,
            f.ws.now,
            "www.facebook.com"
        ));
        assert!(!crate::sellers::access_available(
            &f.ws.config["browser_access"],
            "in_app",
            &f.ws.access_context,
            f.ws.now,
            "www.ebay.co.uk"
        ));
    }
    #[test]
    fn shutdown_interrupts_only_this_process_owned_runs() {
        let mut f = Fixture::new();
        let queued = f.start();
        close(&f.ws).unwrap();
        assert_eq!(
            f.call("read", json!({"run_id":queued["id"]})).unwrap()["run"]["status"],
            "interrupted"
        );
    }
}
