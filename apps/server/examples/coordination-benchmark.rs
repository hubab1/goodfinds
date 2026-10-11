//! Synthetic, isolated benchmark: cargo run --profile test-support --features test-support
//! --manifest-path apps/server/Cargo.toml --example coordination-benchmark -- 0 10 20
use goodfinds::{diagnostics, storage::Workspace, util::id, workspace};
use serde_json::{Value, json};
use std::sync::{Arc, atomic::AtomicBool};

fn main() {
    let sizes: Vec<usize> = std::env::args()
        .skip(1)
        .map(|v| v.parse().unwrap())
        .collect();
    for size in if sizes.is_empty() {
        vec![0, 10, 20]
    } else {
        sizes
    } {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let call = |action: &str, args: Value| {
            workspace::execute(
                root,
                "benchmark",
                action,
                &args,
                Arc::new(AtomicBool::new(false)),
            )
        };
        let seeded = call("load_sample_workspace", json!({"mode":"sample"})).unwrap();
        let search = &seeded["state"]["searches"][0]["id"];
        let ws = Workspace::open(root, "sample", "benchmark").unwrap();
        let (document, first, last): (String, String, String) = ws
            .db
            .query_row(
                "SELECT document_json,first_observed_at,last_observed_at FROM listings LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        ws.db.execute_batch("BEGIN IMMEDIATE; DELETE FROM listings; DELETE FROM listing_observations; DELETE FROM listing_evaluations; DELETE FROM deal_alerts;").unwrap();
        for index in 0..size {
            let mut row: Value = serde_json::from_str(&document).unwrap();
            row["listing_id"] = json!(format!("benchmark-{index}"));
            ws.db
                .execute(
                    "INSERT INTO listings VALUES(?,'synthetic',?,?,?)",
                    rusqlite::params![
                        format!("synthetic:benchmark-{index}"),
                        row.to_string(),
                        first,
                        last
                    ],
                )
                .unwrap();
        }
        ws.db.execute_batch("COMMIT").unwrap();
        drop(ws);
        let run_id = id();
        call(
            "request_search_run",
            json!({"mode":"sample","request":{"search_id":search,"request_id":run_id}}),
        )
        .unwrap();
        let worker = id();
        call("claim_search_run",json!({"mode":"sample","request":{"run_id":run_id,"worker_id":worker,"agent_id":"benchmark","expected_version":0}})).unwrap();
        let mut samples = vec![];
        for _ in 0..12 {
            let (result, measurement) = diagnostics::capture(|| {
                call(
                    "renew_search_lease",
                    json!({"mode":"sample","request":{"run_id":run_id,"worker_id":worker}}),
                )
            });
            result.unwrap();
            samples.push(measurement);
        }
        samples.remove(0); // Warm validators and statements before comparing samples.
        let percentile = |key: &str, p: usize| {
            let mut values: Vec<f64> = samples
                .iter()
                .map(|s| s.pointer(key).and_then(Value::as_f64).unwrap_or(0.0))
                .collect();
            values.sort_by(f64::total_cmp);
            values[((values.len() - 1) * p).div_ceil(100)]
        };
        println!(
            "{}",
            json!({"listings":size,"samples":samples.len(),"p50_ms":percentile("/elapsed_ms",50),"p95_ms":percentile("/elapsed_ms",95),"transaction_p95_ms":percentile("/stages_ms/transaction",95),"result_bytes":samples[0]["result_bytes"],"counts":samples[0]["counts"]})
        );
    }
}
