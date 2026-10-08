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
        let evaluate = !fulfilled.contains(text(search, "id"))
            && (bool_(search, "enabled")
                || runs.iter().any(|r| {
                    r["search_id"] == search["id"]
                        && text(r, "search_revision") == hash(search)
                        && r["phase"] != "cancelled"
                }));
        let pool = if evaluate {
            listings::comparison_pool(&current, search, config, ws.now, ws.mode == "sample")
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
    let mut state = json!({"device_browser":device_browser(),"monitoring":schedules["monitoring"],"dispatchers":schedules["dispatchers"],"search_runs":runs,"seller_workflow":null,"seller_conversations":conversations,"seller_conversation":null,"api_connections":{"ebay_credentials_configured":crate::ebay::configured()},"access_context":ws.access_context,"revision":ws.revision(),"revisions":ws.revisions()?,"mode":ws.mode,"config":config,"searches":enriched,"drafts":config["drafts"],"counts":{"listings":rows.len(),"deals":deals.len(),"active_searches":array(config,"searches").iter().filter(|s|bool_(s,"enabled")&&!fulfilled.contains(text(s,"id"))).count(),"pending_alerts":pending},"monitor":{"collector_available":false,"scheduler_available":!active.is_empty(),"notification_delivery_available":false,"next_run_at":next,"last_run_at":activity[0]["evaluated_at"],"message":if active.is_empty(){"Searches are saved. Recurring monitoring needs a verified host schedule.".to_owned()}else{format!("{} saved searches have verified host schedules. The device must be awake with the host app running.",active.len())}},"generated_at":iso(ws.now),"deals":deals,"decisions":decisions,"listings":rows,"activity":activity});
    state.as_object_mut().unwrap().extend(
        searches::workflow_views(config, &runs, &fulfilled, ws.now)
            .as_object()
            .unwrap()
            .clone(),
    );
    state["next_steps"] = sellers::next_steps(&state);
    contracts::parse("stateSchema", &state)
}
