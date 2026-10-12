use crate::{
    assets, connections, contracts,
    error::{Error, Result},
    media, searches, snapshot,
    storage::Workspace,
    util::*,
    workspace,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
pub fn error_result(error: &Error) -> Value {
    let mut result = data(json!({"error":error.details()}));
    result["isError"] = json!(true);
    result
}
pub fn data(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value})
}
pub fn resource(uri: &str) -> Result<Value> {
    let expected = contracts::all()["resources"][0]["uri"]
        .as_str()
        .unwrap_or("");
    if uri != expected {
        return Err(Error::validation("Unknown resource"));
    }
    Ok(
        json!({"contents":[{"uri":uri,"mimeType":"text/html;profile=mcp-app","text":assets::panel(),"_meta":{"openai/ui":{"availableDisplayModes":["inline","fullscreen"],"preferredDisplayMode":"fullscreen"},"ui":{"prefersBorder":false,"permissions":{"geolocation":{}},"csp":{"connectDomains":["https://ipwho.is","https://api.bigdatacloud.net","https://api.postcodes.io","https://api.zippopotam.us"],"resourceDomains":[]}}}}]}),
    )
}
pub fn call<'a>(
    root: &'a Path,
    context: &'a str,
    name: &'a str,
    args: &'a Value,
    cancel: Arc<AtomicBool>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send + 'a>> {
    Box::pin(async move {
        workspace::cancelled(&cancel)?;
        let contract = contracts::all()["tool_contracts"]
            .get(name)
            .ok_or_else(|| Error::validation("Unknown tool"))?;
        // Discovery schemas are compact hints; every transport enforces the full contract.
        let validator =
            contracts::cached_validator(&format!("tool:{name}"), &contract["inputSchema"])?;
        let errors = contracts::validation_messages(&validator, args);
        if !errors.is_empty() {
            return Err(Error::validation(format!(
                "Invalid arguments for {name}: {}",
                errors.join("; ")
            )));
        }
        if name == "open_goodfinds_location_chooser" {
            return crate::http::location(
                root.to_owned(),
                context.to_owned(),
                args["mode"].as_str().unwrap_or("live").to_owned(),
            )
            .await
            .map(|result| {
                let mut r = data(json!({"result":result}));
                r["content"][0]["text"] = json!(result.to_string());
                r
            });
        }
        let root = root.to_owned();
        let context = context.to_owned();
        let name = name.to_owned();
        let args = args.clone();
        tokio::task::spawn_blocking(move || sync_call(&root, &context, &name, &args, cancel))
            .await
            .map_err(|e| Error::new("internal_error", format!("Native tool task failed: {e}")))?
    })
}
fn sync_call(
    root: &Path,
    context: &str,
    name: &str,
    args: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<Value> {
    if let Some(action) = contracts::operation_for_tool(name) {
        if action == "save_search"
            && let Some(cover) = args["search"].get("cover")
        {
            let cover = searches::validate_cover(cover)?;
            media::read_image(root, text(&cover, "media_id"))?;
        }
        let result = workspace::execute(root, context, action, args, cancel)?;
        if contracts::all()["operations"][action]["kind"] == "query" {
            return Ok(data(result));
        }
        if ["get_workspace", "load_sample_workspace"].contains(&action) {
            let mut out = state_result(&result);
            add_panel_presentation(&mut out, name, args);
            return Ok(out);
        }
        let mut output = if let Some(saved) = result.get("operation_result") {
            let mut saved = saved.clone();
            if let Some(receipt) = result.get("receipt") {
                saved["receipt"] = receipt.clone();
            }
            contracts::parse(&format!("operations.{action}.output"), &saved)?
        } else {
            workspace::command_result(action, args, &result)?
        };
        // Unknown extras never cross the model-facing operation contract.
        output = contracts::parse(&format!("operations.{action}.output"), &output)?;
        let mut out = data(output);
        if let Some(state) = result.get("state") {
            out["_meta"] = json!({"goodfinds_state":state});
        }
        add_panel_presentation(&mut out, name, args);
        return Ok(out);
    }
    if connections::ACTIONS.contains(&name) {
        let mode = args["mode"].as_str().unwrap_or("live");
        let mut ws = Workspace::open(root, mode, context)?;
        ws.db.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            ws.reload_config()?;
            let result = connections::command(&mut ws, name, args)?;
            ws.save_config()?;
            let state = snapshot::snapshot(&ws)?;
            let result = contracts::parse("connectionCheckResultSchema", &result)?;
            workspace::cancelled(&cancel)?;
            let mut out = data(result);
            out["_meta"] = json!({"goodfinds_state":state});
            Ok(out)
        })();
        return match result {
            Ok(out) => {
                ws.db.execute_batch("COMMIT")?;
                Ok(out)
            }
            Err(e) => {
                let _ = ws.db.execute_batch("ROLLBACK");
                Err(e)
            }
        };
    }
    match name {
        "search_goodfinds_mentions" => crate::references::mentions(root, context, args).map(data),
        "get_goodfinds_tool_schema" => {
            let contract = contracts::all()["tool_contracts"]
                .get(text(args, "name"))
                .ok_or_else(|| Error::validation("Unknown tool"))?;
            Ok(data(contract.clone()))
        }
        "list_goodfinds_search_templates" => {
            Ok(data(json!({"templates":contracts::data("templates")})))
        }
        "list_goodfinds_search_covers" => {
            let mut covers = vec![];
            for entry in array(
                &json!({"items":contracts::data("bundledSearchCovers")}),
                "items",
            ) {
                if args
                    .get("category")
                    .is_some_and(|category| *category != entry["category"])
                {
                    continue;
                }
                let cover = contracts::parse(
                    "searchCoverSchema",
                    &json!({"media_id":entry["image"]["media_id"],"kind":entry["image"]["kind"],"alt":entry["image"]["alt"],"source_name":entry["image"]["source_name"]}),
                )?;
                covers.push(json!({"category":entry["category"],"preset":entry["preset"],"label":entry["image"]["label"],"cover":cover}));
            }
            Ok(data(json!({"covers":covers})))
        }
        "list_goodfinds_marketplace_capabilities" => {
            let mut marketplaces = contracts::data("MARKETPLACES").clone();
            for platform in marketplaces.as_array_mut().into_iter().flatten() {
                platform["home"] = json!(crate::regional::home_url(
                    text(platform, "id"),
                    text(args, "country"),
                    text(args, "locale")
                ));
            }
            let result = json!({"marketplaces":marketplaces,"message_execution":["facebook_marketplace"],"native_offer_execution":[],"contact_scope":"observed_per_listing"});
            let mut out = data(json!({"result":result}));
            out["content"][0]["text"] = json!(result.to_string());
            Ok(out)
        }
        "cache_goodfinds_images" | "cache_goodfinds_media" => {
            workspace::cancelled(&cancel)?;
            Ok(data(
                json!({"media":media::cache_files(root,&args["files"],name=="cache_goodfinds_media")?}),
            ))
        }
        "get_goodfinds_image" => match media::read_image(root, text(args, "media_id")) {
            Ok(image) => Ok(json!({"content":[image]})),
            Err(_) => Ok(
                json!({"isError":true,"content":[{"type":"text","text":"The saved image is unavailable."}]}),
            ),
        },
        "get_goodfinds_video" => Ok(
            json!({"content":[],"structuredContent":media::read_video(root,text(args,"media_id"))?}),
        ),
        "get_goodfinds_media_file" => {
            Ok(data(media::read_media_file(root, text(args, "media_id"))?))
        }
        "ask_goodfinds_search_question" => {
            let ws = Workspace::open(root, args["mode"].as_str().unwrap_or("live"), context)?;
            let prepared = searches::prepare_interview(&ws, args)?;
            let applied = searches::apply_interview(&prepared, "unsupported", &Value::Null, false)?;
            let state = snapshot::snapshot(&ws)?;
            Ok(state_result(
                &json!({"state":state,"interview":applied["interview"]}),
            ))
        }
        _ => Err(Error::validation("Unsupported tool")),
    }
}
fn pick(value: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for key in keys {
        if let Some(v) = value.get(key) {
            out[*key] = v.clone();
        }
    }
    out
}
fn add_panel_presentation(out: &mut Value, name: &str, args: &Value) {
    let search_id = match name {
        "start_goodfinds_search" => args["request"]["search_id"].as_str(),
        "open_goodfinds_panel" | "open_goodfinds_home" => args["search_id"].as_str(),
        _ => None,
    };
    if let Some(search_id) = search_id.filter(|id| !id.is_empty()) {
        out["_meta"]["goodfinds_panel"] = json!({"search_id":search_id});
    }
    if ["open_goodfinds_panel", "open_goodfinds_home"].contains(&name) {
        let presentation = &mut out["_meta"]["goodfinds_panel"];
        if presentation.is_null() {
            *presentation =
                json!({"view":if name=="open_goodfinds_home" {"searches"} else {"listings"}});
        }
        if let Some(key) = args["listing_key"].as_str() {
            presentation["listing_key"] = json!(key);
        }
    }
}

