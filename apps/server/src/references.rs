//! Bounded composer lookup and stable, readable references to saved buying data.
use crate::{
    error::{Error, Result},
    storage::Workspace,
    util::{array, text},
    workspace,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
use url::Url;

fn uri(mode: &str, kind: &str, id: &str) -> String {
    let mut url = Url::parse(&format!("goodfinds://{mode}/")).expect("resource base");
    url.path_segments_mut()
        .expect("resource path")
        .pop_if_empty()
        .push(kind)
        .push(id);
    url.into()
}

fn link(mode: &str, kind: &str, id: &str, title: &str, description: &str) -> Value {
    json!({"type":"resource_link","uri":uri(mode,kind,id),"name":title,"title":title,
        "description":description,"mimeType":"application/json"})
}

pub fn mentions(root: &Path, context: &str, args: &Value) -> Result<Value> {
    let mode = args["mode"].as_str().unwrap_or("live");
    let mut ws = Workspace::open(root, mode, context)?;
    ws.db.execute_batch("BEGIN DEFERRED")?;
    ws.reload_config()?;
    let query = text(args, "query").trim().to_lowercase();
    let mut searches: Vec<_> = array(&ws.config, "searches")
        .iter()
        .filter(|search| {
            ["name", "id", "product"]
                .iter()
                .any(|field| text(search, field).to_lowercase().contains(&query))
        })
        .collect();
    searches.sort_by_key(|search| (text(search, "name").to_lowercase(), text(search, "id")));
    let mut items: Vec<_> = searches
        .into_iter()
        .take(10)
        .map(|search| {
            link(
                mode,
                "searches",
                text(search, "id"),
                text(search, "name"),
                &format!(
                    "{}saved search · {}",
                    if mode == "sample" {
                        "Fictional sample · "
                    } else {
                        ""
                    },
                    text(search, "product")
                ),
            )
        })
        .collect();
    // Query only compact metadata. Typeahead never builds a panel snapshot or marks a listing seen.
    let mut statement = ws.db.prepare("SELECT listing_key, json_extract(document_json,'$.title'), json_extract(document_json,'$.source'), json_extract(document_json,'$.location') FROM listings WHERE provenance=?1 ORDER BY last_observed_at DESC, listing_key")?;
    let provenance = if mode == "sample" {
        "synthetic"
    } else {
        "manual"
    };
    let rows = statement.query_map([provenance], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut listing_count = 0;
    for row in rows {
        let (key, title, source, location) = row?;
        // SQLite's built-in lower() is ASCII-only; marketplace titles are Unicode.
        if ![
            key.as_str(),
            title.as_str(),
            location.as_deref().unwrap_or(""),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(&query))
        {
            continue;
        }
        items.push(link(
            mode,
            "listings",
            &key,
            &title,
            &format!(
                "{}Saved listing · {}{}",
                if mode == "sample" {
                    "Fictional sample · "
                } else {
                    ""
                },
                source,
                location.map(|s| format!(" · {s}")).unwrap_or_default()
            ),
        ));
        listing_count += 1;
        if listing_count == 10 {
            break;
        }
    }
    Ok(json!({"items":items}))
}

pub fn read(root: &Path, context: &str, resource: &str, cancel: Arc<AtomicBool>) -> Result<Value> {
    let url = Url::parse(resource).map_err(|_| Error::validation("Unknown Goodfinds resource"))?;
    let mode = url.host_str().unwrap_or("");
    if url.scheme() != "goodfinds"
        || !["live", "sample"].contains(&mode)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::validation("Unknown Goodfinds resource"));
    }
    // Protect form separators before using the URL decoder on a path component.
    let segments: Vec<String> = url
        .path()
        .trim_start_matches('/')
        .split('/')
        .map(|segment| {
            url::form_urlencoded::parse(
                format!("id={}", segment.replace('+', "%2B").replace('&', "%26")).as_bytes(),
            )
            .next()
            .map(|(_, id)| id.into_owned())
            .unwrap_or_default()
        })
        .collect();
    let [kind, id] = segments.as_slice() else {
        return Err(Error::validation("Unknown Goodfinds resource"));
    };
    if id.is_empty() || resource != uri(mode, kind, id) {
        return Err(Error::validation("Unknown Goodfinds resource"));
    }
    let value = match kind.as_str() {
        "listings" => workspace::execute(
            root,
            context,
            "get_listing",
            &json!({"mode":mode,"listing_key":id}),
            cancel,
        )?,
        "searches" => {
            let ws = Workspace::open(root, mode, context)?;
            let search = array(&ws.config, "searches")
                .iter()
                .find(|search| search["id"] == *id)
                .ok_or_else(|| Error::validation("This saved search is no longer available"))?;
            json!({"mode":mode,"search":search})
        }
        _ => return Err(Error::validation("Unknown Goodfinds resource")),
    };
    Ok(
        json!({"contents":[{"uri":resource,"mimeType":"application/json","text":value.to_string()}]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_references_read_current_values_and_reject_deleted_searches() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(root.path(), "live", "reference-test").unwrap();
        let id = "buying-laptop";
        let mut search = crate::contracts::data("example")["searches"][0].clone();
        search["id"] = json!(id);
        ws.config["searches"] = json!([search]);
        ws.save_config().unwrap();
        let reference = uri("live", "searches", id);
        let result = read(
            root.path(),
            "reference-test",
            &reference,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let value: Value = serde_json::from_str(text(&result["contents"][0], "text")).unwrap();
        assert_eq!(value["search"]["id"], id);
        ws.config["searches"] = json!([]);
        ws.save_config().unwrap();
        assert!(
            read(
                root.path(),
                "reference-test",
                &reference,
                Arc::new(AtomicBool::new(false))
            )
            .is_err()
        );
    }
}
