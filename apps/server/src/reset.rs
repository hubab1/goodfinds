//! Explicit, previewed data reset. Host schedules must be removed first.
use crate::{
    error::{Error, Result},
    searches,
    storage::Workspace,
    util::*,
};
use serde_json::{Value, json};
use std::path::PathBuf;

const TABLES: &[&str] = &[
    "journey_estimates",
    "listing_search_discoveries",
    "listing_seen",
    "workspace_settings",
    "saved_searches",
    "search_drafts",
    "search_monitoring",
    "listing_feedback_events",
    "integration_observations",
    "listings",
    "listing_evaluations",
    "listing_observations",
    "deal_alerts",
    "listing_events",
    "search_coverage",
    "seller_conversations",
    "search_runs",
    "search_run_workers",
    "listing_media_captures",
    "operation_receipts",
    "coordination_events",
    "checks.connection_checks",
];
fn media(ws: &Workspace) -> Result<Vec<Value>> {
    let folder = ws.folder().join("media");
    if !folder.exists() {
        return Ok(vec![]);
    }
    if folder.symlink_metadata()?.file_type().is_symlink() {
        return Err(Error::validation(
            "The media folder must not be a symbolic link",
        ));
    }
    let mut files = vec![];
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let metadata = entry.path().symlink_metadata()?;
        if !metadata.is_file() {
            return Err(Error::validation(
                "The media folder contains an unexpected entry; inspect it before resetting",
            ));
        }
        files.push(json!({"name":entry.file_name().to_string_lossy(),"bytes":metadata.len(),"modified":metadata.modified().ok().and_then(|v|v.duration_since(std::time::UNIX_EPOCH).ok()).map(|v|v.as_nanos().to_string())}));
    }
    files.sort_by_key(|v| text(v, "name").to_owned());
    Ok(files)
}
pub fn preview(ws: &Workspace) -> Result<Value> {
    let mut counts = serde_json::Map::new();
    let mut fingerprints = vec![];
    for table in TABLES {
        let mut statement = ws
            .db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))?;
        let columns = statement.column_count();
        let values = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i)))
                    .collect::<Vec<_>>())
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        counts.insert((*table).into(), json!(values.len()));
        fingerprints.push(json!([table, hash(&json!(values))]));
    }
    let files = media(ws)?;
    let hosts = searches::host_observations(ws)?;
    let mut cleanup = vec![];
    for d in array(&ws.config, "dispatchers") {
        if let Some(id) = d["schedule"]["automation_id"].as_str() {
            let host = hosts.get(&format!("dispatcher:{}", text(d, "id")));
            // A stored 'removed' flag is not proof while a real automation still exists.
            if host.is_none_or(|v| v["status"] != "removed") {
                cleanup.push(json!({"automation_id":id,"status":host.map(|v|v["status"].clone()).unwrap_or(json!("unverified"))}));
            }
        }
    }
    let mut active = vec![];
    for row in ws.documents("SELECT document_json FROM search_runs", [])? {
        if let Some(run) = searches::find_run(ws, text(&row, "id"))?
            && searches::active(&searches::expired_run(&run, ws.now))
        {
            active.push(run["id"].clone());
        }
    }
    let token = hash(&json!([ws.mode, fingerprints, files, cleanup]));
    Ok(
        json!({"mode":ws.mode,"reset_token":token,"counts":counts,"media_files":files.len(),"media_bytes":files.iter().filter_map(|f|f["bytes"].as_u64()).sum::<u64>(),"active_run_ids":active,"schedule_cleanup":cleanup,"ready":active.is_empty()&&cleanup.is_empty(),"scope":"All searches, listings, conversations, runs, feedback, settings, connection observations and cached media in this workspace. Browser sign-ins, other workspaces, the plugin installation and chat messages are preserved."}),
    )
}
fn staged(ws: &Workspace, args: &Value) -> PathBuf {
    ws.folder()
        .join(format!(".reset-media-{}", text(args, "request_id")))
}
pub fn reset(ws: &mut Workspace, args: &Value) -> Result<Value> {
    let before = preview(ws)?;
    if args["confirmation"] != "delete_all_goodfinds_data" {
        return Err(Error::validation("Explicit reset confirmation is required"));
    }
    if args["reset_token"] != before["reset_token"] {
        return Err(Error::conflict(
            "workspace reset",
            text(&before, "reset_token"),
        ));
    }
    if before["ready"] != true {
        return Err(Error::validation(
            "Stop active runs and remove the listed host schedules, then preview the reset again",
        ));
    }
    let folder = ws.folder().join("media");
    if folder.exists() {
        std::fs::rename(folder, staged(ws, args))?;
    }
    for table in TABLES {
        ws.db.execute(&format!("DELETE FROM {table}"), [])?;
    }
    ws.db.execute(
        "UPDATE coordination_stream SET stream_id=? WHERE id=1",
        [id()],
    )?;
    ws.config = crate::storage::validate_config(
        &json!({"origin":"Location not set","origin_confirmed":false,"browser_preference":"in_app","baseline_days":30,"minimum_peer_listings":3,"alert_policy":"first_qualification_and_lower_price","searches":[]}),
    )?;
    ws.save_config()?;
    Ok(
        json!({"reset":{"deleted_counts":before["counts"],"deleted_media_files":before["media_files"],"media_cleanup_complete":false}}),
    )
}
pub fn rollback_media(ws: &Workspace, args: &Value) {
    let stage = staged(ws, args);
    let committed: bool = ws
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE request_id=?)",
            [text(args, "request_id")],
            |r| r.get(0),
        )
        .unwrap_or(true);
    if stage.exists() && !committed {
        let _ = std::fs::rename(stage, ws.folder().join("media"));
    }
}
pub fn finish_media(ws: &Workspace, args: &Value) -> bool {
    let stage = staged(ws, args);
    !stage.exists() || std::fs::remove_dir_all(stage).is_ok()
}

// SQLite rolls back an interrupted transaction on reopen. Reconcile its staged
// files under the same writer lock before another command can cache media.
pub fn recover_media(ws: &Workspace) -> Result<()> {
    for entry in std::fs::read_dir(ws.folder())? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str().and_then(|n| n.strip_prefix(".reset-media-")) else {
            continue;
        };
        if uuid::Uuid::parse_str(name).is_err() || !entry.file_type()?.is_dir() {
            continue;
        }
        let committed: bool = ws.db.query_row("SELECT EXISTS(SELECT 1 FROM operation_receipts WHERE request_id=? AND operation='reset_workspace')",[name],|r|r.get(0))?;
        if committed {
            let _ = std::fs::remove_dir_all(entry.path());
        } else {
            let folder = ws.folder().join("media");
            std::fs::create_dir_all(&folder)?;
            for file in std::fs::read_dir(entry.path())? {
                let file = file?;
                let destination = folder.join(file.file_name());
                if !destination.exists() {
                    std::fs::rename(file.path(), destination)?;
                }
            }
            std::fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}
