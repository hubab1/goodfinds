import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Exit } from "effect";
import { receiptSchema } from "@goodfinds/contracts/operations";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { withReceipt } from "./reference-server/src/platform/receipts.ts";
import { execute, transaction } from "./reference-server/src/platform/sqlite.ts";

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-receipts-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const request = (operation: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(store.request(operation, args));
  const state = () => request("get_workspace").state;
  function snapshot() {
    const current = state();
    const db = new Database(store.databasePath);
    try {
      return {
        revision: current.revisions.settings,
        config: current.config,
        receipts: db
          .query<{ request_id: string; result_json: string }, []>(
            "SELECT request_id,result_json FROM operation_receipts ORDER BY rowid",
          )
          .all(),
      };
    } finally {
      db.close();
    }
  }
  return { request, state, snapshot };
}

void test("receipt retries return the original result and preserve later settings edits", (t) => {
  const f = fixture(t);
  const first = {
    request_id: randomUUID(),
    expected_entity_revision: f.state().revisions.settings,
    settings: { browser_preference: "external" },
  };
  const committed = f.request("save_settings", first);
  assert.equal(receiptSchema.parse(committed["receipt"]).replayed, false);
  assert.equal(committed.state.config.browser_preference, "external");
  assert.equal(f.snapshot().receipts.length, 1);
  const immediateRetry = f.request("save_settings", first);
  assert.equal(receiptSchema.parse(immediateRetry["receipt"]).replayed, true);
  assert.deepEqual(immediateRetry["operation_result"], committed["operation_result"]);
  assert.equal(f.snapshot().receipts.length, 1);

  const beforeRejected = f.snapshot();
  assert.throws(
    () => f.request("save_settings", { ...first, request_id: randomUUID() }),
    /changed elsewhere/u,
  );
  assert.throws(
    () => f.request("save_settings", { ...first, settings: { browser_preference: "in_app" } }),
    /already used/u,
  );
  assert.deepEqual(f.snapshot(), beforeRejected);

  const edited = f.request("save_settings", {
    request_id: randomUUID(),
    expected_entity_revision: f.state().revisions.settings,
    settings: { browser_preference: "in_app" },
  });
  const beforeRetry = f.snapshot();
  const retried = f.request("save_settings", first);
  assert.equal(receiptSchema.parse(retried["receipt"]).replayed, true);
  assert.deepEqual(retried["operation_result"], committed["operation_result"]);
  assert.equal(retried.state.config.browser_preference, "in_app");
  assert.equal(retried.state.revisions.settings, edited.state.revisions.settings);
  assert.deepEqual(f.snapshot(), beforeRetry);
  assert.equal(beforeRetry.receipts.length, 2);
});

void test("failed receipt-backed work rolls back the mutation and receipt together", (t) => {
  const f = fixture(t),
    db = new Database(":memory:");
  t.after(() => db.close());
  db.run(
    "CREATE TABLE operation_receipts (request_id TEXT PRIMARY KEY, operation TEXT, input_hash TEXT, result_json TEXT, created_at TEXT)",
  );
  db.run("CREATE TABLE probe (value TEXT)");
  const args = {
    request_id: randomUUID(),
    expected_entity_revision: f.state().revisions.settings,
  };
  const failing = Effect.gen(function* () {
    yield* execute(db, "INSERT INTO probe VALUES ('partial mutation')");
    return yield* Effect.fail(new Error("Injected failure after mutation"));
  });
  const outcome = Effect.runSyncExit(
    transaction(
      db,
      withReceipt(db, "save_settings", args, failing, () => Effect.succeed(f.state())),
    ),
  );
  assert.equal(Exit.isFailure(outcome), true);
  assert.equal(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM probe").get()?.count,
    0,
  );
  assert.equal(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM operation_receipts").get()
      ?.count,
    0,
  );
});
