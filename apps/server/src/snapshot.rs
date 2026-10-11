use crate::{
    contracts,
    error::Result,
    listings, searches, sellers,
    storage::{Workspace, device_browser},
    util::*,
};
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn snapshot(ws: &Workspace) -> Result<Value> {
    let _measurement = crate::diagnostics::stage("snapshot");
    crate::diagnostics::count("snapshots", 1);
    let config = &ws.config;
    let mut rows = listings::load(ws)?;
    rows.sort_by(|a, b| {
        text(b, "last_observed_at")
            .cmp(text(a, "last_observed_at"))
            .then_with(|| text(b, "key").cmp(text(a, "key")))
    });
    let discovery = listings::discovery_summary(ws)?;
    let current: Vec<_> = rows
        .iter()
        .filter(|r| {
            time(text(r, "last_observed_at")).is_ok_and(|t| {
                t >= ws.now - integer(config, "baseline_days").unwrap_or(30) * DAY && t <= ws.now
            })
        })
        .cloned()
        .collect();
    let runs = searches::runs(ws, None)?;
    let conversations = sellers::summaries(ws)?;
    let fulfilled = sellers::fulfilled_searches(&conversations);
    let mut decisions = vec![];
    let mut enriched = vec![];
    for search in array(config, "searches") {
        let (pool, matched) = assess(ws, &current, search, &runs, &fulfilled);
        let mut value = search.clone();
        let read = listings::reading_summary(
            &rows,
            search,
            config,
            discovery["last_searched"][text(search, "id")].as_str(),
        );
        value
            .as_object_mut()
            .unwrap()
            .extend(read.as_object().unwrap().clone());
        value["qualified_count"] = json!(
            matched
                .iter()
                .filter(|d| d["status"] == "qualifies")
                .count()
        );
        value["tracked_count"] = json!(
            rows.iter()
                .filter(|r| r["product"] == search["product"])
                .count()
        );
        value["found_count"] = discovery["counts"][text(search, "id")].clone();
        value["market_history"] = listings::insights(ws, &rows, search, &pool)?;
        enriched.push(value);
        decisions.extend(matched);
    }
    for row in &mut rows {
        row["quality"] = listings::quality(row, config, ws.now, &[]);
    }
    let mut activity = listings::evaluations(ws)?;
    for entry in activity.as_array_mut().unwrap() {
        let observations = array(entry, "observations");
        let coverage = array(entry, "search_coverage");
        let failed = (!coverage.is_empty() && coverage.iter().all(|c| c["status"] == "failed"))
            || (!observations.is_empty()
                && observations
                    .iter()
                    .all(|r| r.get("check_outcome").is_some_and(|x| x != "success")));
        let partial = coverage
            .iter()
            .any(|c| c["status"] != "success" || !bool_(c, "pagination_complete"))
            || observations
                .iter()
                .any(|r| r.get("check_outcome").is_some_and(|x| x != "success"));
        let method = if !observations.is_empty()
            && observations
                .iter()
                .all(|r| r["collection_method"] == "user_requested_browser")
        {
            "user_requested_browser"
        } else {
            "supplied"
        };
        entry["collection_method"] = json!(method);
        entry["status"] = json!(if failed {
            "failed"
        } else if partial {
            "partial"
        } else {
            "recorded"
        });
        entry.as_object_mut().unwrap().remove("observations");
    }
    let qualifying: HashSet<_> = decisions
        .iter()
        .filter(|d| {
            d["status"] == "qualifies"
                && array(config, "searches")
                    .iter()
                    .any(|s| s["id"] == d["search_id"] && bool_(s, "enabled"))
        })
        .map(|d| {
            format!(
                "{}:{}:{}",
                text(d, "search_id"),
                text(&d["listing"], "key"),
                d["listing"]["price_minor"]
            )
        })
        .collect();
    let pending = listings::pending_alerts(ws)?
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| {
            qualifying.contains(&format!(
                "{}:{}:{}",
                text(a, "search_id"),
                text(a, "listing_key"),
                a["price_minor"]
            ))
        })
        .count();
    let schedules = searches::monitoring_snapshot(ws, &enriched, &fulfilled)?;
    let active: Vec<_> = array(&schedules, "monitoring")
        .iter()
        .filter(|s| {
            if !s["host_schedule"].is_null() {
                s["host_schedule"]["status"] == "active"
            } else {
                ["active", "quiet", "stop_needed"].contains(&text(s, "status"))
            }
        })
        .collect();
    let next = active
        .iter()
        .filter_map(|s| s["schedule"]["next_run_at"].as_str())
        .min();
    let mut deals: Vec<_> = decisions
        .iter()
        .filter(|d| d["status"] == "qualifies")
        .cloned()
        .collect();
    deals.sort_by(|a, b| {
        num(b, "preference_score")
            .unwrap_or(0.)
            .total_cmp(&num(a, "preference_score").unwrap_or(0.))
            .then_with(|| {
                num(b, "percent_below_average")
                    .unwrap_or(0.)
                    .total_cmp(&num(a, "percent_below_average").unwrap_or(0.))
            })
    });
    let mut state = json!({"device_browser":device_browser(),"monitoring":schedules["monitoring"],"dispatchers":schedules["dispatchers"],"search_runs":runs,"seller_workflow":null,"seller_conversations":conversations,"seller_conversation":null,"access_context":ws.access_context,"revision":ws.revision(),"revisions":ws.revisions()?,"mode":ws.mode,"config":config,"searches":enriched,"drafts":config["drafts"],"counts":{"listings":rows.len(),"deals":deals.len(),"active_searches":array(config,"searches").iter().filter(|s|bool_(s,"enabled")&&!fulfilled.contains(text(s,"id"))).count(),"pending_alerts":pending},"monitor":{"collector_available":false,"scheduler_available":!active.is_empty(),"notification_delivery_available":false,"next_run_at":next,"last_run_at":activity[0]["evaluated_at"],"message":if active.is_empty(){"Searches are saved. Recurring monitoring needs a verified host schedule.".to_owned()}else{format!("{} saved searches have verified host schedules. The device must be awake with the host app running.",active.len())}},"generated_at":iso(ws.now),"deals":deals,"decisions":decisions,"listings":rows,"activity":activity});
    state.as_object_mut().unwrap().extend(
        searches::workflow_views(config, &runs, &fulfilled, ws.now)
            .as_object()
            .unwrap()
            .clone(),
    );
    state["search_run_refresh_keys"] = json!(
        runs.iter()
            .map(|r| (text(r, "id").to_owned(), searches::refresh_key(r)))
            .collect::<serde_json::Map<String, Value>>()
    );
    state["workspace_id"] = json!(hash(&json!(ws.folder().canonicalize()?.to_string_lossy())));
    state["next_steps"] = sellers::next_steps(&state);
    contracts::parse("stateSchema", &state)
}

