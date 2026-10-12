//! One transaction owns a command, its resource result, and its retry receipt.
use crate::{
    alerts, configuration, contracts, diagnostics,
    error::{Error, Result},
    listings, queries, searches, sellers, snapshot,
    storage::Workspace,
    util::*,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
const RUNS: &[&str] = &[
    "request_search_run",
    "claim_search_run",
    "renew_search_lease",
    "cancel_search_run",
    "update_search_run",
];
const MONITORING: &[&str] = &["set_monitoring", "report_dispatcher_schedule"];
pub fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(Error::new("cancelled", "Request cancelled before commit"))
    } else {
        Ok(())
    }
}
pub fn execute(
    root: &Path,
    context: &str,
    action: &str,
    input: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    diagnostics::operation(action, || {
        execute_inner(root, context, action, input, cancel)
    })
}
fn execute_inner(
    root: &Path,
    context: &str,
    action: &str,
    input: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    let args = contracts::parse(&format!("operations.{action}.input"), input)?;
    let mode = args["mode"].as_str().unwrap_or("live");
    let opening = diagnostics::stage("workspace_open");
    let mut ws = Workspace::open(root, mode, context)?;
    drop(opening);
    let query = contracts::all()["operations"][action]["kind"] == "query";
    cancelled(&cancel)?;
    // Opening the panel reads a snapshot after Workspace::open has initialized it.
    // Keep that potentially large read from blocking concurrent search writes.
    let waiting = diagnostics::stage("transaction_wait");
    ws.db.execute_batch(if query || action == "get_workspace" {
        "BEGIN DEFERRED"
    } else {
        "BEGIN IMMEDIATE"
    })?;
    drop(waiting);
    let _transaction = diagnostics::stage("transaction");
    let result = (|| {
        let reload = diagnostics::stage("config_reload");
        ws.reload_config()?;
        drop(reload);
        cancelled(&cancel)?;
        if query {
            let state = match action {
                "preview_workspace_reset"
                | "get_setup_context"
                | "get_settings"
                | "list_search_runs"
                | "get_runtime_context"
                | "get_search_recovery"
                | "list_pending_alerts"
                | "list_coordination_events" => json!({}),
                "get_search_context" | "get_monitoring" => {
                    json!({"seller_conversations":sellers::summaries(&ws)?})
                }
                _ if listings::QUERIES.contains(&action) => {
                    snapshot::listing_context(&ws, action, &args)?
                }
                _ => snapshot::snapshot(&ws)?,
            };
            let mut args = args.clone();
            args.as_object_mut().unwrap().remove("mode");
            let mut data = if action == "preview_workspace_reset" {
                crate::reset::preview(&ws)?
            } else if action == "list_coordination_events" {
                crate::events::read(&ws, &args)?
            } else if action == "get_runtime_context" {
                crate::runtime::context(&ws)
            } else if action == "get_search_recovery" {
                crate::recovery::read(&ws, &args)?
            } else if action == "list_pending_alerts" {
                alerts::pending(&ws, &args)?
            } else if listings::QUERIES.contains(&action) {
                listings::query(&ws, action, &args, &state)?
            } else if queries::QUERY_ACTIONS.contains(&action) {
                queries::query(&ws, action, &args, &state)?
            } else if searches::ACTIONS.contains(&action) {
                searches::command(&mut ws, action, &args)?
            } else {
                return Err(Error::validation("Unsupported query"));
            };
            if data.get("mode").is_none() {
                data["mode"] = json!(mode);
            }
            if data.get("revision").is_none() {
                data["revision"] = json!(ws.revision());
            }
            if data.get("revisions").is_none() {
                data["revisions"] = ws.revisions()?;
            }
            return contracts::parse(&format!("operations.{action}.output"), &data);
        }
        let request_id = args["request_id"].as_str().filter(|_| {
            action != "get_workspace"
                && !RUNS.contains(&action)
                && !sellers::ACTIONS.contains(&action)
        });
        if let Some(request_id) = request_id {
            let saved:Option<(String,String,String,String)>=ws.db.query_row("SELECT operation,input_hash,result_json,created_at FROM operation_receipts WHERE request_id=?",[request_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
            if let Some((operation, input_hash, raw, stamp)) = saved {
                if operation != action || input_hash != hash(&args) {
                    return Err(Error::validation(
                        "This request_id was already used for different arguments",
                    ));
                }
                let mut result: Value = serde_json::from_str(&raw)?;
                if !["acknowledge_alerts", "report_host_capabilities"].contains(&action) {
                    result["state"] = snapshot::snapshot(&ws)?;
                }
                result["receipt"] = json!({"request_id":request_id,"operation":action,"replayed":true,"committed_at":stamp});
                return Ok(result);
            }
        }
        let mut result = command(&mut ws, action, &args)?;
        let operation_result = command_result(action, &args, &result)?;
        if let Some(request_id) = request_id {
            let stamp = iso(ws.now);
            let mut saved = result.clone();
            saved.as_object_mut().unwrap().remove("state");
            saved["operation_result"] = operation_result.clone();
            ws.db.execute(
                "INSERT INTO operation_receipts VALUES(?,?,?,?,?)",
                params![request_id, action, hash(&args), saved.to_string(), stamp],
            )?;
            result["receipt"] = json!({"request_id":request_id,"operation":action,"replayed":false,"committed_at":stamp});
            result["operation_result"] = operation_result;
        }
        Ok(result)
    })();
    match result {
        Ok(mut result) => {
            if let Err(error) = cancelled(&cancel) {
                let _ = ws.db.execute_batch("ROLLBACK");
                if action == "reset_workspace" {
                    crate::reset::rollback_media(&ws, &args);
                }
                return Err(error);
            }
            let _commit = diagnostics::stage("commit");
            if let Err(error) = ws.db.execute_batch("COMMIT") {
                let _ = ws.db.execute_batch("ROLLBACK");
                if action == "reset_workspace" {
                    crate::reset::rollback_media(&ws, &args);
                }
                return Err(error.into());
            }
            if action == "reset_workspace" {
                let clean = crate::reset::finish_media(&ws, &args);
                result["operation_result"]["reset"]["media_cleanup_complete"] = json!(clean);
                result["reset"]["media_cleanup_complete"] = json!(clean);
            }
            Ok(result)
        }
        Err(error) => {
            let _ = ws.db.execute_batch("ROLLBACK");
            if action == "reset_workspace" {
                crate::reset::rollback_media(&ws, &args);
            }
            Err(error)
        }
    }
}
fn prepare(ws: &mut Workspace, search_id: &str, keys: Option<&[Value]>) -> Result<()> {
    let state = snapshot::snapshot(ws)?;
    if let Some(candidate) = sellers::recommendations(&state, Some(search_id), keys).first()
        && let Some(row) = array(&state, "listings")
            .iter()
            .find(|r| r["key"] == candidate["listing_key"])
    {
        sellers::handle(
            ws,
            "prepare_opening",
            &json!({"search_id":search_id,"reasons":candidate["reasons"]}),
            row,
        )?;
    }
    Ok(())
}
fn command(ws: &mut Workspace, action: &str, args: &Value) -> Result<Value> {
    let mut extras = json!({});
    if action == "acknowledge_alerts" {
        let mut output = alerts::acknowledge(ws, args)?;
        output["mode"] = json!(ws.mode);
        output["revision"] = json!(ws.revision());
        output["revisions"] = ws.revisions()?;
        return Ok(
            json!({"operation_result":contracts::parse("operations.acknowledge_alerts.output", &output)?}),
        );
    }
    if action == "reset_workspace" {
        extras = crate::reset::reset(ws, args)?;
    } else if configuration::ACTIONS.contains(&action) || MONITORING.contains(&action) {
        configuration::check_revision(ws, action, args)?;
        if MONITORING.contains(&action) {
            if ws.mode != "live" {
                return Err(Error::validation(
                    "Manage real monitoring in the live workspace",
                ));
            }
            extras = searches::command(ws, action, args)?;
        } else {
            extras = configuration::command(ws, action, args)?;
        }
        ws.save_config()?;
        if action == "report_host_capabilities" {
            let mut output = crate::runtime::context(ws);
            output["mode"] = json!(ws.mode);
            output["revision"] = json!(ws.revision());
            output["revisions"] = ws.revisions()?;
            return Ok(
                json!({"operation_result":contracts::parse("operations.report_host_capabilities.output", &output)?}),
            );
        }
        searches::reconcile_scheduled_runs(ws)?;
        if ![
            "set_search_cover",
            "save_search_draft",
            "discard_search_draft",
            "report_browser_access",
            "report_marketplace_session",
            "report_connections",
            "report_listing_contact",
            "set_monitoring",
            "report_dispatcher_schedule",
        ]
        .contains(&action)
        {
            withdraw_alerts(ws)?;
        }
    } else if sellers::ACTIONS.contains(&action) {
        extras = sellers::command(ws, action, args)?;
        if action == "set_buying_outcome" && extras["seller_conversation"]["outcome"] == "bought" {
            searches::fulfil_goals(
                ws,
                &array(&extras["seller_conversation"], "search_ids")
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )?;
        }
    } else if RUNS.contains(&action) || action == "request_scheduled_batch" {
        if action == "request_scheduled_batch" && ws.mode != "live" {
            return Err(Error::validation(
                "Scheduled dispatch is only available in the live workspace",
            ));
        }
        extras = searches::command(ws, action, args)?;
        if ["completed", "partial"].contains(&text(&extras["run"], "phase")) {
            let run = &extras["run"];
            if run["phase"] == "completed" && run["trigger"] == "scheduled" {
                if let Some(m) = ws.config["monitoring"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|m| m["search_id"] == run["search_id"])
                {
                    m["last_scheduled_run_at"] = run["updated_at"].clone();
                }
                ws.save_config()?;
            }
            prepare(ws, text(run, "search_id"), Some(array(run, "listing_keys")))?;
        }
    } else if action == "prepare_next_steps" {
        let sid = text(args, "search_id");
        if !array(&ws.config, "searches")
            .iter()
            .any(|s| text(s, "id") == sid)
        {
            return Err(Error::validation("Choose a saved search"));
        }
        let run = if let Some(id) = args["run_id"].as_str() {
            Some(
                searches::find_run(ws, id)?
                    .filter(|r| text(r, "search_id") == sid)
                    .ok_or_else(|| Error::validation("Choose this search's saved run"))?,
            )
        } else {
            None
        };
        prepare(ws, sid, run.as_ref().map(|r| array(r, "listing_keys")))?;
    } else if listings::ACTIONS.contains(&action) {
        extras = listings::command(ws, action, args)?;
    } else if action != "get_workspace" {
        return Err(Error::validation("Unsupported action"));
    }
    if action == "renew_search_lease"
        || (action == "update_search_run" && searches::active(&extras["run"]))
    {
        // Routine progress retains transactional guards and reconciliation.
        let run = searches::find_run(ws, text(&args["request"], "run_id"))?
            .map(|r| searches::expired_run(&r, ws.now));
        let workflow = if let Some(run) = &run {
            let fulfilled = sellers::fulfilled_searches(&sellers::summaries(ws)?);
            searches::workflow_views(&ws.config, std::slice::from_ref(run), &fulfilled, ws.now)
                ["search_run_workflows"][text(run, "id")].clone()
        } else {
            searches::empty_workflow(ws.now)
        };
        let mut output = json!({"mode":ws.mode,"revision":ws.revision(),"revisions":ws.revisions()?,"search_run":run,"workflow":workflow});
        if let Some(check) = extras.get("scheduled_check") {
            output["scheduled_check"] = check.clone();
        }
        extras["operation_result"] =
            contracts::parse(&format!("operations.{action}.output"), &output)?;
        return Ok(extras);
    }
    let mut state = snapshot::snapshot(ws)?;
    for key in ["seller_conversation", "seller_workflow"] {
        if let Some(value) = extras.as_object_mut().unwrap().remove(key) {
            state[key] = value;
        }
    }
    state = contracts::parse("stateSchema", &state)?;
    extras["state"] = state;
    Ok(extras)
}
fn withdraw_alerts(ws: &Workspace) -> Result<()> {
    let rows = listings::load(ws)?;
    let current: Vec<_> = rows
        .iter()
        .filter(|r| {
            time(text(r, "last_observed_at")).is_ok_and(|t| {
                t >= ws.now - integer(&ws.config, "baseline_days").unwrap_or(30) * DAY
                    && t <= ws.now
            })
        })
        .cloned()
        .collect();
    for alert in listings::pending_alerts(ws)?.as_array().unwrap() {
        let qualifies = array(&ws.config, "searches")
            .iter()
            .find(|s| s["id"] == alert["search_id"] && bool_(s, "enabled"))
            .zip(rows.iter().find(|r| r["key"] == alert["listing_key"]))
            .is_some_and(|(search, row)| {
                let pool = listings::comparison_pool(
                    &current,
                    search,
                    &ws.config,
                    ws.now,
                    ws.mode == "sample",
                );
                listings::evaluate_listing(
                    row,
                    &pool,
                    search,
                    &ws.config,
                    ws.now,
                    ws.mode == "sample",
                )["status"]
                    == "qualifies"
            });
        if !qualifies {
            ws.db.execute(
                "UPDATE deal_alerts SET status='withdrawn' WHERE id=?",
                [text(alert, "id")],
            )?;
        }
    }
    Ok(())
}
pub fn settings(state: &Value) -> Value {
    let c = &state["config"];
    json!({"origin":c["origin"],"location":c["location"],"platforms":c["platforms"],"browser_preference":c["browser_preference"],"journey_checks_enabled":c["journey_checks_enabled"],"interval_minutes":c["schedule"]["interval_minutes"],"quiet_hours":c["schedule"]["quiet_hours"],"baseline_days":c["baseline_days"],"minimum_peer_listings":c["minimum_peer_listings"]})
}
pub fn command_result(action: &str, args: &Value, result: &Value) -> Result<Value> {
    if let Some(output) = result.get("operation_result") {
        return contracts::parse(&format!("operations.{action}.output"), output);
    }
    let state = &result["state"];
    let mut out =
        json!({"mode":state["mode"],"revision":state["revision"],"revisions":state["revisions"]});
    if let Some(receipt) = result.get("receipt") {
        out["receipt"] = receipt.clone();
    }
    let sid = args["search_id"]
        .as_str()
        .or(args["search"]["id"].as_str())
        .or(args["monitoring"]["search_id"].as_str())
        .or(args["report"]["search_id"].as_str());
    let search = if let Some(sid) = sid {
        array(&state["config"], "searches")
            .iter()
            .find(|s| text(s, "id") == sid)
    } else {
        array(&state["config"], "searches")
            .iter()
            .find(|s| s["name"] == args["search"]["name"])
            .or_else(|| array(&state["config"], "searches").last())
    };
    let data = match action {
        "save_search" | "set_search_enabled" | "remove_search" | "set_search_cover"
        | "set_monitoring" => {
            let search = if action == "remove_search" {
                None
            } else {
                search
            };
            let mut v = json!({"search":search,"cover_follow_up":search.map(searches::cover_follow_up).unwrap_or(Value::Null),"monitoring":array(state,"monitoring").iter().filter(|m|search.is_some_and(|s|s["id"]==m["search_id"])).collect::<Vec<_>>()});
            if action == "remove_search" {
                v["removed_search_id"] = args["search_id"].clone();
            }
            v
        }
        "save_search_draft" | "discard_search_draft" => {
            let id = args["draft"]["id"].as_str();
            let draft = if action == "discard_search_draft" {
                None
            } else {
                array(state, "drafts")
                    .iter()
                    .find(|d| Some(text(d, "id")) == id)
                    .or_else(|| array(state, "drafts").last())
            };
            let mut v = json!({"draft":draft});
            if action == "discard_search_draft" {
                v["removed_draft_id"] = args["draft_id"].clone();
            }
            v
        }
        "save_settings" => json!({"settings":settings(state)}),
        "report_dispatcher_schedule" => json!({"dispatchers":state["dispatchers"]}),
        "request_scheduled_batch" => json!({"batch":result["batch"]}),
        "record_listing_feedback" | "undo_listing_feedback" => {
            json!({"feedback":if action=="undo_listing_feedback"{array(&state["config"],"feedback").iter().find(|f|f["id"]==args["feedback_id"])}else{array(&state["config"],"feedback").last()}})
        }
        _ if RUNS.contains(&action) || action == "import_listing_observations" => {
            let rid = args["request"]["run_id"]
                .as_str()
                .or(args["run_id"].as_str());
            let run = array(state, "search_runs")
                .iter()
                .find(|r| Some(text(r, "id")) == rid)
                .or_else(|| {
                    array(state, "search_runs")
                        .iter()
                        .find(|r| r["search_id"] == args["request"]["search_id"])
                });
            let workflow = run
                .map(|r| state["search_run_workflows"][text(r, "id")].clone())
                .unwrap_or_else(|| {
                    searches::empty_workflow(time(text(state, "generated_at")).unwrap_or(0))
                });
            let mut v = json!({"search_run":run,"workflow":workflow});
            for key in ["scheduled_check", "import_receipt"] {
                if let Some(value) = result.get(key) {
                    v[key] = value.clone();
                }
            }
            v
        }
        _ if sellers::ACTIONS.contains(&action) => {
            let mut c = state["seller_conversation"].clone();
            c["pending_action"] = sellers::summary(
                &c,
                time(text(state, "generated_at")).unwrap_or(0),
            )["pending_action"]
                .clone();
            let mut v = json!({"conversation":c,"workflow":state["seller_workflow"]});
            if action == "save_seller_message_draft" {
                v["mutation_receipt"] = json!({"operation":action,"listing_key":c["listing_key"],"version":c["version"],"draft_hash":hash(&c["draft"]),"committed_at":c["updated_at"]});
            }
            if let Some(e) = result.get("execution") {
                v["execution"] = e.clone();
            }
            v
        }
        _ if action.starts_with("report_") => {
            json!({"access_context":state["access_context"],"evidence":{"browser_access":state["config"]["browser_access"],"platform_sessions":state["config"]["platform_sessions"],"listing_contacts":array(&state["config"],"listing_contacts")}})
        }
        "reset_workspace" => json!({"reset":result["reset"]}),
        "prepare_next_steps" => {
            json!({"actions":array(state,"next_steps").iter().filter(|x|x["search_id"]==args["search_id"]).collect::<Vec<_>>()})
        }
        "set_listing_seen" => {
            json!({"searches":state["searches"],"listings":array(state,"listings").iter().filter(|r|array(args,"listings").iter().any(|p|p["listing_key"]==r["key"])).map(|r|json!({"key":r["key"],"seen_in_searches":r["seen_in_searches"]})).collect::<Vec<_>>()})
        }
        "attach_listing_media" => {
            let row = array(state, "listings")
                .iter()
                .find(|r| r["key"] == args["listing_key"]);
            json!({"listing_key":args["listing_key"],"media_capture":row.map(|r|&r["media_capture"]),"photos_count":row.map(|r|array(r,"photos").len()).unwrap_or(0),"videos_count":row.map(|r|array(r,"videos").len()).unwrap_or(0)})
        }
        _ => json!({}),
    };
    contracts::merge(&mut out, &data);
    contracts::parse(&format!("operations.{action}.output"), &out)
}

#[cfg(test)]
mod config_edge_tests {
    use super::*;
    fn call(root: &Path, action: &str, args: &Value) -> Result<Value> {
        execute(
            root,
            "config-test",
            action,
            args,
            Arc::new(AtomicBool::new(false)),
        )
    }
    #[test]
    fn feedback_retries_keep_the_original_event_and_fresh_undo_state() {
        let root = tempfile::tempdir().unwrap();
        let state = call(
            root.path(),
            "load_sample_workspace",
            &json!({"mode":"sample"}),
        )
        .unwrap()["state"]
            .clone();
        let workspace_id = state["workspace_id"].clone();
        let search = &state["searches"][0];
        let listing = array(&state, "listings")
            .iter()
            .find(|row| row["product"] == search["product"])
            .unwrap();
        let request = json!({"mode":"sample","request_id":id(),"expected_entity_revision":state["revisions"]["absent"],"feedback":{"search_id":search["id"],"listing_key":listing["key"],"action":"dismiss","reason":"Too expensive","scope":"search"}});
        let first = call(root.path(), "record_listing_feedback", &request).unwrap();
        let event = first["operation_result"]["feedback"].clone();
        let event_id = text(&event, "id");
        assert_eq!(event["request_id"], request["request_id"]);
        let undo = json!({"mode":"sample","request_id":id(),"feedback_id":event_id,"expected_entity_revision":first["state"]["revisions"]["feedback"][event_id]});
        call(root.path(), "undo_listing_feedback", &undo).unwrap();
        let replay = execute(
            root.path(),
            "a-new-server-context",
            "record_listing_feedback",
            &request,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(replay["receipt"]["replayed"], true);
        assert_eq!(replay["operation_result"]["feedback"]["id"], event_id);
        assert_eq!(replay["state"]["workspace_id"], workspace_id);
        let events = array(&replay["state"]["config"], "feedback");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["undone"], true);
        let live = call(root.path(), "get_workspace", &json!({})).unwrap();
        assert_ne!(live["state"]["workspace_id"], workspace_id);
    }
    #[test]
    fn removal_of_final_search_retains_tombstone_revision_and_replay() {
        let root = tempfile::tempdir().unwrap();
        let state = call(root.path(), "get_workspace", &json!({})).unwrap()["state"].clone();
        let search = contracts::data("example")["searches"][0].clone();
        let sid = text(&search, "id");
        let request = json!({"request_id":id(),"expected_entity_revision":state["revisions"]["absent"],"search":search});
        let saved = call(root.path(), "save_search", &request).unwrap();
        let version = saved["state"]["revisions"]["searches"][sid].clone();
        let remove = json!({"request_id":id(),"expected_entity_revision":version,"search_id":sid});
        let removed = call(root.path(), "remove_search", &remove).unwrap();
        assert!(array(&removed["state"]["config"], "searches").is_empty());
        let tombstone = removed["state"]["revisions"]["searches"][sid].clone();
        assert_ne!(version, tombstone);
        let replay = call(root.path(), "remove_search", &remove).unwrap();
        assert_eq!(replay["receipt"]["replayed"], true);
        assert_eq!(replay["operation_result"]["removed_search_id"], sid);
        let stale = call(
            root.path(),
            "save_search",
            &json!({"request_id":id(),"expected_entity_revision":version,"search":search}),
        )
        .unwrap_err();
        assert_eq!(stale.code, "revision_conflict");
        assert_eq!(stale.current_revision.as_deref(), tombstone.as_str());
        let restored = call(
            root.path(),
            "save_search",
            &json!({"request_id":id(),"expected_entity_revision":tombstone,"search":search}),
        )
        .unwrap();
        assert_eq!(array(&restored["state"]["config"], "searches").len(), 1);
    }
    #[test]
    fn promotion_requires_the_current_draft_revision() {
        let root = tempfile::tempdir().unwrap();
        let state = call(root.path(), "get_workspace", &json!({})).unwrap()["state"].clone();
        let search = contracts::data("example")["searches"][0].clone();
        let draft = json!({"id":"draft-fictional","name":search["name"],"definition":search["definition"],"values":search["values"]});
        let saved=call(root.path(),"save_search_draft",&json!({"request_id":id(),"expected_entity_revision":state["revisions"]["absent"],"draft":draft})).unwrap();
        let revision = saved["state"]["revisions"]["drafts"]["draft-fictional"].clone();
        let mut changed = draft;
        changed["name"] = json!("Updated name");
        let changed = call(
            root.path(),
            "save_search_draft",
            &json!({"request_id":id(),"expected_entity_revision":revision,"draft":changed}),
        )
        .unwrap();
        assert_eq!(call(root.path(),"save_search",&json!({"request_id":id(),"expected_entity_revision":state["revisions"]["absent"],"draft_id":"draft-fictional","expected_draft_revision":revision,"search":search})).unwrap_err().code,"revision_conflict");
        let promoted=call(root.path(),"save_search",&json!({"request_id":id(),"expected_entity_revision":state["revisions"]["absent"],"draft_id":"draft-fictional","expected_draft_revision":changed["state"]["revisions"]["drafts"]["draft-fictional"],"search":search})).unwrap();
        assert!(array(&promoted["state"]["config"], "drafts").is_empty());
    }
    #[test]
    fn scheduled_no_run_returns_an_inspectable_workflow_and_shared_pause_fences_existing_workers() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(root.path(), "live", "schedule-test").unwrap();
        ws.automations_directory = None;
        ws.config["searches"] = json!([contracts::data("example")["searches"][0]]);
        ws.config["schedule"]["quiet_hours"]["enabled"] = json!(false);
        ws.save_config().unwrap();
        let sid = ws.config["searches"][0]["id"].clone();
        let input = json!({"mode":"live","request":{"search_id":sid,"request_id":id(),"trigger":"scheduled"}});
        let skipped = command(&mut ws, "request_search_run", &input).unwrap();
        let output = command_result("request_search_run", &input, &skipped).unwrap();
        assert!(output["search_run"].is_null());
        assert_eq!(output["workflow"]["state"], "absent");
        assert_eq!(output["scheduled_check"]["reason"], "monitoring_off");
        let revision = ws.revisions().unwrap()["absent"].clone();
        command(&mut ws,"set_monitoring",&json!({"monitoring":{"search_id":sid,"preference":"recurring"},"expected_entity_revision":revision})).unwrap();
        let thread = id();
        let did = id();
        let plan = searches::dispatcher_plan(
            &ws.config,
            &[sid.as_str().unwrap().into()],
            &std::collections::HashSet::new(),
            ws.now,
        );
        let revisions = ws.revisions().unwrap();
        let report = json!({"plan_revision":hash(&ws.config),"dispatcher_id":did,"thread_id":thread,"search_ids":[sid],"schedule":{"automation_id":"fixture-shared","thread_id":thread,"status":"active","interval_minutes":60,"rrule":plan["rrule"],"timezone":plan["timezone"],"evidence":"Fixture host schedule checked"}});
        command(
            &mut ws,
            "report_dispatcher_schedule",
            &json!({"expected_entity_revision":revisions["settings"],"report":report}),
        )
        .unwrap();
        let batch = command(
            &mut ws,
            "request_scheduled_batch",
            &json!({"mode":"live","dispatcher_id":did,"thread_id":thread,"request_id":id()}),
        )
        .unwrap();
        assert_eq!(array(&batch["batch"], "runs").len(), 1);
        let rid = batch["batch"]["runs"][0]["run_id"].clone();
        let version = batch["batch"]["runs"][0]["version"].clone();
        let worker = id();
        command(&mut ws,"claim_search_run",&json!({"request":{"run_id":rid,"expected_version":version,"worker_id":worker,"agent_id":"fixture-worker"}})).unwrap();
        let mut pause = report;
        pause["plan_revision"] = json!(hash(&ws.config));
        pause["schedule"]["status"] = json!("paused");
        let revision = ws.revisions().unwrap()["settings"].clone();
        command(
            &mut ws,
            "report_dispatcher_schedule",
            &json!({"expected_entity_revision":revision,"report":pause}),
        )
        .unwrap();
        let run = searches::find_run(&ws, rid.as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(run["phase"], "cancelled");
        let late = command(
            &mut ws,
            "renew_search_lease",
            &json!({"request":{"run_id":rid,"worker_id":worker}}),
        )
        .unwrap();
        assert_eq!(late["scheduled_check"]["reason"], "dispatcher_paused");
    }
}
