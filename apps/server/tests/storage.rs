use goodfinds::storage::Workspace;
use rusqlite::Connection;
use serde_json::{Value, json};
#[test]
fn fresh_workspace_uses_complete_schema_one_and_keeps_its_stream_identity() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(dir.path(), "live", "fresh").unwrap();
    assert_eq!(
        ws.db
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(ws.config["searches"], json!([]));
    assert_eq!(ws.config["origin_confirmed"], false);
    let stream: String = ws
        .db
        .query_row(
            "SELECT stream_id FROM coordination_stream WHERE id=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let events: i64 = ws
        .db
        .query_row("SELECT COUNT(*) FROM coordination_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 0);
    drop(ws);
    let reopened = Workspace::open(dir.path(), "live", "reopened").unwrap();
    assert_eq!(
        reopened
            .db
            .query_row(
                "SELECT stream_id FROM coordination_stream WHERE id=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        stream
    );
    assert_eq!(
        reopened
            .db
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
#[test]
fn concurrent_first_open_preserves_one_complete_workspace() {
    for _ in 0..10 {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(8);
        let revisions = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let ws = Workspace::open(dir.path(), "live", "concurrent-start")?;
                        ws.revisions()
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(revisions.iter().all(|revision| revision == &revisions[0]));
        let ws = Workspace::open(dir.path(), "live", "readback").unwrap();
        let settings: i64 = ws
            .db
            .query_row("SELECT COUNT(*) FROM workspace_settings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(settings, 1);
    }
}
#[test]
fn unsupported_schemas_are_rejected_without_changes() {
    for version in [0, 2, 3, 4, 5, 99] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(&format!("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('saved'); PRAGMA user_version={version}")).unwrap();
        assert!(Workspace::open(dir.path(), "live", "test").is_err());
        assert_eq!(
            db.query_row("SELECT value FROM preserved", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "saved"
        );
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
    }
}
#[test]
fn removed_record_fields_are_rejected_without_rewriting_saved_records() {
    for (table, field) in [
        ("search_monitoring", "schedule"),
        ("saved_searches", "prompt"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(dir.path(), "live", "record-boundary").unwrap();
        let example: Value = serde_json::from_str(include_str!(
            "../../../skills/marketplace-shopping/assets/example-workspace.json"
        ))
        .unwrap();
        ws.config = goodfinds::storage::validate_config(&example).unwrap();
        let sid = ws.config["searches"][0]["id"].clone();
        goodfinds::searches::set_monitoring(
            &mut ws.config,
            &json!({"search_id":sid,"preference":"recurring","interval_minutes":120}),
        )
        .unwrap();
        ws.save_config().unwrap();
        let query = format!("SELECT document_json FROM {table} ORDER BY sort_order LIMIT 1");
        let original: String = ws.db.query_row(&query, [], |r| r.get(0)).unwrap();
        let mut row: Value = serde_json::from_str(&original).unwrap();
        if field == "schedule" {
            row["schedule"] = Value::Null;
        } else {
            row["cover"] = json!({"media_id":"a".repeat(64),"kind":"generated","alt":"Example cover","source_name":"Generated illustration","prompt":"Removed generation data"});
        }
        let persisted = row.to_string();
        ws.db
            .execute(
                &format!("UPDATE {table} SET document_json=?1 WHERE document_json=?2"),
                [&persisted, &original],
            )
            .unwrap();
        drop(ws);
        let error = match Workspace::open(dir.path(), "live", "readback") {
            Err(error) => error,
            Ok(_) => panic!("Removed {field} unexpectedly accepted"),
        };
        assert!(error.to_string().contains(field));
        let db = Connection::open(dir.path().join("workspace.sqlite")).unwrap();
        assert_eq!(
            db.query_row(&query, [], |r| r.get::<_, String>(0)).unwrap(),
            persisted
        );
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn defaults_use_host_timezone_without_replacing_explicit_preferences() {
    let config = json!({"origin":"Example town","baseline_days":30,"minimum_peer_listings":3,"alert_policy":"first_qualification_and_lower_price","searches":[]});
    let default = goodfinds::storage::validate_config(&config).unwrap();
    assert_eq!(
        default["schedule"]["quiet_hours"]["timezone"],
        goodfinds::storage::host_timezone()
    );
    let mut explicit = config;
    explicit["schedule"] = json!({"quiet_hours":{"enabled":false,"start":"21:00","end":"07:00","timezone":"Asia/Tokyo"}});
    assert_eq!(
        goodfinds::storage::validate_config(&explicit).unwrap()["schedule"]["quiet_hours"]["timezone"],
        "Asia/Tokyo"
    );
}
#[test]
fn imported_configuration_cannot_bypass_monitoring_dispatcher_or_feedback_guards() {
    let base: Value = serde_json::from_str(include_str!(
        "../../../skills/marketplace-shopping/assets/example-workspace.json"
    ))
    .unwrap();
    let search = base["searches"][0]["id"].clone();
    let mut bad = base.clone();
    bad["searches"][0]["id"] = json!("Wrong_ID");
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    let monitoring = json!({"search_id":search,"preference":"recurring","interval_minutes":60,"timing":{"mode":"daily","times":["09:00"]}});
    bad = base.clone();
    bad["monitoring"] = json!([monitoring.clone(), monitoring.clone()]);
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    bad["monitoring"] = json!([monitoring]);
    bad["monitoring"][0]["timing"]["times"] = json!(["09:00", "09:00"]);
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    let thread = "00000000-0000-4000-8000-000000000001";
    let dispatcher = json!({"id":"00000000-0000-4000-8000-000000000002","thread_id":thread,"search_ids":[search],"schedule":null});
    bad = base.clone();
    bad["dispatchers"] = json!([dispatcher.clone(), dispatcher.clone()]);
    bad["dispatchers"][1]["id"] = json!("00000000-0000-4000-8000-000000000003");
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    bad["dispatchers"] = json!([dispatcher]);
    bad["dispatchers"][0]["schedule"] = json!({"automation_id":"fixture","thread_id":"00000000-0000-4000-8000-000000000004","status":"paused","interval_minutes":60,"evidence":"fixture","verified_at":"2026-10-08T00:00:00Z"});
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    bad = base;
    bad["feedback"] = json!([{"id":"invalid","search_id":search,"listing_key":"manual:fixture","action":"shortlist","exclude_model":true,"category":"computer","created_at":"2026-10-08T00:00:00Z","undone":false}]);
    assert!(goodfinds::storage::validate_config(&bad).is_err());
}
