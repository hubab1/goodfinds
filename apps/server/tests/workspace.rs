use goodfinds::{util, workspace};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::AtomicBool};
fn call(root: &std::path::Path, action: &str, args: Value) -> Value {
    workspace::execute(
        root,
        "00000000-0000-4000-8000-000000000001",
        action,
        &args,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap_or_else(|e| panic!("{action}: {e}"))
}
#[test]
fn empty_workspace_and_sample_are_isolated() {
    let root = tempfile::tempdir().unwrap();
    let live = call(root.path(), "get_workspace", json!({}));
    assert_eq!(live["state"]["searches"], json!([]));
    let sample = call(
        root.path(),
        "load_sample_workspace",
        json!({"mode":"sample"}),
    );
    assert!(!sample["state"]["listings"].as_array().unwrap().is_empty());
    assert_eq!(
        call(root.path(), "get_workspace", json!({}))["state"]["counts"]["listings"],
        0
    );
}
#[test]
fn settings_receipt_replay_and_conflict() {
    let root = tempfile::tempdir().unwrap();
    let state = call(root.path(), "get_workspace", json!({}));
    let args = json!({"settings":{"origin":"Fictional Town"},"expected_entity_revision":state["state"]["revisions"]["settings"],"request_id":util::id()});
    let a = call(root.path(), "save_settings", args.clone());
    let b = call(root.path(), "save_settings", args.clone());
    assert_eq!(a["receipt"]["replayed"], false);
    assert_eq!(b["receipt"]["replayed"], true);
    assert_eq!(a["operation_result"], b["operation_result"]);
    let mut changed = args.clone();
    changed["settings"]["origin"] = json!("Elsewhere");
    assert!(
        workspace::execute(
            root.path(),
            "context",
            "save_settings",
            &changed,
            Arc::new(AtomicBool::new(false))
        )
        .is_err()
    );
}
#[test]
fn compact_queries_validate() {
    let root = tempfile::tempdir().unwrap();
    for action in [
        "get_settings",
        "get_search_context",
        "get_monitoring",
        "list_next_steps",
        "list_activity",
        "list_listings",
        "list_media_repairs",
        "list_journey_checks",
        "list_search_runs",
    ] {
        call(root.path(), action, json!({}));
    }
}
#[test]
fn legacy_hashes_preserve_unicode_and_javascript_numbers() {
    let cases: Value = serde_json::from_str(include_str!("data/hash-parity.json")).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(util::canonical(&case["value"]), case["canonical"]);
        assert_eq!(util::hash(&case["value"]), case["hash"]);
    }
}
#[test]
fn cancelling_a_mutation_keeps_configuration_and_receipts_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let state = call(root.path(), "get_workspace", json!({}));
    let args = json!({"settings":{"origin":"Must not save"},"expected_entity_revision":state["state"]["revisions"]["settings"],"request_id":util::id()});
    assert!(
        workspace::execute(
            root.path(),
            "context",
            "save_settings",
            &args,
            Arc::new(AtomicBool::new(true))
        )
        .is_err()
    );
    let after = call(root.path(), "get_workspace", json!({}));
    assert_eq!(after["state"]["config"], state["state"]["config"]);
    assert_eq!(after["state"]["revisions"], state["state"]["revisions"]);
}
