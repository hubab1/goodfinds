//! Durable notification intent. Reading never acknowledges presentation.
use crate::{error::Result, listings, storage::Workspace, util::*};
use rusqlite::params;
use serde_json::{Value, json};

pub fn pending(ws: &Workspace, args: &Value) -> Result<Value> {
    let limit = integer(args, "limit").unwrap_or(20);
    let mut statement = ws.db.prepare(
        "SELECT a.id,a.created_at,a.alert_json FROM deal_alerts a
         JOIN saved_searches s ON s.id=a.search_id AND s.is_deleted=0 AND s.enabled=1
         JOIN listings l ON l.listing_key=a.listing_key
         WHERE a.status='pending' AND l.last_observed_at>=? AND l.last_observed_at<=?
         AND (? IS NULL OR a.search_id=?)
         AND (? IS NULL OR (a.created_at,a.id)>(?,?))
         AND NOT EXISTS (SELECT 1 FROM seller_conversations c,json_each(c.document_json,'$.search_ids') g
             WHERE json_extract(c.document_json,'$.outcome')='bought' AND g.value=a.search_id)
         ORDER BY a.created_at,a.id LIMIT ?",
    )?;
    let after_time = args["after"]["created_at"].as_str();
    let search = args["search_id"].as_str();
    let rows = statement.query_map(
        params![
            iso(ws.now - integer(&ws.config, "baseline_days").unwrap_or(30) * DAY),
            iso(ws.now),
            search,
            search,
            after_time,
            after_time,
            args["after"]["id"].as_str(),
            limit + 1
        ],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )?;
    let mut alerts = vec![];
    for row in rows {
        let (id, created_at, raw) = row?;
        let mut alert: Value = serde_json::from_str(&raw)?;
        alert["id"] = json!(id);
        alert["created_at"] = json!(created_at);
        alert["status"] = json!("pending");
        alert["mode"] = json!(ws.mode);
        alerts.push(alert);
    }
    let more = alerts.len() > limit as usize;
    alerts.truncate(limit as usize);
    let cursor = if more {
        alerts
            .last()
            .map(|a| json!({"created_at":a["created_at"],"id":a["id"]}))
    } else {
        None
    };
    // Alert eligibility changes with time even without a write (stale facts,
    // expiring travel evidence, disappearing peers). Recheck the full current
    // peer population, never the alert page, before offering presentation.
    if !alerts.is_empty() {
        let products: Vec<Value> = array(&ws.config, "searches")
            .iter()
            .filter(|search| alerts.iter().any(|a| a["search_id"] == search["id"]))
            .map(|search| search["product"].clone())
            .collect();
        let cutoff = ws.now - integer(&ws.config, "baseline_days").unwrap_or(30) * DAY;
        let current: Vec<Value> = listings::load_current(ws, Some(&products))?
            .into_iter()
            .filter(|r| time(text(r, "last_observed_at")).is_ok_and(|t| t >= cutoff && t <= ws.now))
            .collect();
        let mut eligible = vec![];
        for mut alert in alerts {
            let Some(search) = array(&ws.config, "searches")
                .iter()
                .find(|s| s["id"] == alert["search_id"])
            else {
                continue;
            };
            let Some(row) = current.iter().find(|r| r["key"] == alert["listing"]["key"]) else {
                continue;
            };
            let pool = listings::comparison_pool(
                &current,
                search,
                &ws.config,
                ws.now,
                ws.mode == "sample",
            );
            let decision = listings::evaluate_listing(
                row,
                &pool,
                search,
                &ws.config,
                ws.now,
                ws.mode == "sample",
            );
            if decision["status"] != "qualifies"
                || row["price_minor"] != alert["listing"]["price_minor"]
            {
                continue;
            }
            alert
                .as_object_mut()
                .unwrap()
                .extend(decision.as_object().unwrap().clone());
            alert["status"] = json!("pending");
            eligible.push(alert);
        }
        alerts = eligible;
    }
    Ok(json!({"alerts":alerts,"next_cursor":cursor}))
}

pub fn acknowledge(ws: &mut Workspace, args: &Value) -> Result<Value> {
    let ids: Vec<String> = array(args, "alert_ids")
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    listings::acknowledge(ws, &ids)?;
    Ok(json!({"alert_ids":ids,"status":"delivered"}))
}
