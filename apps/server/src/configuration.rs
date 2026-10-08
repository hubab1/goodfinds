use crate::{
    contracts,
    error::{Error, Result},
    searches,
    storage::Workspace,
    util::*,
};
use serde_json::{Value, json};
pub const ACTIONS: &[&str] = &[
    "save_search",
    "set_search_cover",
    "save_search_draft",
    "discard_search_draft",
    "set_search_enabled",
    "remove_search",
    "save_settings",
    "record_listing_feedback",
    "undo_listing_feedback",
    "report_browser_access",
    "report_marketplace_session",
    "report_connections",
    "report_listing_contact",
];
pub fn check_revision(ws: &Workspace, action: &str, args: &Value) -> Result<()> {
    let target = match action {
        "save_search" => ("searches", args["search"]["id"].as_str()),
        "set_search_cover" | "set_search_enabled" | "remove_search" => {
            ("searches", args["search_id"].as_str())
        }
        "save_search_draft" => ("drafts", args["draft"]["id"].as_str()),
        "discard_search_draft" => ("drafts", args["draft_id"].as_str()),
        "set_monitoring" => ("monitoring", args["monitoring"]["search_id"].as_str()),
        "report_host_schedule" => ("monitoring", args["report"]["search_id"].as_str()),
        "save_settings" | "report_dispatcher_schedule" => ("settings", None),
        "record_listing_feedback" => ("feedback", None),
        "undo_listing_feedback" => ("feedback", args["feedback_id"].as_str()),
        "report_browser_access"
        | "report_marketplace_session"
        | "report_connections"
        | "report_listing_contact" => ("evidence", None),
        _ => return Ok(()),
    };
    let revisions = ws.revisions()?;
    let current = if matches!(target.0, "settings" | "evidence") {
        &revisions[target.0]
    } else {
        target
            .1
            .and_then(|id| revisions[target.0].get(id))
            .unwrap_or(&revisions["absent"])
    };
    if args.get("expected_entity_revision") != Some(current) {
        return Err(Error::conflict(
            format!(
                "{}{}",
                target.0,
                target.1.map(|id| format!(":{id}")).unwrap_or_default()
            ),
            current.as_str().unwrap_or_default(),
        ));
    }
    if action == "save_search"
        && let Some(id) = args["draft_id"].as_str()
    {
        let current = revisions["drafts"].get(id).unwrap_or(&revisions["absent"]);
        if &args["expected_draft_revision"] != current {
            return Err(Error::conflict(
                format!("drafts:{id}"),
                current.as_str().unwrap_or_default(),
            ));
        }
    }
    Ok(())
}
fn find(config: &Value, key: &str, id: &str) -> Result<usize> {
    array(config, key)
        .iter()
        .position(|x| text(x, "id") == id)
        .ok_or_else(|| {
            Error::new(
                "missing_search",
                format!(
                    "That {} no longer exists",
                    if key == "drafts" {
                        "unfinished search"
                    } else {
                        "search"
                    }
                ),
            )
        })
}
pub fn command(ws: &mut Workspace, action: &str, args: &Value) -> Result<Value> {
    check_revision(ws, action, args)?;
    let mut config = ws.config.clone();
    match action {
        "save_search" => {
            if let Some(draft) = args["draft_id"].as_str() {
                find(&config, "drafts", draft)?;
            }
            let mut search = searches::normalize_search(&args["search"])?;
            let index = array(&config, "searches")
                .iter()
                .position(|s| s["id"] == search["id"]);
            if let Some(index) = index {
                let prev = &config["searches"][index];
                for key in ["marketplaces", "discovery"] {
                    if search.get(key).is_none()
                        && let Some(value) = prev.get(key)
                    {
                        search[key] = value.clone();
                    }
                }
                if hash(&prev["definition"]) != hash(&search["definition"])
                    && search["definition"]["version"].as_i64().unwrap_or(0)
                        <= prev["definition"]["version"].as_i64().unwrap_or(0)
                {
                    return Err(Error::validation(
                        "Increase the definition version when changing its fields",
                    ));
                }
                let subject_changed = prev["product"] != search["product"]
                    || crate::searches::search_cover_product(prev).map(|x| x.to_lowercase())
                        != crate::searches::search_cover_product(&search).map(|x| x.to_lowercase());
                let preset_changed = prev["product"] != "rental"
                    && prev["cover"]["kind"] == "generated"
                    && searches::is_bundled_cover(text(&prev["cover"], "media_id"))
                    && searches::bundled_cover_for(prev).map(|c| c["media_id"].clone())
                        != searches::bundled_cover_for(&search).map(|c| c["media_id"].clone());
                if (subject_changed || preset_changed)
                    && (search.get("cover").is_none()
                        || hash(&search["cover"]) == hash(&prev["cover"]))
                {
                    search.as_object_mut().unwrap().remove("cover");
                } else if search.get("cover").is_none()
                    && prev["product"] == search["product"]
                    && let Some(cover) = prev.get("cover")
                {
                    search["cover"] = cover.clone();
                }
                config["searches"][index] = search;
            } else {
                config["searches"].as_array_mut().unwrap().push(search);
            }
            if let Some(draft) = args["draft_id"].as_str() {
                config["drafts"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|d| text(d, "id") != draft);
            }
        }
        "set_search_cover" => {
            let index = find(&config, "searches", text(args, "search_id"))?;
            let cover = args.get("cover").ok_or_else(|| {
                Error::validation("Choose a search cover or null to restore the default")
            })?;
            if cover.is_null() {
                config["searches"][index]
                    .as_object_mut()
                    .unwrap()
                    .remove("cover");
            } else {
                let cover = searches::validate_cover(cover)?;
                if ["manufacturer", "area", "stock"].contains(&text(&cover, "kind"))
                    && text(&cover, "source_url").is_empty()
                {
                    return Err(Error::validation("Include the image's source page"));
                }
                if cover["kind"] == "generated" && text(&cover, "prompt").is_empty() {
                    return Err(Error::validation("Keep the image generation prompt"));
                }
                let search = &mut config["searches"][index];
                if search["product"] == "rental"
                    && cover.get("location").is_some()
                    && cover["location"] != search["values"]["area"]
                {
                    return Err(Error::validation(
                        "The search cover location must match the saved rental area",
                    ));
                }
                crate::media::read_image(&ws.root, text(&cover, "media_id"))?;
                search["cover"] = cover;
            }
        }
        "save_search_draft" => {
            let mut draft = searches::normalize_draft(&args["draft"])?;
            if draft.get("id").is_none() {
                draft["id"] = json!(format!("draft-{}", &id()[..8]));
            }
            draft["values"] =
                searches::clean_answers(&draft["definition"], &draft["values"], true)?;
            if let Some(index) = array(&config, "drafts")
                .iter()
                .position(|d| d["id"] == draft["id"])
            {
                let prev = &config["drafts"][index];
                if hash(&prev["definition"]) != hash(&draft["definition"])
                    && draft["definition"]["version"].as_i64().unwrap_or(0)
                        <= prev["definition"]["version"].as_i64().unwrap_or(0)
                {
                    return Err(Error::validation(
                        "Increase the definition version when changing its fields",
                    ));
                }
                config["drafts"][index] = draft;
            } else {
                config["drafts"].as_array_mut().unwrap().push(draft);
            }
        }
        "discard_search_draft" => config["drafts"]
            .as_array_mut()
            .unwrap()
            .retain(|d| d["id"] != args["draft_id"]),
        "set_search_enabled" => {
            let index = find(&config, "searches", text(args, "search_id"))?;
            config["searches"][index]["enabled"] = args["enabled"].clone();
        }
        "remove_search" => {
            let id = text(args, "search_id");
            let index = find(&config, "searches", id)?;
            let fulfilled = crate::sellers::fulfilled_searches(&crate::sellers::summaries(ws)?);
            let own_active = array(&config, "monitoring")
                .iter()
                .any(|m| text(m, "search_id") == id && m["schedule"]["status"] == "active");
            let shared_active = array(&config, "dispatchers").iter().any(|d| {
                array(d, "search_ids")
                    .iter()
                    .any(|v| v.as_str() == Some(id))
                    && d["schedule"]["status"] == "active"
                    && array(d, "search_ids").iter().all(|v| {
                        v.as_str() == Some(id)
                            || fulfilled.contains(v.as_str().unwrap_or(""))
                            || !array(&config, "searches")
                                .iter()
                                .any(|s| s["id"] == *v && bool_(s, "enabled"))
                            || !array(&config, "monitoring")
                                .iter()
                                .any(|m| m["search_id"] == *v && m["preference"] == "recurring")
                    })
            });
            if own_active || shared_active {
                return Err(Error::validation(
                    "Pause and verify this search's host schedule before removing it",
                ));
            }
            config["searches"].as_array_mut().unwrap().remove(index);
            config["monitoring"]
                .as_array_mut()
                .unwrap()
                .retain(|m| text(m, "search_id") != id);
            for d in config["dispatchers"].as_array_mut().unwrap() {
                d["search_ids"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|v| v.as_str() != Some(id));
            }
        }
        "record_listing_feedback" => {
            let mut feedback = contracts::parse("feedbackInputSchema", &args["feedback"])?;
            if bool_(&feedback, "exclude_model")
                && (feedback["action"] != "dismiss" || text(&feedback, "reason").is_empty())
            {
                return Err(Error::validation(
                    "Model exclusion needs an explicit dismissal reason",
                ));
            }
            if feedback.get("rule").is_some() && text(&feedback, "reason").is_empty() {
                return Err(Error::validation(
                    "An explicit preference needs the buyer's original reason",
                ));
            }
            if ["constructor", "prototype"].contains(&text(&feedback["rule"], "attribute")) {
                return Err(Error::validation("Choose a different attribute"));
            }
            let search = array(&config, "searches")
                .iter()
                .find(|s| s["id"] == feedback["search_id"])
                .ok_or_else(|| Error::new("missing_search", "That search no longer exists"))?;
            let rows = crate::listings::load(ws)?;
            let row = rows
                .iter()
                .find(|r| r["key"] == feedback["listing_key"] && r["product"] == search["product"])
                .ok_or_else(|| Error::validation("Choose a listing belonging to this search"))?;
            if bool_(&feedback, "exclude_model")
                || (feedback.get("exclude_model").is_none()
                    && feedback["reason"] == "Not interested in this model")
            {
                feedback["rule"]=model_exclusion_rule(row,search).ok_or_else(||Error::validation("The model is not verified. Dismiss just this listing or identify the model before excluding it."))?;
                feedback["exclude_model"] = json!(true);
            }
            feedback["id"] = json!(id());
            feedback["category"] = search["product"].clone();
            feedback["created_at"] = json!(iso(ws.now));
            feedback["undone"] = json!(false);
            config["feedback"].as_array_mut().unwrap().push(feedback);
        }
        "undo_listing_feedback" => {
            let event = config["feedback"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|v| v["id"] == args["feedback_id"])
                .ok_or_else(|| Error::new("missing_search", "That feedback no longer exists"))?;
            event["undone"] = json!(true);
        }
        "save_settings" => {
            let settings = contracts::parse("settingsSchema", &args["settings"])?;
            if let Some(location) = settings.get("location") {
                validate_location(location)?;
            }
            if let Some(quiet) = settings.get("quiet_hours") {
                searches::validate_quiet_hours(quiet)?;
            }
            for (key, value) in settings.as_object().unwrap() {
                if ["interval_minutes", "quiet_hours"].contains(&key.as_str()) {
                    config["schedule"][key] = value.clone();
                } else {
                    config[key] = value.clone();
                }
            }
            if let Some(location) = settings.get("location") {
                if location.is_null() {
                    config["origin_confirmed"] = json!(false);
                } else {
                    config["origin"] = if location["display"] == "postal" {
                        location
                            .get("postal_code")
                            .filter(|v| !v.is_null())
                            .unwrap_or(&location["area"])
                            .clone()
                    } else {
                        location["area"].clone()
                    };
                    config["origin_confirmed"] = json!(true);
                }
            } else if settings.get("origin").is_some() {
                config["origin_confirmed"] = json!(true);
                config["location"] = Value::Null;
            }
        }
        name if name.starts_with("report_") => {
            crate::connections::report(ws, name, args)?;
            return Ok(json!({}));
        }
        _ => return Err(Error::validation("Unsupported configuration action")),
    }
    for search in config["searches"].as_array_mut().unwrap() {
        if search["product"] == "rental"
            && search["cover"].get("location").is_some()
            && search["cover"]["location"] != search["values"]["area"]
        {
            search.as_object_mut().unwrap().remove("cover");
        }
    }
    ws.config = crate::storage::validate_config(&config)?;
    Ok(json!({}))
}
pub fn model_exclusion_rule(row: &Value, search: &Value) -> Option<Value> {
    let attribute = search["discovery"]["model_attribute"]
        .as_str()
        .unwrap_or("model");
    let value = row["attributes"]
        .get(attribute)
        .filter(|v| !v.is_null())
        .or_else(|| row.get(attribute))?
        .as_str()?
        .trim();
    if value.is_empty()
        || row["evidence"][attribute]
            .as_str()
            .unwrap_or("")
            .trim()
            .is_empty()
        || regex::Regex::new(r"(?i)\b(unknown|unconfirmed|unidentified|unsure|not known)\b")
            .unwrap()
            .is_match(value)
    {
        return None;
    }
    let model = array(&search["discovery"], "model_aliases")
        .iter()
        .find(|item| {
            std::iter::once(&item["canonical"])
                .chain(array(item, "aliases"))
                .any(|v| {
                    v.as_str().is_some_and(|v| {
                        searches::normalize_name(v) == searches::normalize_name(value)
                    })
                })
        })
        .and_then(|v| v["canonical"].as_str())
        .unwrap_or(value);
    Some(
        json!({"attribute":attribute,"operator":"neq","value":model,"importance":"required","label":format!("Exclude {model}")}),
    )
}

