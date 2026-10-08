import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { runCli } from "../apps/server/src/entrypoints/cli.ts";
import { workspaceConfigurationSchema, hash } from "../apps/server/src/workspace/model.ts";

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-config-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, store: new WorkspaceStore(seedWorkspace(folder)) };
}

function database<A>(store: WorkspaceStore, operation: (db: Database) => A): A {
  const db = new Database(store.databasePath);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

void test("configured workspaces persist in SQLite without creating a JSON configuration", (t) => {
  const { store, folder } = fixture(t);
  const settings = Effect.runSync(store.query("get_settings", {}));
  assert.ok("revision" in settings);
  assert.equal(existsSync(resolve(folder, "unused-configuration.json")), false);
  const restarted = Effect.runSync(
    new WorkspaceStore(seedWorkspace(folder)).request("get_workspace"),
  ).state;
  assert.equal(restarted.revision, settings.revision);
  assert.equal(existsSync(resolve(folder, "unused-configuration.json")), false);
});

void test("search edits and alert withdrawal roll back together after a database failure", (t) => {
  const { folder } = fixture(t);
  const store = new WorkspaceStore(folder, "sample");
  const before = Effect.runSync(store.request("load_sample_workspace")).state;
  const alerts = database(store, (db) =>
    db
      .query<{ id: string; search_id: string }, []>(
        "SELECT id,search_id FROM deal_alerts WHERE status='pending'",
      )
      .all(),
  );
  const target = alerts[0];
  assert.ok(target);
  database(store, (db) =>
    db.run(
      "CREATE TRIGGER fail_alert_withdraw BEFORE UPDATE ON deal_alerts BEGIN SELECT RAISE(ABORT, 'injected alert write failure'); END;",
    ),
  );
  assert.throws(
    () =>
      Effect.runSync(
        store.request("set_search_enabled", {
          expected_entity_revision: revisionFor(before, "set_search_enabled", {
            search_id: target.search_id,
          }),
          search_id: target.search_id,
          enabled: false,
        }),
      ),
    /injected alert write failure/u,
  );
  const after = Effect.runSync(new WorkspaceStore(folder, "sample").request("get_workspace")).state;
  assert.equal(after.revision, before.revision);
  assert.equal(after.searches.find((search) => search.id === target.search_id)?.enabled, true);
  assert.deepEqual(
    database(store, (db) =>
      db
        .query<{ id: string; search_id: string }, []>(
          "SELECT id,search_id FROM deal_alerts WHERE status='pending'",
        )
        .all(),
    ),
    alerts,
  );

  database(store, (db) => db.run("DROP TRIGGER fail_alert_withdraw"));
  const paused = Effect.runSync(
    store.request("set_search_enabled", {
      expected_entity_revision: revisionFor(before, "set_search_enabled", {
        search_id: target.search_id,
      }),
      search_id: target.search_id,
      enabled: false,
    }),
  ).state;
  assert.equal(paused.searches.find((search) => search.id === target.search_id)?.enabled, false);
  assert.equal(
    database(store, (db) =>
      db
        .query<{ status: string }, [string]>("SELECT status FROM deal_alerts WHERE id=?")
        .get(target.id),
    )?.status,
    "withdrawn",
  );
});

void test("failed configuration writes preserve both the saved revision and alert state", (t) => {
  const { store } = fixture(t);
  const before = Effect.runSync(store.request("get_workspace")).state;
  database(store, (db) =>
    db.run(
      "CREATE TRIGGER fail_config_write BEFORE UPDATE ON workspace_settings BEGIN SELECT RAISE(ABORT, 'injected configuration_json write failure'); END;",
    ),
  );
  assert.throws(
    () =>
      Effect.runSync(
        store.request("save_settings", {
          expected_entity_revision: revisionFor(before, "save_settings"),
          settings: { origin: "Uncommitted town" },
        }),
      ),
    /injected configuration_json write failure/u,
  );
  const after = Effect.runSync(store.request("get_workspace")).state;
  assert.equal(after.revision, before.revision);
  assert.equal(after.config.origin, before.config.origin);
});

void test("sample setup uses fictional defaults and stays independent of live edits", (t) => {
  const { store, folder } = fixture(t);
  const before = Effect.runSync(store.request("get_workspace")).state;
  const changed = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(before, "save_settings"),
      settings: { origin: "Current live town" },
    }),
  ).state;
  const savedSearch = changed.searches[0];
  assert.ok(savedSearch);
  Effect.runSync(
    store.request("set_monitoring", {
      expected_entity_revision: revisionFor(changed, "set_monitoring", {
        monitoring: { search_id: savedSearch.id },
      }),
      monitoring: { search_id: savedSearch.id, preference: "once" },
    }),
  );
  const sample = new WorkspaceStore(folder, "sample");
  const copied = Effect.runSync(sample.request("get_workspace")).state;
  assert.equal(copied.config.origin, "Example origin");
  assert.notEqual(copied.config.origin, changed.config.origin);
  assert.deepEqual(copied.config.monitoring, []);
  Effect.runSync(
    sample.request("save_settings", {
      expected_entity_revision: revisionFor(copied, "save_settings"),
      settings: { origin: "Sample town" },
    }),
  );
  assert.equal(Effect.runSync(store.config()).origin, "Current live town");
  assert.equal(existsSync(resolve(folder, "unused-configuration.json")), false);
});

void test("CLI exports current database configuration as reusable JSON", (t) => {
  const { store, folder } = fixture(t);
  const before = Effect.runSync(store.request("get_workspace")).state;
  const current = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(before, "save_settings"),
      settings: { origin: "Exported town" },
    }),
  ).state;
  const output = resolve(folder, "exported.json");
  Effect.runSync(runCli(["export", "--db", store.databasePath, "--output", output]));
  const exported = workspaceConfigurationSchema.parse(
    JSON.parse(readFileSync(output, "utf8")) as unknown,
  );
  assert.equal(hash(exported), current.revision);
  assert.deepEqual(exported, current.config);
  assert.throws(
    () =>
      Effect.runSync(
        runCli(["export", "--db", store.databasePath, "--output", store.databasePath]),
      ),
    /separate JSON file/u,
  );
  assert.equal(Effect.runSync(store.config()).origin, "Exported town");
});
