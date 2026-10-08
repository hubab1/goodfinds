use goodfinds::{contracts, storage::Workspace, util};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use std::path::Path;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/bun-workspace.json")).unwrap()
}
fn install(root: &Path) -> Value {
    std::fs::create_dir_all(root).unwrap();
    let f = fixture();
    let db = Connection::open(root.join("workspace.sqlite")).unwrap();
    db.execute_batch(contracts::all()["schema_sql"].as_str().unwrap())
        .unwrap();
    db.execute_batch("PRAGMA user_version=4").unwrap();
    for (table, rows) in f["tables"].as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            let cells = row.as_array().unwrap();
            let sql = format!(
                "INSERT INTO {table} VALUES({})",
                vec!["?"; cells.len()].join(",")
            );
            let values: Vec<SqlValue> = cells
                .iter()
                .map(|v| match v {
                    Value::Null => SqlValue::Null,
                    Value::Number(n) => n
                        .as_i64()
                        .map(SqlValue::Integer)
                        .unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap())),
                    Value::String(s) => SqlValue::Text(s.clone()),
                    _ => panic!("Unexpected SQLite fixture value"),
                })
                .collect();
            db.execute(&sql, params_from_iter(values)).unwrap();
        }
    }
    f
}
#[test]
fn bun_persisted_rows_keep_configuration_hash_entity_tokens_and_tombstones() {
    let dir = tempfile::tempdir().unwrap();
    let expected = install(dir.path());
    let mut ws = Workspace::open(dir.path(), "live", "storage-compatibility").unwrap();
    assert_eq!(ws.config, expected["config"]);
    assert_eq!(ws.revision(), expected["revision"].as_str().unwrap());
    assert_eq!(ws.revisions().unwrap(), expected["revisions"]);
    assert_eq!(
        ws.config["schedule"]["quiet_hours"]["timezone"],
        "Pacific/Auckland"
    );
    ws.db.execute_batch("BEGIN IMMEDIATE").unwrap();
    ws.save_config().unwrap();
    ws.db.execute_batch("COMMIT").unwrap();
    assert_eq!(ws.revisions().unwrap(), expected["revisions"]);
    drop(ws);
    let reread = Workspace::open(dir.path(), "live", "fresh-context").unwrap();
    assert_eq!(reread.revision(), expected["revision"].as_str().unwrap());
    assert_eq!(reread.revisions().unwrap(), expected["revisions"]);
    let deleted: i64 = reread
        .db
        .query_row(
            "SELECT is_deleted FROM saved_searches WHERE id='removed-search'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 1);
    assert!(
        !reread.config["searches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == "removed-search")
    );
}
#[test]
fn schema_one_two_three_upgrades_preserve_earliest_discovery_and_saved_revisions() {
    for version in [1, 2, 3] {
        let dir = tempfile::tempdir().unwrap();
        let expected = install(dir.path());
        let db = Connection::open(dir.path().join("workspace.sqlite")).unwrap();
        db.execute_batch("DROP TABLE listing_seen").unwrap();
        if version < 3 {
            db.execute_batch("DROP TABLE listing_search_discoveries")
                .unwrap()
        }
        if version == 1 {
            db.execute_batch("DROP TABLE journey_estimates").unwrap()
        }
        for (id, date) in [
            ("later", "2026-10-07T10:00:00Z"),
            ("earlier", "2026-10-06T10:00:00Z"),
        ] {
            let doc = json!({"id":id,"search_id":"demo-laptop","created_at":date,"listing_keys":["manual:fixture"]});
            db.execute(
                "INSERT INTO search_runs VALUES(?,?,?,?)",
                [id, "demo-laptop", &doc.to_string(), date],
            )
            .unwrap();
        }
        db.execute_batch(&format!("PRAGMA user_version={version}"))
            .unwrap();
        drop(db);
        let ws = Workspace::open(dir.path(), "live", "migration").unwrap();
        let upgraded: i64 = ws
            .db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(upgraded, 4);
        assert_eq!(ws.revisions().unwrap(), expected["revisions"]);
        if version < 3 {
            let run:String=ws.db.query_row("SELECT run_id FROM listing_search_discoveries WHERE listing_key='manual:fixture' AND search_id='demo-laptop'",[],|r|r.get(0)).unwrap();
            assert_eq!(run, "earlier");
        }
        let count: i64 = ws
            .db
            .query_row("SELECT COUNT(*) FROM listing_seen", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
#[test]
fn old_model_dismissal_is_upgraded_once_only_with_saved_evidence() {
    let dir = tempfile::tempdir().unwrap();
    install(dir.path());
    let mut ws = Workspace::open(dir.path(), "live", "legacy-feedback").unwrap();
    let search = ws.config["searches"][0].clone();
    let listing = json!({"key":"manual:fixture","listing_id":"fixture","product":search["product"],"attributes":{"model":"Fictional verified model"},"evidence":{"model":"Model printed on identification plate"}});
    ws.db.execute("INSERT INTO listings VALUES('manual:fixture','manual',?,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z')",[listing.to_string()]).unwrap();
    let mut feedback = json!({"id":"legacy-dismissal","search_id":search["id"],"listing_key":"manual:fixture","action":"dismiss","reason":"Not interested in this model","scope":"search","category":search["product"],"created_at":"2026-10-08T00:00:00Z","undone":false});
    let mut unverified = feedback.clone();
    unverified["id"] = json!("unverified-dismissal");
    unverified["listing_key"] = json!("manual:missing");
    let mut opted_out = feedback.clone();
    opted_out["id"] = json!("opted-out");
    opted_out["exclude_model"] = json!(false);
    feedback.as_object_mut().unwrap().remove("exclude_model");
    ws.config["feedback"] = json!([feedback, unverified, opted_out]);
    ws.save_config().unwrap();
    let before = ws.revisions().unwrap();
    drop(ws);
    let ws = Workspace::open(dir.path(), "live", "upgraded").unwrap();
    assert_eq!(
        ws.config["feedback"][0]["rule"]["value"],
        "Fictional verified model"
    );
    assert_eq!(ws.config["feedback"][0]["exclude_model"], true);
    assert!(ws.config["feedback"][1]["rule"].is_null());
    assert!(ws.config["feedback"][2]["rule"].is_null());
    let after = ws.revisions().unwrap();
    assert_eq!(after["settings"], before["settings"]);
    assert_eq!(after["searches"], before["searches"]);
    assert_ne!(
        after["feedback"]["legacy-dismissal"],
        before["feedback"]["legacy-dismissal"]
    );
    assert_eq!(
        after["feedback"]["unverified-dismissal"],
        before["feedback"]["unverified-dismissal"]
    );
    drop(ws);
    let ws = Workspace::open(dir.path(), "live", "repeated").unwrap();
    assert_eq!(ws.revisions().unwrap(), after);
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
    assert_eq!(
        util::hash(&Value::Null),
        fixture()["revisions"]["absent"].as_str().unwrap()
    );
}
#[test]
fn imported_configuration_cannot_bypass_monitoring_dispatcher_or_feedback_guards() {
    let base = fixture()["config"].clone();
    let search = base["searches"][0]["id"].clone();
    let mut bad = base.clone();
    bad["searches"][0]["id"] = json!("Wrong_ID");
    assert!(goodfinds::storage::validate_config(&bad).is_err());
    let monitoring = json!({"search_id":search,"preference":"recurring","interval_minutes":60,"timing":{"mode":"daily","times":["09:00"]},"schedule":null});
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
