//! Resume from saved coverage. These read projections grant no execution permit.
use crate::{
    error::{Error, Result},
    searches, sellers,
    storage::Workspace,
    util::*,
};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn read(ws: &Workspace, args: &Value) -> Result<Value> {
    if (integer(args, "query_offset").unwrap_or(0) > 0
        || integer(args, "listing_offset").unwrap_or(0) > 0
        || integer(args, "feedback_offset").unwrap_or(0) > 0)
        && (args.get("expected_version").is_none()
            || args.get("expected_context_revision").is_none())
    {
        return Err(Error::validation(
            "Pass expected_version and expected_context_revision from the first recovery page",
        ));
    }
    let run = searches::find_run(ws, text(args, "run_id"))?
        .ok_or_else(|| Error::validation("Choose an existing search run"))?;
    let run = searches::expired_run(&run, ws.now);
    if args
        .get("expected_version")
        .is_some_and(|v| *v != run["version"])
    {
        return Err(Error::new(
            "revision_conflict",
            "Search recovery changed. Read the first page again before continuing.",
        ));
    }
    let context_revision = ws.revision();
    if args
        .get("expected_context_revision")
        .is_some_and(|v| v != &context_revision)
    {
        return Err(Error::new(
            "revision_conflict",
            "Recovery context changed. Read the first page again.",
        ));
    }
    let brief = array(&ws.config, "searches")
        .iter()
        .find(|s| s["id"] == run["search_id"]);
    let current = brief.is_some_and(|s| hash(s) == text(&run, "search_revision"));
    let fulfilled = sellers::fulfilled_searches(&sellers::summaries(ws)?);
    let workflow = searches::workflow_views(
        &ws.config,
        std::slice::from_ref(&run),
        &fulfilled,
        ws.now,
    )["search_run_workflows"][text(&run, "id")]
    .clone();
    let queries = array(&run, "queries");
    let unfinished: Vec<Value> = queries
        .iter()
        .filter(|q| !["completed", "skipped"].contains(&text(q, "status")))
        .cloned()
        .collect();
    let verified: HashSet<&str> = array(&run, "verified_keys")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let pending: Vec<Value> = array(&run, "listing_keys")
        .iter()
        .filter(|v| !verified.contains(v.as_str().unwrap_or("")))
        .cloned()
        .collect();
    let limit = integer(args, "limit").unwrap_or(20) as usize;
    let qo = integer(args, "query_offset").unwrap_or(0) as usize;
    let lo = integer(args, "listing_offset").unwrap_or(0) as usize;
    let page = |rows: &[Value], offset: usize| {
        json!(rows.iter().skip(offset).take(limit).collect::<Vec<_>>())
    };
    let next = |rows: &[Value], offset: usize| {
        if offset.saturating_add(limit) < rows.len() {
            json!(offset + limit)
        } else {
            Value::Null
        }
    };
    let fo = integer(args, "feedback_offset").unwrap_or(0) as usize;
    let feedback: Vec<Value> = array(&ws.config, "feedback")
        .iter()
        .filter(|e| brief.is_some_and(|b| searches::applies_to_search(e, b)))
        .cloned()
        .collect();
    let include = args["include_brief"] != false;
    let settings = if include {
        crate::queries::query(ws, "get_settings", &json!({}), &json!({}))?["settings"].clone()
    } else {
        Value::Null
    };
    let mut summary = run.clone();
    for key in ["queries", "listing_keys", "verified_keys"] {
        summary.as_object_mut().unwrap().remove(key);
    }
    Ok(
        json!({"run":summary,"brief":if include{brief.cloned().unwrap_or(Value::Null)}else{Value::Null},"brief_included":include&&brief.is_some(),"brief_revision":brief.map(hash).unwrap_or_default(),"search_current":current,
        "context_revision":context_revision,"settings":settings,"feedback":page(&feedback,fo),"next_feedback_offset":next(&feedback,fo),
        "workflow":workflow,"runtime":crate::runtime::context(ws),"unfinished_queries":page(&unfinished,qo),"pending_verification":page(&pending,lo),
        "coverage":{"queries":queries.len(),"completed":queries.iter().filter(|q|q["status"]=="completed").count(),"skipped":queries.iter().filter(|q|q["status"]=="skipped").count(),"unfinished":unfinished.len(),"discovered":array(&run,"listing_keys").len(),"verified":verified.len(),"pending_verification":pending.len()},
        "next_query_offset":next(&unfinished,qo),"next_listing_offset":next(&pending,lo),
        "references":["references/background-work.md","references/search-workflow.md","references/observations.md"]}),
    )
}
