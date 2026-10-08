use crate::error::{Error, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
pub const DAY: i64 = 86_400_000;
pub fn now() -> i64 {
    Utc::now().timestamp_millis()
}
pub fn iso(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value)
        .expect("valid timestamp")
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn time(value: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(value)
        .map(|x| x.timestamp_millis())
        .map_err(|_| Error::validation("Invalid timestamp; include a timezone"))
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn ascii(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ('\u{7f}'..='\u{ffff}').contains(&ch) {
            for unit in ch.encode_utf16(&mut [0; 2]) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        } else {
            out.push(ch);
        }
    }
    out
}
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}: {}",
                        canonical(&Value::String(k.clone())),
                        canonical(&map[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(", ")
        ),
        Value::Number(n) if n.as_f64() == Some(0.0) => "0".into(),
        Value::Number(n) => ryu_js::Buffer::new()
            .format(n.as_f64().expect("JSON number"))
            .to_owned(),
        _ => ascii(&serde_json::to_string(value).expect("JSON value")),
    }
}
pub fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(value).as_bytes()))
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
pub fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}
pub fn integer(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
pub fn bool_(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
