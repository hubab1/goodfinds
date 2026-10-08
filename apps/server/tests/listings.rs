use goodfinds::{
    listings, media,
    storage::Workspace,
    util::{canonical, iso},
};
use serde_json::{Value, json};
fn fixture() -> Value {
    serde_json::from_str(include_str!("data/listing-parity.json")).unwrap()
}
fn equal(actual: &Value, expected: &Value) {
    assert_eq!(canonical(actual), canonical(expected));
}
#[test]
fn typescript_parity_normalization_evaluation_history_and_quality() {
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    let rows = listings::normalize_observations(&f["input"], true, now).unwrap();
    equal(&json!(rows), &f["normalized"]);
    let config = &f["config"];
    let search = &config["searches"][0];
    let pool = listings::comparison_pool(&rows, search, config, now, true);
    equal(
        &json!(
            rows.iter()
                .map(|r| listings::evaluate_listing(r, &pool, search, config, now, true))
                .collect::<Vec<_>>()
        ),
        &f["decisions"],
    );
    let (current, events) = listings::rebuild_history(
        f["normalized"][0]["key"].as_str().unwrap(),
        f["history_input"].as_array().unwrap(),
    )
    .unwrap();
    equal(&current, &f["history_current"]);
    equal(&json!(events), &f["history_events"]);
    equal(
        &listings::quality(&current, config, now, &[]),
        &f["quality"],
    );
}
#[test]
fn sqlite_alert_outbox_deduplicates_and_rechecks_preserve_discovery() {
    let folder = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(folder.path(), "sample", "native-tests").unwrap();
    let f = fixture();
    ws.now = f["now"].as_i64().unwrap();
    ws.config = f["config"].clone();
    ws.save_config().unwrap();
    let first = listings::evaluate(&mut ws, &f["input"], &Value::Null).unwrap();
    assert!(!first["new_alerts"].as_array().unwrap().is_empty());
    let second = listings::evaluate(&mut ws, &f["input"], &Value::Null).unwrap();
    assert_eq!(second["new_alerts"], json!([]));
    let rows = listings::load(&ws).unwrap();
    assert_eq!(rows.len(), f["input"].as_array().unwrap().len());
    let row = &rows[0];
    let key = row["key"].clone();
    let search = ws.config["searches"][0]["id"].clone();
    listings::command(
        &mut ws,
        "set_listing_seen",
        &json!({"listings":[{"listing_key":key,"search_id":search}],"seen":true}),
    )
    .unwrap();
    let original = listings::find(&ws, key.as_str().unwrap()).unwrap().unwrap()["seen_in_searches"]
        [0]["seen_at"]
        .clone();
    ws.now += 3600000;
    listings::command(
        &mut ws,
        "set_listing_seen",
        &json!({"listings":[{"listing_key":key,"search_id":search}],"seen":true}),
    )
    .unwrap();
    assert_eq!(
        listings::find(&ws, key.as_str().unwrap()).unwrap().unwrap()["seen_in_searches"][0]["seen_at"],
        original
    );
    let ids = first["new_alerts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(listings::acknowledge(&mut ws, &ids).unwrap(), ids.len());
    assert!(listings::acknowledge(&mut ws, &ids).is_err());
    listings::command(
        &mut ws,
        "set_listing_seen",
        &json!({"listings":[{"listing_key":key,"search_id":search}],"seen":false}),
    )
    .unwrap();
    assert_eq!(
        listings::find(&ws, key.as_str().unwrap()).unwrap().unwrap()["seen_in_searches"],
        json!([])
    );
}
#[test]
fn normalization_rejects_identity_gallery_and_temporal_fabrication() {
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    let base = f["input"][0].clone();
    let mut row = base.clone();
    row["url"] = json!("https://facebook.com/marketplace/item/12345/");
    assert!(listings::normalize(&row, true, now).is_err());
    row = base.clone();
    row["observed_at"] = json!(iso(now + 300001));
    assert!(listings::normalize(&row, true, now).is_err());
    row = base.clone();
    row["image_review"] =
        json!({"complete":true,"total_images":2,"reviewed_positions":[1],"notes":"Inspected one"});
    assert!(listings::normalize(&row, true, now).is_err());
    row = base.clone();
    row["publication"] = json!({"kind":"published","precision":"exact","earliest_at":iso(now-DAY),"latest_at":iso(now),"evidence":"Published"});
    assert!(listings::normalize(&row, true, now).is_err());
    row = base.clone();
    row["cash_price_minor"] = json!(100);
    assert!(listings::normalize(&row, true, now).is_err());
    row = base.clone();
    row["price_period"] = json!("month");
    row["finance_price_minor"] = json!(100);
    let normalized = listings::normalize(&row, true, now).unwrap();
    assert_eq!(normalized["price_minor"], Value::Null);
    assert!(normalized.get("finance_price_minor").is_none());
}
const DAY: i64 = 86_400_000;
#[test]
fn journey_cache_checks_origin_and_does_not_refresh_observation_time() {
    let folder = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(folder.path(), "sample", "native-tests").unwrap();
    let f = fixture();
    ws.now = f["now"].as_i64().unwrap();
    ws.config = f["config"].clone();
    ws.config["origin_confirmed"] = json!(true);
    ws.save_config().unwrap();
    let mut input = f["input"][0].clone();
    input["location"] = json!("Example destination town");
    listings::evaluate(&mut ws, &json!([input]), &Value::Null).unwrap();
    let row = listings::load(&ws).unwrap().remove(0);
    let origin = listings::journey_origin_key(&ws.config);
    let report = json!({"origin_key":origin,"destination":"Example destination town","country":ws.config["location"]["country"],"listing_keys":[row["key"]],"drive_minutes":25,"precision":"town","estimate_kind":"typical","source_url":"https://www.google.com/maps/dir/?api=1","evidence":"Google Maps directions displayed 25 minutes","checked_at":iso(ws.now)});
    listings::command(&mut ws, "record_journey_check", &json!({"report":report})).unwrap();
    let next = listings::load(&ws).unwrap().remove(0);
    assert_eq!(next["drive_minutes"], 25);
    assert_eq!(next["observed_at"], row["observed_at"]);
    ws.config["origin"] = json!("Another example origin");
    assert!(listings::command(&mut ws, "record_journey_check", &json!({"report":report})).is_err());
}
#[test]
fn media_repair_preserves_fact_timestamps_and_invalid_files_are_rejected() {
    let folder = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(folder.path(), "sample", "native-tests").unwrap();
    let f = fixture();
    ws.now = f["now"].as_i64().unwrap();
    ws.config = f["config"].clone();
    ws.save_config().unwrap();
    listings::evaluate(&mut ws, &json!([f["input"][0]]), &Value::Null).unwrap();
    let row = listings::load(&ws).unwrap().remove(0);
    let file = folder.path().join("test.jpg");
    std::fs::write(&file, [255u8, 216, 255, 0]).unwrap();
    let saved = media::cache_files(
        folder.path(),
        &json!([{"path":file,"label":"Example image"}]),
        false,
    )
    .unwrap();
    let args = json!({"listing_key":row["key"],"photos":[{"media_id":saved[0]["id"],"position":1,"caption":"Example image"}],"videos":[],"media_capture":{"status":"complete","expected_photos":1,"expected_videos":0,"captured_at":iso(ws.now)}});
    listings::command(&mut ws, "attach_listing_media", &args).unwrap();
    let next = listings::load(&ws).unwrap().remove(0);
    assert_eq!(next["photos"].as_array().unwrap().len(), 1);
    assert_eq!(next["observed_at"], row["observed_at"]);
    assert_ne!(next["image_review"]["complete"], true);
    let mut broken = args.clone();
    broken["photos"][0]["media_id"] =
        json!("0000000000000000000000000000000000000000000000000000000000000000");
    assert!(listings::command(&mut ws, "attach_listing_media", &broken).is_err());
}
#[test]
fn typescript_parity_outliers_merging_duplicates_and_coverage_rates() {
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    let advanced = &f["advanced"];
    equal(
        &listings::quality(
            &advanced["candidate"],
            &f["config"],
            now,
            advanced["peers"].as_array().unwrap(),
        ),
        &advanced["quality"],
    );
    equal(
        &listings::credibility_check(
            &advanced["candidate"],
            advanced["peers"].as_array().unwrap(),
            &f["config"],
            now,
        ),
        &advanced["credibility"],
    );
    let (current, events) = listings::rebuild_history(
        f["normalized"][0]["key"].as_str().unwrap(),
        advanced["mixed_history"].as_array().unwrap(),
    )
    .unwrap();
    equal(&current, &advanced["mixed_current"]);
    equal(&json!(events), &advanced["mixed_events"]);
    equal(
        &json!(listings::distinct(
            advanced["duplicates"].as_array().unwrap()
        )),
        &advanced["distinct"],
    );
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path(), "sample", "native-tests").unwrap();
    ws.now = now;
    ws.config = f["config"].clone();
    for (i, run) in advanced["coverage"].as_array().unwrap().iter().enumerate() {
        ws.db
            .execute(
                "INSERT INTO search_coverage VALUES(?,?,?)",
                rusqlite::params![
                    format!("coverage-{i}"),
                    "golden-evaluation",
                    run.to_string()
                ],
            )
            .unwrap();
    }
    equal(
        &listings::insights(
            &ws,
            advanced["peers"].as_array().unwrap(),
            &f["config"]["searches"][0],
            advanced["peers"].as_array().unwrap(),
        )
        .unwrap(),
        &advanced["insights"],
    );
}
#[test]
fn listing_query_keeps_inboxes_scoped_and_workflow_matches_typescript() {
    let f = fixture();
    let now = f["now"].as_i64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::open(dir.path(), "sample", "native-tests").unwrap();
    ws.now = now;
    ws.config = f["config"].clone();
    let search = ws.config["searches"][0].clone();
    let search_id = search["id"].clone();
    let decisions = f["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            let mut d = d.clone();
            d["search_id"] = search_id.clone();
            d
        })
        .collect::<Vec<_>>();
    let mut state = json!({"config":ws.config,"listings":f["normalized"],"decisions":decisions,"next_steps":[],"seller_conversations":[]});
    equal(
        &listings::listing_workflow(&f["normalized"][0], &state, now, &search_id),
        &f["workflow"],
    );
    state["listings"][0]["seen_in_searches"] = json!([{"search_id":search_id,"seen_at":iso(now)}]);
    state["listings"][1]["first_found_runs"] = json!([{"search_id":"another-search","run_id":"a0000000-0000-4000-8000-000000000001","run_started_at":iso(now)}]);
    let unseen = listings::query(
        &ws,
        "list_listings",
        &json!({"search_id":search_id,"seen":"unseen","limit":100}),
        &state,
    )
    .unwrap();
    assert!(
        !unseen["listings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["key"] == state["listings"][0]["key"]
                || r["key"] == state["listings"][1]["key"])
    );
    let seen = listings::query(
        &ws,
        "list_listings",
        &json!({"search_id":search_id,"seen":"seen","limit":100}),
        &state,
    )
    .unwrap();
    assert_eq!(seen["total"], 1);
    let all = listings::query(
        &ws,
        "list_listings",
        &json!({"search_id":search_id,"sort":"price_low","limit":1}),
        &state,
    )
    .unwrap();
    assert_eq!(all["next_offset"], 1);
    assert_eq!(all["listings"][0]["price_minor"], 110000);
    assert!(
        listings::query(
            &ws,
            "list_listings",
            &json!({"seller_filters":{"minimum_listings":10,"maximum_listings":2}}),
            &state
        )
        .is_err()
    );
    assert!(
        listings::query(
            &ws,
            "list_listings",
            &json!({"seller_filters":{"joined_by":9999}}),
            &state
        )
        .is_err()
    );
}
