import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { recordSchema } from "../connections/model.ts";
import type { ConnectionCheckStorage } from "../connections/repository.ts";
import type { WorkspaceMode } from "@goodfinds/contracts/state";

const decode = (row: { data: string } | null) =>
  row ? recordSchema.parse(JSON.parse(row.data) as unknown) : null;

export function connectionCheckStorage(workspaceDirectory: string): ConnectionCheckStorage {
  const folder = (mode: WorkspaceMode) =>
    resolve(workspaceDirectory, mode === "sample" ? "sample" : ".");
  const path = (mode: WorkspaceMode) => resolve(folder(mode), "connections.sqlite");
  return {
    exists: (mode) => existsSync(path(mode)),
    transaction: (mode, operation) => {
      mkdirSync(folder(mode), { recursive: true, mode: 0o700 });
      const db = new Database(path(mode), { create: true });
      try {
        db.run(`PRAGMA busy_timeout = 10000;
        CREATE TABLE IF NOT EXISTS connection_checks (
          id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
          context_id TEXT NOT NULL, target_scope_hash TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS connection_checks_active_by_scope
          ON connection_checks(context_id, target_scope_hash) WHERE status IN ('queued','running');`);
        return db
          .transaction(() =>
            operation({
              save: (run) => {
                db.query(`INSERT INTO connection_checks
      (id,request_id,context_id,target_scope_hash,status,created_at,document_json) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,document_json=excluded.document_json`).run(
                  run.id,
                  run.request_id,
                  run.context_id,
                  run.target_scope_hash,
                  run.status,
                  run.created_at,
                  JSON.stringify(recordSchema.parse(run)),
                );
              },
              active: () =>
                db
                  .query<{ data: string }, []>(
                    "SELECT document_json AS data FROM connection_checks WHERE status IN ('queued','running')",
                  )
                  .all()
                  .map((row) => recordSchema.parse(JSON.parse(row.data) as unknown)),
              find: (context, id) =>
                decode(
                  id
                    ? db
                        .query<{ data: string }, [string, string]>(
                          "SELECT document_json AS data FROM connection_checks WHERE id=? AND context_id=?",
                        )
                        .get(id, context)
                    : db
                        .query<{ data: string }, [string]>(
                          "SELECT document_json AS data FROM connection_checks WHERE context_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
                        )
                        .get(context),
                ),
              findRequest: (requestId) =>
                decode(
                  db
                    .query<{ data: string }, [string]>(
                      "SELECT document_json AS data FROM connection_checks WHERE request_id=?",
                    )
                    .get(requestId),
                ),
              findActive: (context, scope) =>
                decode(
                  db
                    .query<{ data: string }, [string, string]>(
                      "SELECT document_json AS data FROM connection_checks WHERE context_id=? AND target_scope_hash=? AND status IN ('queued','running') LIMIT 1",
                    )
                    .get(context, scope),
                ),
            }),
          )
          .immediate();
      } finally {
        db.close();
      }
    },
  };
}