pub fn state_result(result: &Value) -> Value {
    let state = &result["state"];
    let summary = json!({"mode":state["mode"],"revision":state["revision"],"revisions":state["revisions"],"access_context":state["access_context"],"counts":state["counts"],"searches":array(state,"searches").iter().map(|s|pick(s,&["id","name","enabled","qualified_count","tracked_count","found_count","unseen_count","seen_count","last_searched_at","latest_found_at"])).collect::<Vec<_>>(),"drafts":array(state,"drafts").iter().map(|s|pick(s,&["id","name","values"])).collect::<Vec<_>>(),"search_runs":array(state,"search_runs").iter().map(|r|{let mut out=pick(r,&["id","search_id","version","phase","next_step","interruption","worker"]);out["progress"]=searches::search_progress(r);out}).collect::<Vec<_>>(),"seller_conversation":state["seller_conversation"],"attention_count":array(state,"next_steps").len(),"next_steps":array(state,"next_steps").iter().take(3).map(|s|pick(s,&["listing_key","search_id","title","label","readiness"])).collect::<Vec<_>>(),"monitoring":array(state,"monitoring").iter().map(|m|{let mut v=pick(m,&["search_id","preference","interval_minutes","timing","plan","quiet_now","next_allowed_at","status","label","next_action","host_schedule","interruption"]);for key in ["automation_id","thread_id","verified_at","last_run_at"]{v[key]=m["schedule"][key].clone();}v}).collect::<Vec<_>>(),"hint":"Use get_goodfinds_search_context for the brief and query plan; list_goodfinds_listings for paginated summaries; get_goodfinds_listing for evidence/history. The panel receives full state separately."});
    let mut compact = result.clone();
    compact["state"] = summary;
    for key in ["mode", "revision", "revisions"] {
        compact[key] = state[key].clone();
    }
    let mut out = data(compact);
    out["_meta"] = json!({"goodfinds_state":state});
    out
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[tokio::test]
    async fn compact_catalog_keeps_full_contract_validation() {
        let root = tempfile::tempdir().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let schema = call(
            root.path(),
            "catalog-test",
            "get_goodfinds_tool_schema",
            &json!({"name":"claim_goodfinds_search_run"}),
            cancel.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            schema["structuredContent"],
            contracts::all()["tool_contracts"]["claim_goodfinds_search_run"]
        );
        let invalid = call(
            root.path(),
            "catalog-test",
            "claim_goodfinds_search_run",
            &json!({"request":{"run_id":"3b107753-6c9b-49b7-ad9d-aedc8d63f477","expected_version":1,
                "worker_id":"3b107753-6c9b-49b7-ad9d-aedc8d63f477","agent_id":"/root",
                "execution":{"profile":"invented-profile"}}}),
            cancel.clone(),
        )
        .await
        .unwrap_err();
        assert!(invalid.message.contains("profile"));
        assert!(
            call(
                root.path(),
                "catalog-test",
                "claim_goodfinds_search_run",
                &json!({"request":{"run_id":"not-a-uuid","worker_id":"3b107753-6c9b-49b7-ad9d-aedc8d63f477","expected_version":1,"agent_id":"/root"}}),
                cancel.clone()
            )
            .await
            .is_err()
        );
        assert!(
            call(
                root.path(),
                "catalog-test",
                "get_goodfinds_tool_schema",
                &json!({"name":"missing_tool"}),
                cancel
            )
            .await
            .is_err()
        );
        assert!(!root.path().join("workspace.sqlite").exists());
    }
}
