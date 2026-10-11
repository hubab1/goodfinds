//! Durable wakeup hints. Consumers reread resources before acting and checkpoint
//! only after processing. This stream never authorizes an external side effect.
use crate::{
    error::{Error, Result},
    storage::Workspace,
    util::*,
};
use rusqlite::params;
use serde_json::{Value, json};
pub fn read(ws: &Workspace, args: &Value) -> Result<Value> {
    let stream: String = ws.db.query_row(
        "SELECT stream_id FROM coordination_stream WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let (first, last): (i64, i64) = ws.db.query_row(
        "SELECT COALESCE((SELECT sequence FROM coordination_events ORDER BY sequence LIMIT 1),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='coordination_events'),0)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let after = integer(&args["after"], "sequence").unwrap_or(0);
    if !args["after"].is_null()
        && (args["after"]["stream_id"] != stream
            || after > last
            || (first > 0 && after < first - 1)
            || (first == 0 && after < last))
    {
        return Err(Error::new(
            "cursor_gap",
            "Completion cursor is outside this workspace's retained stream; resynchronize current runs and pending alerts.",
        ));
    }
    let limit = integer(args, "limit").unwrap_or(20);
    let mut stmt=ws.db.prepare("SELECT sequence,kind,created_at,resource_json FROM coordination_events WHERE sequence>? ORDER BY sequence LIMIT ?")?;
    let mut rows = stmt.query(params![after, limit + 1])?;
    let mut events = vec![];
    while let Some(row) = rows.next()? {
        let raw: String = row.get(3)?;
        let resource: Value = serde_json::from_str(&raw)?;
        events.push(json!({"sequence":row.get::<_,i64>(0)?,"kind":row.get::<_,String>(1)?,"created_at":row.get::<_,String>(2)?,"resource":resource}));
    }
    crate::diagnostics::count("events_loaded", events.len());
    let more = events.len() > limit as usize;
    events.truncate(limit as usize);
    let sequence = events
        .last()
        .and_then(|e| integer(e, "sequence"))
        .unwrap_or(last);
    Ok(json!({"events":events,"cursor":{"stream_id":stream,"sequence":sequence},"has_more":more}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage;
    #[test]
    fn fresh_schema_events_commit_with_resources_and_survive_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(dir.path().join("workspace.sqlite")).unwrap();
        storage::initialize(&db).unwrap();
        let run = json!({"id":id(),"search_id":"search","version":3,"phase":"completed"});
        db.execute(
            "INSERT INTO search_runs VALUES(?,?,?,?)",
            params![
                run["id"].as_str(),
                "search",
                run.to_string(),
                "2026-10-11T12:00:00.000Z"
            ],
        )
        .unwrap();
        storage::initialize(&db).unwrap();
        storage::initialize(&db).unwrap();
        let count = || {
            db.query_row("SELECT COUNT(*) FROM coordination_events", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        assert_eq!(count(), 1);
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        db.execute("UPDATE search_runs SET document_json=json_set(document_json,'$.phase','blocked','$.version',4)",[]).unwrap();
        assert_eq!(count(), 2);
        db.execute_batch("ROLLBACK").unwrap();
        assert_eq!(count(), 1);
        drop(db);
        let ws = Workspace::open(dir.path(), "live", "events").unwrap();
        let first = read(&ws, &json!({"limit":1})).unwrap();
        assert_eq!(first["events"][0]["kind"], "search_run.completed");
        assert_eq!(
            read(&ws, &json!({"after":first["cursor"]})).unwrap()["events"],
            json!([])
        );
        assert_eq!(
            read(&ws, &json!({"after":{"stream_id":id(),"sequence":1}}))
                .unwrap_err()
                .code,
            "cursor_gap"
        );
        ws.db.execute("UPDATE search_runs SET document_json=json_set(document_json,'$.phase','blocked','$.version',4)",[]).unwrap();
        assert_eq!(
            read(&ws, &json!({"after":first["cursor"]})).unwrap()["events"][0]["kind"],
            "search_run.interrupted"
        );
        ws.db
            .execute(
                "UPDATE search_runs SET document_json=json_set(document_json,'$.version',5)",
                [],
            )
            .unwrap();
        assert_eq!(
            read(&ws, &json!({"after":first["cursor"]})).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "no repeat for same terminal phase"
        );
        ws.db
            .execute("DELETE FROM coordination_events WHERE sequence=1", [])
            .unwrap();
        assert_eq!(
            read(
                &ws,
                &json!({"after":{"stream_id":first["cursor"]["stream_id"],"sequence":0}})
            )
            .unwrap_err()
            .code,
            "cursor_gap"
        );
    }
}