// No activity, market history or panel projection for scoped operational reads.
pub fn listing_context(ws: &Workspace, action: &str, args: &Value) -> Result<Value> {
    let selected = if let Some(id) = args["search_id"].as_str() {
        Some(
            array(&ws.config, "searches")
                .iter()
                .find(|s| text(s, "id") == id)
                .ok_or_else(|| crate::error::Error::validation("Choose a saved search"))?,
        )
    } else {
        None
    };
    let detail = if action == "get_listing" {
        Some(
            listings::find(ws, text(args, "listing_key"))?
                .ok_or_else(|| crate::error::Error::validation("Choose a saved listing"))?,
        )
    } else {
        None
    };
    // The detail workflow includes the globally ranked top-three next actions.
    // Retain all current peers for that ranking, but hydrate only this history.
    let products = if detail.is_some() {
        None
    } else {
        selected.map(|s| vec![s["product"].clone()])
    };
    let mut rows = listings::load_current(ws, products.as_deref())?;
    if let Some(detail) = detail
        && let Some(row) = rows.iter_mut().find(|r| r["key"] == detail["key"])
    {
        *row = detail;
    }
    rows.sort_by(|a, b| {
        text(b, "last_observed_at")
            .cmp(text(a, "last_observed_at"))
            .then_with(|| text(b, "key").cmp(text(a, "key")))
    });
    if ["list_media_repairs", "list_journey_checks"].contains(&action) {
        return Ok(json!({"listings":rows}));
    }
    let current: Vec<Value> = rows
        .iter()
        .filter(|r| {
            time(text(r, "last_observed_at")).is_ok_and(|t| {
                t >= ws.now - integer(&ws.config, "baseline_days").unwrap_or(30) * DAY
                    && t <= ws.now
            })
        })
        .cloned()
        .collect();
    let runs = searches::runs(ws, None)?;
    let conversations = sellers::summaries(ws)?;
    let fulfilled = sellers::fulfilled_searches(&conversations);
    let mut decisions = vec![];
    for search in array(&ws.config, "searches") {
        if products
            .as_ref()
            .is_none_or(|p| p.contains(&search["product"]))
        {
            decisions.extend(assess(ws, &current, search, &runs, &fulfilled).1);
        }
    }
    for row in &mut rows {
        row["quality"] = listings::quality(row, &ws.config, ws.now, &[]);
    }
    let mut state = json!({"config":ws.config,"listings":rows,"decisions":decisions,"seller_conversations":conversations});
    if action == "get_listing" {
        state["next_steps"] = sellers::next_steps(&state);
    }
    Ok(state)
}
fn assess(
    ws: &Workspace,
    current: &[Value],
    search: &Value,
    runs: &[Value],
    fulfilled: &HashSet<String>,
) -> (Vec<Value>, Vec<Value>) {
    let config = &ws.config;
    let evaluate = !fulfilled.contains(text(search, "id"))
        && (bool_(search, "enabled")
            || runs.iter().any(|r| {
                r["search_id"] == search["id"]
                    && text(r, "search_revision") == hash(search)
                    && r["phase"] != "cancelled"
            }));
    let pool = if evaluate {
        listings::comparison_pool(current, search, config, ws.now, ws.mode == "sample")
    } else {
        vec![]
    };
    let matched: Vec<_> = if evaluate {
        current
            .iter()
            .filter(|r| r["product"] == search["product"])
            .map(|r| {
                let mut d = listings::evaluate_listing(
                    r,
                    &pool,
                    search,
                    config,
                    ws.now,
                    ws.mode == "sample",
                );
                d["search_id"] = search["id"].clone();
                d["search_name"] = search["name"].clone();
                d
            })
            .collect()
    } else {
        vec![]
    };
    (pool, matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_reads_preserve_full_snapshot_ranking_cohorts_and_detail() {
        let dir = tempfile::tempdir().unwrap();
        crate::workspace::execute(
            dir.path(),
            "scoped-read",
            "load_sample_workspace",
            &json!({"mode":"sample"}),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
        let ws = Workspace::open(dir.path(), "sample", "scoped-read").unwrap();
        let full = snapshot(&ws).unwrap();
        for search in array(&ws.config, "searches") {
            let scoped =
                listing_context(&ws, "list_listings", &json!({"search_id":search["id"]})).unwrap();
            for sort in [
                "recommended",
                "price_low",
                "price_high",
                "found_oldest",
                "found_newest",
            ] {
                for result_type in ["all", "good_deals", "promising"] {
                    let args = json!({"search_id":search["id"],"sort":sort,"result_type":result_type,"limit":1,"offset":1});
                    assert_eq!(
                        listings::query(&ws, "list_listings", &args, &scoped).unwrap(),
                        listings::query(&ws, "list_listings", &args, &full).unwrap(),
                        "{args}"
                    );
                    assert!(
                        array(&scoped, "listings")
                            .iter()
                            .all(|r| r.get("price_history").is_none())
                    );
                }
            }
        }
        for action in ["list_media_repairs", "list_journey_checks"] {
            let args = json!({"limit":1});
            let scoped = listing_context(&ws, action, &args).unwrap();
            assert_eq!(
                listings::query(&ws, action, &args, &scoped).unwrap(),
                listings::query(&ws, action, &args, &full).unwrap()
            );
        }
        let args = json!({"listing_key":full["listings"][0]["key"]});
        let scoped = listing_context(&ws, "get_listing", &args).unwrap();
        let actual = contracts::parse(
            "operations.get_listing.output",
            &listings::query(&ws, "get_listing", &args, &scoped).unwrap(),
        )
        .unwrap();
        let expected = contracts::parse(
            "operations.get_listing.output",
            &listings::query(&ws, "get_listing", &args, &full).unwrap(),
        )
        .unwrap();
        assert_eq!(actual, expected);
    }
}
