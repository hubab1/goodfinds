//! Read-only compact buying context. Full UI state remains a separate response channel.
use crate::{
    error::{Error, Result},
    listings, searches, sellers,
    storage::Workspace,
    util::{array, hash},
};
use serde_json::{Value, json};
pub const QUERY_ACTIONS: &[&str] = &[
    "get_search_context",
    "get_settings",
    "get_monitoring",
    "list_next_steps",
    "list_activity",
];
fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn a(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn merge(target: &mut Value, fields: Value) {
    if let (Some(target), Some(fields)) = (target.as_object_mut(), fields.as_object()) {
        for (key, value) in fields {
            target.insert(key.clone(), value.clone());
        }
    }
}
pub fn query(ws: &Workspace, action: &str, args: &Value, state: &Value) -> Result<Value> {
    let config = &ws.config;
    if action == "get_settings" {
        return Ok(
            json!({"revision":hash(config),"revisions":ws.revisions()?,"access_context":ws.access_context,"origin_confirmed":config["origin_confirmed"].as_bool().unwrap_or(false),"settings":{"origin":config["origin"],"location":config["location"],"platforms":config["platforms"],"browser_preference":config["browser_preference"],"journey_checks_enabled":config["journey_checks_enabled"],"interval_minutes":config["schedule"]["interval_minutes"],"quiet_hours":config["schedule"]["quiet_hours"],"baseline_days":config["baseline_days"],"minimum_peer_listings":config["minimum_peer_listings"]},"browser_access":config["browser_access"],"platform_sessions":config["platform_sessions"]}),
        );
    }
    let selected: Vec<Value> = a(&config["searches"])
        .iter()
        .filter(|search| args["search_id"].is_null() || search["id"] == args["search_id"])
        .cloned()
        .collect();
    if !args["search_id"].is_null() && selected.is_empty() {
        return Err(Error::validation("Choose a saved search"));
    }
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let end = offset.saturating_add(limit);
    if action == "list_activity" {
        let activity = a(&state["activity"]);
        return Ok(
            json!({"activity":activity.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":activity.len(),"next_offset":if end<activity.len(){json!(end)}else{Value::Null},"monitor":state["monitor"],"monitoring":state["monitoring"]}),
        );
    }
    let fulfilled = sellers::fulfilled_searches(a(&state["seller_conversations"]));
    if action == "list_next_steps" {
        let next: Vec<_> = a(&state["next_steps"])
            .iter()
            .filter(|step| args["search_id"].is_null() || step["search_id"] == args["search_id"])
            .collect();
        return Ok(
            json!({"actions":next.iter().skip(offset).take(limit).collect::<Vec<_>>(),"total":next.len(),"next_offset":if end<next.len(){json!(end)}else{Value::Null},"fulfilled_searches":fulfilled,"hint":"Messages are drafts for review. Read get_goodfinds_seller_conversation before reviewing an exact message; use save_goodfinds_collection_plan and prepare_goodfinds_collection_message after agreement. A recommendation with unresolved checks is conditional.","monitoring":a(&state["monitoring"]).iter().filter(|m|args["search_id"].is_null()||m["search_id"]==args["search_id"]).collect::<Vec<_>>()}),
        );
    }
    if !["get_monitoring", "get_search_context"].contains(&action) {
        return Err(Error::validation(format!(
            "Unknown workspace query: {action}"
        )));
    }
    let mut monitoring = searches::monitoring_snapshot(ws, &selected, &fulfilled)?;
    if ws.mode == "sample" {
        monitoring["dispatchers"] = json!([])
    }
    let mut result = json!({"revision":hash(config),"revisions":ws.revisions()?});
    merge(&mut result, monitoring);
    if action == "get_monitoring" {
        return Ok(result);
    }
    let rows = if state["listings"].is_array() {
        a(&state["listings"]).to_vec()
    } else {
        listings::load(ws)?
    };
    let discovery = listings::discovery_summary(ws)?;
    let media: Vec<Value> = rows
        .iter()
        .filter(|row| {
            selected
                .iter()
                .any(|search| search["product"] == row["product"])
        })
        .map(|row| listings::media_state(row, ws.now))
        .filter(|media| media["state"] != "complete")
        .collect();
    let runs = searches::runs(ws, args["search_id"].as_str())?;
    let mut scope = config.clone();
    scope["searches"] = json!(selected);
    merge(
        &mut result,
        json!({
            "access_context":ws.access_context,"mode":ws.mode,
            "paths":{"database":ws.folder().join("workspace.sqlite")},
            "configuration_storage":"SQLite entity rows; workspace_settings stores shared settings",
            "journeys":{"provider":"google_maps_browser","enabled":config["journey_checks_enabled"],"pending_towns":listings::journey_queue(&rows,&selected,config,ws.now).len(),"next_step":"Read list_goodfinds_journey_checks, check each Google Maps driving route in the selected browser, and save record_goodfinds_journey_check. Reuse town-level estimates across listings. Report blocked routes without inventing a duration."},
            "media_repairs":{"pending":media.len(),"ready":media.iter().filter(|m|m["ready"]==true).count(),"next_step":if media.is_empty(){Value::Null}else{json!("After provisional discovery, read list_goodfinds_media_repairs for this search and attach ready recovered galleries without changing old fact timestamps or review coverage.")}},
            "origin":config["origin"],"origin_confirmed":config["origin_confirmed"].as_bool().unwrap_or(false),"location":config["location"],"browser_preference":config["browser_preference"],"platforms":config["platforms"],"browser_access":config["browser_access"],"platform_sessions":config["platform_sessions"],
            "comparison":{"baseline_days":config["baseline_days"],"minimum_peer_listings":config["minimum_peer_listings"]},
            "searches":selected.iter().map(|search|{let mut search=search.clone();let sid=s(&search["id"]).to_owned();let reading=listings::reading_summary(&rows,&search,config,discovery["last_searched"][&sid].as_str());merge(&mut search,reading);search["found_count"]=discovery["counts"][&sid].clone();search}).collect::<Vec<_>>(),
            "cover_follow_ups":selected.iter().map(searches::cover_follow_up).filter(|f|!f.is_null()).collect::<Vec<_>>(),
            "drafts":config["drafts"],"feedback":a(&config["feedback"]).iter().filter(|e|selected.iter().any(|search|searches::applies_to_search(e,search))).collect::<Vec<_>>(),
            "search_runs":runs.iter().map(|run|{let mut run=run.clone();run["progress"]=searches::search_progress(&run);run}).collect::<Vec<_>>(),
            "query_plans":selected.iter().map(|search|json!({"search_id":search["id"],"queries":searches::query_plan(search,array(config,"feedback")),"excluded_models":searches::excluded_models(search,array(config,"feedback"))})).collect::<Vec<_>>(),
            "fulfilled_searches":fulfilled,
        }),
    );
    merge(
        &mut result,
        searches::workflow_views(&scope, &runs, &fulfilled, ws.now),
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts;
    fn fixture() -> (tempfile::TempDir, Workspace, Value) {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(root.path(), "live", "query-test").unwrap();
        ws.automations_directory = None;
        ws.config["searches"] = contracts::data("example")["searches"].clone();
        ws.save_config().unwrap();
        let state = json!({"listings":[],"seller_conversations":[],"next_steps":[],"monitoring":[],"activity":[],"monitor":{"label":"Monitoring off"}});
        (root, ws, state)
    }
    #[test]
    fn context_is_scoped_and_read_only() {
        let (_root, ws, state) = fixture();
        let sid = ws.config["searches"][0]["id"].clone();
        let before = ws.db.total_changes();
        let result = query(&ws, "get_search_context", &json!({"search_id":sid}), &state).unwrap();
        assert_eq!(a(&result["searches"]).len(), 1);
        assert_eq!(result["searches"][0]["id"], sid);
        assert_eq!(result["query_plans"][0]["search_id"], sid);
        assert!(result["search_workflows"].get(s(&sid)).is_some());
        assert_eq!(result["access_context"], "query-test");
        assert_eq!(ws.db.total_changes(), before);
        assert!(
            query(
                &ws,
                "get_search_context",
                &json!({"search_id":"missing"}),
                &state
            )
            .is_err()
        );
    }
    #[test]
    fn compact_queries_page_without_mutating_reading_status() {
        let (_root, ws, mut state) = fixture();
        let sid = ws.config["searches"][0]["id"].clone();
        state["activity"] = json!([{"id":"a"},{"id":"b"},{"id":"c"}]);
        state["next_steps"] =
            json!([{"search_id":sid,"id":"one"},{"search_id":"other","id":"two"}]);
        let activity = query(&ws, "list_activity", &json!({"offset":1,"limit":1}), &state).unwrap();
        assert_eq!(activity["activity"], json!([{"id":"b"}]));
        assert_eq!(activity["next_offset"], 2);
        let actions = query(&ws, "list_next_steps", &json!({"search_id":sid}), &state).unwrap();
        assert_eq!(actions["total"], 1);
        assert!(actions["next_offset"].is_null());
        let settings = query(&ws, "get_settings", &json!({}), &state).unwrap();
        assert_eq!(
            settings["settings"]["quiet_hours"],
            ws.config["schedule"]["quiet_hours"]
        );
        let count: i64 = ws
            .db
            .query_row("SELECT count(*) FROM listing_seen", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
