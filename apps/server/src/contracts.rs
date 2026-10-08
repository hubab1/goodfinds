use crate::error::{Error, Result};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};
static CONTRACTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_reader(flate2::read::GzDecoder::new(
        &include_bytes!(concat!(env!("OUT_DIR"), "/contracts.json.gz"))[..],
    ))
    .expect("generated contracts")
});
static VALIDATORS: LazyLock<Mutex<HashMap<String, Arc<jsonschema::Validator>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub fn all() -> &'static Value {
    &CONTRACTS
}
pub fn data(name: &str) -> &'static Value {
    &CONTRACTS["data"][name]
}
pub fn schema(name: &str) -> Result<&'static Value> {
    CONTRACTS["schemas"]
        .get(name)
        .ok_or_else(|| Error::validation(format!("Unknown contract {name}")))
}
fn resolve<'a>(node: &'a Value, root: &'a Value) -> &'a Value {
    if let Some(reference) = node
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix('#'))
    {
        root.pointer(reference).unwrap_or(node)
    } else {
        node
    }
}
fn branch_valid(schema: &Value, value: &Value, root: &Value) -> bool {
    let mut schema = resolve(schema, root).clone();
    if let Some(defs) = root.get("$defs")
        && let Some(map) = schema.as_object_mut()
    {
        map.insert("$defs".into(), defs.clone());
    }
    jsonschema::validator_for(&schema).is_ok_and(|validator| validator.is_valid(value))
}
fn normalize(node: &Value, value: Option<&Value>, root: &Value) -> Option<Value> {
    let node = resolve(node, root);
    let mut value = match value {
        Some(v) => v.clone(),
        None => node.get("default")?.clone(),
    };
    if let Some(options) = node
        .get("anyOf")
        .or_else(|| node.get("oneOf"))
        .and_then(Value::as_array)
    {
        for option in options {
            if let Some(candidate) = normalize(option, Some(&value), root)
                && branch_valid(option, &candidate, root)
            {
                return Some(candidate);
            }
        }
        return Some(value);
    }
    if node.get("x-trim") == Some(&Value::Bool(true))
        && let Some(s) = value.as_str()
    {
        value = Value::String(s.trim().into());
    }
    if let Some(map) = value.as_object_mut() {
        if let Some(properties) = node.get("properties").and_then(Value::as_object) {
            for (name, property) in properties {
                if let Some(v) = normalize(property, map.get(name), root) {
                    map.insert(name.clone(), v);
                }
            }
            if node.get("x-unknown-keys").and_then(Value::as_str) == Some("strip") {
                map.retain(|k, _| properties.contains_key(k));
            }
        }
        if let Some(additional) = node.get("additionalProperties").filter(|v| v.is_object()) {
            let names: Vec<_> = map
                .keys()
                .filter(|k| node["properties"].get(k.as_str()).is_none())
                .cloned()
                .collect();
            for key in names {
                if let Some(v) = normalize(additional, map.get(&key), root) {
                    map.insert(key, v);
                }
            }
        }
    }
    if let Some(items) = value.as_array_mut()
        && let Some(item_schema) = node.get("items")
    {
        for item in items {
            if let Some(v) = normalize(item_schema, Some(item), root) {
                *item = v;
            }
        }
    }
    Some(value)
}
pub fn parse(name: &str, value: &Value) -> Result<Value> {
    let schema = schema(name)?;
    let value = normalize(schema, Some(value), schema).unwrap_or(Value::Null);
    let validator = {
        let mut cache = VALIDATORS
            .lock()
            .map_err(|_| Error::new("internal_error", "Contract cache unavailable"))?;
        if let Some(v) = cache.get(name) {
            v.clone()
        } else {
            let compiled = Arc::new(
                jsonschema::validator_for(schema)
                    .map_err(|e| Error::new("internal_error", format!("Contract {name}: {e}")))?,
            );
            cache.insert(name.into(), compiled.clone());
            compiled
        }
    };
    if let Some(e) = validator.iter_errors(&value).next() {
        return Err(Error::validation(format!(
            "{name} at {}: {e}",
            e.instance_path()
        )));
    }
    Ok(value)
}
pub fn operation_for_tool(name: &str) -> Option<&'static str> {
    CONTRACTS["operations"]
        .as_object()?
        .iter()
        .find(|(_, v)| {
            v["names"]
                .as_array()
                .is_some_and(|names| names.iter().any(|n| n.as_str() == Some(name)))
        })
        .map(|(key, _)| key.as_str())
}
pub fn merge(base: &mut Value, extras: &Value) {
    if let (Some(base), Some(extras)) = (base.as_object_mut(), extras.as_object()) {
        base.extend(extras.clone());
    }
}
pub fn object() -> Value {
    Value::Object(Map::new())
}
