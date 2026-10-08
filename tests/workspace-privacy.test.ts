import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { backupWorkspace, restoreWorkspace } from "./reference-server/src/platform/backup.ts";
import { createGoodfindsServer } from "./reference-server/src/entrypoints/mcp.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import exampleConfig from "../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-privacy-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, store: new WorkspaceStore(folder) };
}

void test("a fresh live workspace remains empty across settings edits, restart and backup restore", (t) => {
  const { folder, store } = fixture(t);
  const initial = Effect.runSync(store.request("get_workspace")).state;
  assert.deepEqual(initial.searches, []);
  assert.deepEqual(initial.drafts, []);
  assert.deepEqual(initial.listings, []);
  assert.deepEqual(initial.monitoring, []);
  assert.equal(initial.config.origin_confirmed, false);
  const edited = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: initial.revisions.settings,
      settings: { origin: "Fictional test town" },
    }),
  ).state;
  const restarted = Effect.runSync(new WorkspaceStore(folder).request("get_workspace")).state;
  assert.equal(restarted.revision, edited.revision);
  assert.deepEqual(restarted.searches, []);
  const backup = resolve(folder, "backup");
  Effect.runSync(backupWorkspace(store.databasePath, backup));
  const restored = resolve(folder, "restored");
  Effect.runSync(restoreWorkspace(backup, restored));
  const restoredState = Effect.runSync(new WorkspaceStore(restored).request("get_workspace")).state;
  assert.deepEqual(restoredState.searches, []);
  assert.equal(restoredState.config.origin, "Fictional test town");
});

void test("the first search can be drafted, saved, removed and stay absent after restart", (t) => {
  const { folder, store } = fixture(t);
  const example = exampleConfig.searches[0];
  assert.ok(example);
  const initial = Effect.runSync(store.request("get_workspace")).state;
  const draft = {
    id: "draft-first",
    name: "Fictional first search",
    definition: example.definition,
    values: example.values,
  };
  const drafted = Effect.runSync(
    store.request("save_search_draft", {
      draft,
      expected_entity_revision: initial.revisions.absent,
    }),
  ).state;
  assert.equal(drafted.drafts.length, 1);
  assert.deepEqual(drafted.searches, []);
  const saved = Effect.runSync(
    store.request("save_search", {
      search: { ...example, id: "first-search", name: draft.name },
      draft_id: draft.id,
      expected_entity_revision: drafted.revisions.absent,
      expected_draft_revision: drafted.revisions.drafts[draft.id],
    }),
  ).state;
  assert.equal(saved.searches.length, 1);
  assert.deepEqual(saved.drafts, []);
  const removed = Effect.runSync(
    store.request("remove_search", {
      search_id: "first-search",
      expected_entity_revision: saved.revisions.searches["first-search"],
    }),
  ).state;
  assert.deepEqual(removed.searches, []);
  assert.deepEqual(
    Effect.runSync(new WorkspaceStore(folder).request("get_workspace")).state.searches,
    [],
  );
});

void test("new demo workspaces do not copy live searches, locations or drafts", (t) => {
  const { folder, store } = fixture(t);
  const initial = Effect.runSync(store.request("get_workspace")).state;
  const example = exampleConfig.searches[0];
  assert.ok(example);
  const changed = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: initial.revisions.settings,
      settings: { origin: "PRIVATE-FIXTURE-LOCATION" },
    }),
  ).state;
  const saved = Effect.runSync(
    store.request("save_search", {
      search: { ...example, id: "private-fixture-search", name: "PRIVATE-FIXTURE-SEARCH" },
      expected_entity_revision: changed.revisions.absent,
    }),
  ).state;
  const before = Effect.runSync(
    store.request("save_search_draft", {
      draft: {
        id: "draft-private-fixture",
        name: "PRIVATE-FIXTURE-DRAFT",
        definition: example.definition,
        values: example.values,
      },
      expected_entity_revision: saved.revisions.absent,
    }),
  ).state;
  const sample = Effect.runSync(
    new WorkspaceStore(folder, "sample").request("load_sample_workspace"),
  ).state;
  assert.doesNotMatch(JSON.stringify(sample), /PRIVATE-FIXTURE|private-fixture/);
  assert.equal(sample.config.origin, "Example origin");
  assert.equal(sample.searches.length, 2);
  assert.equal(sample.listings.length, 20);
  assert.deepEqual(sample.drafts, []);
  assert.equal(
    Effect.runSync(new WorkspaceStore(folder).request("get_workspace")).state.revision,
    before.revision,
  );
});

void test("demo initialization never opens an existing live database", (t) => {
  const { folder } = fixture(t);
  const live = resolve(folder, "workspace.sqlite");
  const bytes = "This live file is deliberately not a readable SQLite database.";
  writeFileSync(live, bytes);
  const sample = Effect.runSync(
    new WorkspaceStore(folder, "sample").request("get_workspace"),
  ).state;
  assert.equal(sample.searches.length, 2);
  assert.equal(readFileSync(live, "utf8"), bytes);
});

void test("the MCP panel response exposes an empty live workspace and a separate fictional demo", async (t) => {
  const { folder } = fixture(t);
  const { server, calls } = createGoodfindsServer(folder);
  t.after(() => server.close());
  const get = calls.get("get_goodfinds_workspace");
  assert.ok(get);
  assert.deepEqual(stateFromToolResult(await get({})).searches, []);
  assert.equal(stateFromToolResult(await get({ mode: "sample" })).searches.length, 2);
  assert.deepEqual(stateFromToolResult(await get({})).searches, []);
});
