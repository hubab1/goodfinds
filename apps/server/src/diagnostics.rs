//! Opt-in, request-local measurements. No arguments, evidence or identities are logged.
use crate::error::Result;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, time::Instant};

#[derive(Default)]
struct Measurements {
    stages: BTreeMap<&'static str, f64>,
    counts: BTreeMap<&'static str, usize>,
}
thread_local! {
    static CURRENT: RefCell<Option<Measurements>> = const { RefCell::new(None) };
    static CAPTURE: RefCell<bool> = const { RefCell::new(false) };
    static LAST: RefCell<Value> = const { RefCell::new(Value::Null) };
}

pub fn operation(action: &str, run: impl FnOnce() -> Result<Value>) -> Result<Value> {
    let log = std::env::var("GOODFINDS_DIAGNOSTICS").is_ok_and(|v| v == "1");
    if !log && !CAPTURE.with(|v| *v.borrow()) {
        return run();
    }
    let previous = CURRENT.replace(Some(Measurements::default()));
    let started = Instant::now();
    let result = run();
    let measurements = CURRENT.replace(previous).unwrap_or_default();
    let report = json!({
        "kind":"goodfinds.operation", "operation":action,
        "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
        "stages_ms":measurements.stages,"counts":measurements.counts,
        "outcome":result.as_ref().map(|_| "success").unwrap_or_else(|e|e.code.as_str()),
        "result_bytes":result.as_ref().map(|v|v.to_string().len()).unwrap_or(0),
    });
    if log {
        eprintln!("{report}");
    }
    LAST.replace(report);
    result
}

pub struct Stage(&'static str, Option<Instant>);
pub fn stage(name: &'static str) -> Stage {
    Stage(
        name,
        CURRENT.with(|v| v.borrow().as_ref().map(|_| Instant::now())),
    )
}
impl Drop for Stage {
    fn drop(&mut self) {
        if let Some(start) = self.1 {
            CURRENT.with(|v| {
                if let Some(measurements) = v.borrow_mut().as_mut() {
                    *measurements.stages.entry(self.0).or_default() +=
                        start.elapsed().as_secs_f64() * 1000.0;
                }
            });
        }
    }
}
pub fn count(name: &'static str, amount: usize) {
    CURRENT.with(|v| {
        if let Some(measurements) = v.borrow_mut().as_mut() {
            *measurements.counts.entry(name).or_default() += amount;
        }
    });
}

#[cfg(any(test, feature = "test-support"))]
pub fn capture(run: impl FnOnce() -> Result<Value>) -> (Result<Value>, Value) {
    let previous = CAPTURE.replace(true);
    LAST.replace(Value::Null);
    let result = run();
    CAPTURE.replace(previous);
    (result, LAST.replace(Value::Null))
}