pub fn validate_location(input: &Value) -> Result<Value> {
    if input.is_null() {
        return Ok(Value::Null);
    }
    let location = contracts::parse("locationSchema", input)?;
    if location["latitude"].is_null() != location["longitude"].is_null() {
        return Err(Error::validation(
            "Latitude and longitude must be supplied together",
        ));
    }
    if location["source"] != "manual" && location["latitude"].is_null() {
        return Err(Error::validation("Detected locations need coordinates"));
    }
    if location["display"] == "postal" && text(&location, "postal_code").is_empty() {
        return Err(Error::validation(
            "Enter a postal code before choosing postal display",
        ));
    }
    Ok(location)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_changed_vehicle_type_releases_the_previous_bundled_default() {
        let root = tempfile::tempdir().unwrap();
        let mut ws = Workspace::open(root.path(), "live", "test").unwrap();
        ws.automations_directory = None;
        let mut saved=searches::normalize_search(&json!({"id":"vehicle-demo","name":"Vehicle","product":"vehicle","definition":{"schema_version":1,"version":1,"category":"vehicle","title":"Vehicle","description":"A fictional vehicle search","price":{"currency":"GBP","period":"once"},"comparison_attributes":["model"],"fields":[{"id":"body_type","type":"single_choice","label":"Type","options":[{"value":"sedan","label":"Sedan"},{"value":"suv","label":"SUV"}]}]},"values":{"body_type":"sedan"}})).unwrap();
        let image = searches::bundled_cover_for(&saved).unwrap();
        saved["cover"] = json!({"media_id":image["media_id"],"kind":image["kind"],"alt":image["alt"],"source_name":image["source_name"],"prompt":image["prompt"]});
        ws.config["searches"] = json!([saved.clone()]);
        ws.save_config().unwrap();
        saved["values"]["body_type"] = json!("suv");
        let revision = ws.revisions().unwrap()["searches"]["vehicle-demo"].clone();
        command(
            &mut ws,
            "save_search",
            &json!({"search":saved,"expected_entity_revision":revision}),
        )
        .unwrap();
        assert!(ws.config["searches"][0].get("cover").is_none());
        assert_ne!(
            image["media_id"],
            searches::bundled_cover_for(&ws.config["searches"][0]).unwrap()["media_id"]
        );
    }
    #[test]
    fn structured_locations_validate_coordinate_and_display_semantics() {
        let mut location = json!({"source":"manual","latitude":null,"longitude":null,"accuracy_m":null,"area":"Example town","country":"GB","acquired_at":"2026-10-08T12:00:00.000Z","display":"town"});
        assert!(validate_location(&location).is_ok());
        location["latitude"] = json!(51.0);
        assert!(validate_location(&location).is_err());
        location["latitude"] = Value::Null;
        location["source"] = json!("device");
        assert!(validate_location(&location).is_err());
        location["source"] = json!("manual");
        location["display"] = json!("postal");
        assert!(validate_location(&location).is_err());
        location["postal_code"] = json!("EX1 1AA");
        assert!(validate_location(&location).is_ok());
    }
}
