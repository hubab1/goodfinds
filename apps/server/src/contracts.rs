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
    // The same union branches recur for every listing and history row. Compiling
    // each occurrence held command transactions open while rebuilding validators.
    // Include resolved definitions in the key so separate roots cannot share rules.
    cached_validator(&format!("branch:{schema}"), &schema)
        .is_ok_and(|validator| validator.is_valid(value))
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
    let validator = cached_validator(name, schema)?;
    let errors = validation_messages(&validator, &value);
    if !errors.is_empty() {
        return Err(Error::validation(format!("{name}: {}", errors.join("; "))));
    }
    Ok(value)
}
pub fn cached_validator(name: &str, schema: &Value) -> Result<Arc<jsonschema::Validator>> {
    let mut cache = VALIDATORS
        .lock()
        .map_err(|_| Error::new("internal_error", "Contract cache unavailable"))?;
    if let Some(v) = cache.get(name) {
        return Ok(v.clone());
    }
    let compiled = Arc::new(
        jsonschema::validator_for(schema)
            .map_err(|e| Error::new("internal_error", format!("Contract {name}: {e}")))?,
    );
    cache.insert(name.into(), compiled.clone());
    Ok(compiled)
}
/// Report actionable field paths together, without echoing entire submitted documents.
pub fn validation_messages(validator: &jsonschema::Validator, value: &Value) -> Vec<String> {
    fn collect(error: &jsonschema::ValidationError<'_>, out: &mut Vec<String>) {
        if out.len() >= 8 {
            return;
        }
        if let jsonschema::error::ValidationErrorKind::AnyOf { context }
        | jsonschema::error::ValidationErrorKind::OneOfNotValid { context } = error.kind()
        {
            // Input/saved variants often share failures; preserve their paths and deduplicate.
            for branch in context {
                for error in branch {
                    collect(error, out);
                }
            }
        } else {
            let message = format!("{}: {}", error.instance_path(), error.masked());
            if !out.contains(&message) {
                out.push(message);
            }
        }
    }
    let mut errors = vec![];
    for error in validator.iter_errors(value).take(8) {
        collect(&error, &mut errors);
    }
    errors
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cached_union_branches_keep_their_root_definitions() {
        let branch = json!({"$ref":"#/$defs/choice"});
        let number = json!({"$defs":{"choice":{"type":"integer"}}});
        let string = json!({"$defs":{"choice":{"type":"string"}}});
        for _ in 0..2 {
            assert!(branch_valid(&branch, &json!(4), &number));
            assert!(!branch_valid(&branch, &json!(4), &string));
            assert!(branch_valid(&branch, &json!("four"), &string));
            assert!(!branch_valid(&branch, &json!("four"), &number));
        }
    }
}
