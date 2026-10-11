//! Caller-observed host capabilities, scoped to the actual connection and time.
use crate::{
    contracts,
    error::{Error, Result},
    storage::Workspace,
    util::*,
};
use serde_json::{Value, json};

pub fn context(ws: &Workspace) -> Value {
    let report = array(&ws.config, "host_capabilities")
        .iter()
        .find(|v| v["context_id"] == ws.access_context);
    let fresh = report.filter(|r| {
        time(text(r, "checked_at")).is_ok_and(|t| t <= ws.now)
            && time(text(r, "expires_at")).is_ok_and(|t| t > ws.now)
    });
    let capabilities:Vec<Value>=["panel","browser","delegation","local_files","scheduling","notifications"].iter().map(|name| {
        let value=fresh.map(|r|&r["capabilities"][name]).unwrap_or(&Value::Null);
        json!({"name":name,"status":value["status"].as_str().unwrap_or("unknown"),"evidence":value["evidence"],
            "checked_at":report.map(|r|&r["checked_at"]),"expires_at":report.map(|r|&r["expires_at"])})
    }).collect();
    let bindings:Vec<Value>=array(&ws.config,"dispatchers").iter().map(|d| {
        let receipt=&d["schedule"];
        let compatibility=if receipt["workflow_version"].is_null() || receipt["skill_name"].is_null() {"unknown"}
            else if receipt["workflow_version"]==contracts::data("workflowContract")["workflow_version"] && receipt["skill_name"]=="marketplace-shopping" {"current"} else {"stale"};
        json!({"dispatcher_id":d["id"],"thread_id":d["thread_id"],"status":receipt["status"],"compatibility":compatibility,
            "next_step":if compatibility=="current" {"Keep the observed schedule state."} else {"In the original buying chat, verify the installed skill and schedule prompt; preserve pause, timing and notification choices when updating."}})
    }).collect();
    json!({"access_context":ws.access_context,"contract":contracts::data("workflowContract"),"capabilities":capabilities,"schedule_bindings":bindings})
}

pub fn report(ws: &mut Workspace, args: &Value) -> Result<()> {
    if args["context_id"] != ws.access_context {
        return Err(Error::validation(
            "Report capabilities through the observed access context",
        ));
    }
    let mut report = contracts::parse("hostCapabilityReportSchema", &args["report"])?;
    report["context_id"] = json!(ws.access_context);
    report["checked_at"] = json!(iso(ws.now));
    report["expires_at"] = json!(iso(ws.now + 30 * 60_000));
    let mut reports: Vec<Value> = array(&ws.config, "host_capabilities")
        .iter()
        .filter(|r| r["context_id"] != ws.access_context)
        .cloned()
        .collect();
    reports.push(report);
    if reports.len() > 20 {
        reports.drain(..reports.len() - 20);
    }
    ws.config["host_capabilities"] = json!(reports);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compatibility_diagnosis_preserves_paused_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(dir.path(), "live", "capabilities").unwrap();
        ws.config["dispatchers"] = json!([{"id":"dispatcher","thread_id":"original","schedule":{"status":"paused","interval_minutes":120,"notification_policy":"quiet"}}]);
        let original = ws.config.clone();
        assert_eq!(
            context(&ws)["schedule_bindings"][0]["compatibility"],
            "unknown"
        );
        assert_eq!(ws.config, original);
        ws.config["dispatchers"][0]["schedule"]["workflow_version"] =
            contracts::data("workflowContract")["workflow_version"].clone();
        ws.config["dispatchers"][0]["schedule"]["skill_name"] = json!("marketplace-shopping");
        assert_eq!(
            context(&ws)["schedule_bindings"][0]["compatibility"],
            "current"
        );
        ws.config["dispatchers"][0]["schedule"]["workflow_version"] = json!(999);
        assert_eq!(
            context(&ws)["schedule_bindings"][0]["compatibility"],
            "stale"
        );
        assert_eq!(context(&ws)["schedule_bindings"][0]["status"], "paused");
        assert_eq!(ws.config["dispatchers"][0]["thread_id"], "original");
        assert_eq!(
            ws.config["dispatchers"][0]["schedule"]["interval_minutes"],
            120
        );
        assert_eq!(
            ws.config["dispatchers"][0]["schedule"]["notification_policy"],
            "quiet"
        );
    }
}
