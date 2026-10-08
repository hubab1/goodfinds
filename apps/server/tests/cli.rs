use serde_json::Value;
use std::{path::Path, process::Command};
fn run(root: &Path, args: &[&str]) -> Value {
    let result = Command::new(env!("CARGO_BIN_EXE_goodfinds"))
        .env("GOODFINDS_WORKSPACE_DIR", root)
        .env("PATH", "")
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
#[test]
fn cli_backup_restore_export_and_demo_use_native_executable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    let sample = dir.path().join("demo");
    let result = run(&root, &["demo", "--output", sample.to_str().unwrap()]);
    assert_eq!(result["mode"], "synthetic");
    assert_eq!(result["second_run_new_alerts"], 0);
    let db = sample.join("demo.sqlite");
    let backup = dir.path().join("backup");
    let restored = dir.path().join("restored");
    assert_eq!(
        run(
            &root,
            &[
                "backup",
                "--db",
                db.to_str().unwrap(),
                "--output",
                backup.to_str().unwrap()
            ]
        )["files"],
        1
    );
    run(
        &root,
        &[
            "restore",
            "--input",
            backup.to_str().unwrap(),
            "--output",
            restored.to_str().unwrap(),
        ],
    );
    let restored_db = restored.join("workspace.sqlite");
    let status = run(&root, &["status", "--db", restored_db.to_str().unwrap()]);
    assert_eq!(status["listing_evaluations"], 2);
    let export = dir.path().join("workspace.json");
    run(
        &root,
        &[
            "export",
            "--db",
            restored_db.to_str().unwrap(),
            "--output",
            export.to_str().unwrap(),
        ],
    );
    let config: Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
    assert!(config["searches"].is_array());
    let failed = Command::new(env!("CARGO_BIN_EXE_goodfinds"))
        .env("GOODFINDS_WORKSPACE_DIR", root)
        .env("PATH", "")
        .args([
            "restore",
            "--input",
            backup.to_str().unwrap(),
            "--output",
            restored.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(failed.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&failed.stderr)
            .contains("existing workspaces and backups are preserved")
    );
}
#[test]
fn cli_doctor_uses_real_self_spawned_stdio_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let ready = run(dir.path(), &["doctor"]);
    assert_eq!(ready["status"], "ready");
    assert!(ready["tools"].as_u64().unwrap() > 60);
    assert_eq!(ready["panel_resource"], true);
    assert_eq!(ready["context_readable"], true);
}
#[test]
fn closing_stdio_before_initialization_exits_quietly() {
    let root = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_goodfinds"))
        .env("GOODFINDS_WORKSPACE_DIR", root.path())
        .env("PATH", "")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{:?}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
    assert!(!root.path().join("workspace.sqlite").exists());
}
