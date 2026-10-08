import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { backupWorkspace, restoreWorkspace } from "./reference-server/src/platform/backup.ts";
import { createGoodfindsServer } from "./reference-server/src/entrypoints/mcp.ts";
import { RevisionConflict } from "./reference-server/src/workspace/errors.ts";
import { z } from "zod";
import { operations, receiptSchema, errorSchema } from "@goodfinds/contracts/operations";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stateFromToolResult } from "@goodfinds/contracts/state";

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-design-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const state = Effect.runSync(store.request("get_workspace")).state;
  assert.ok(state.revisions);
  return { folder, store, state, revisions: state.revisions };
}
function sql<A>(path: string, work: (db: Database) => A) {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}
const observation = () => ({
  listing_id: "123456789",
  url: "https://www.facebook.com/marketplace/item/123456789/",
  title: "M3 Pro laptop",
  product: "macbook_pro",
  source: "facebook_marketplace",
  provenance: "manual",
  collection_stage: "discovery",
  price_minor: 90000,
  price_kind: "asking",
  currency: "GBP",
  observed_at: new Date().toISOString(),
  chip: "M3 Pro",
  ram_gb: 32,
  ssd_gb: 1000,
  photos: [],
});

void test("independent entity edits survive unrelated changes and reject stale edits to the same search", (t) => {
  const { store, state, revisions } = fixture(t);
  const first = state.config.searches[0],
    second = state.config.searches[1];
  assert.ok(first);
  assert.ok(second);
  Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisions.settings,
      settings: { origin: "Other town" },
    }),
  );
  const changed = Effect.runSync(
    store.request("save_search", {
      expected_entity_revision: revisions.searches[second.id],
      search: { ...second, name: "Second search" },
    }),
  ).state;
  assert.equal(changed.revisions?.searches[first.id], revisions.searches[first.id]);
  const final = Effect.runSync(
    store.request("save_search", {
      expected_entity_revision: revisions.searches[first.id],
      search: { ...first, name: "First search" },
    }),
  ).state;
  assert.equal(final.config.origin, "Other town");
  assert.equal(final.config.searches.find((item) => item.id === second.id)?.name, "Second search");
  assert.throws(
    () =>
      Effect.runSync(
        store.request("save_search", {
          expected_entity_revision: revisions.searches[first.id],
          search: { ...first, name: "Stale" },
        }),
      ),
    RevisionConflict,
  );
});

void test("draft promotion checks the draft revision atomically", (t) => {
  const { store, state } = fixture(t);
  const search = state.config.searches[0];
  assert.ok(search);
  const draft = {
    id: "draft-design",
    name: "Draft",
    definition: search.definition,
    values: search.values,
  };
  const before = Effect.runSync(
    store.request("save_search_draft", {
      expected_entity_revision: revisionFor(state, "save_search_draft", { draft }),
      draft,
    }),
  ).state;
  Effect.runSync(
    store.request("save_search_draft", {
      expected_entity_revision: revisionFor(before, "save_search_draft", { draft: { ...draft } }),
      draft: { ...draft, name: "Changed draft" },
    }),
  );
  assert.throws(
    () =>
      Effect.runSync(
        store.request("save_search", {
          expected_entity_revision: revisionFor(before, "save_search", {
            draft_id: draft.id,
            search: { ...search, id: "promoted-search" },
          }),
          expected_draft_revision: before.revisions?.drafts[draft.id],
          draft_id: draft.id,
          search: { ...search, id: "promoted-search" },
        }),
      ),
    RevisionConflict,
  );
  const after = Effect.runSync(store.request("get_workspace")).state;
  assert.equal(after.drafts[0]?.name, "Changed draft");
  assert.equal(
    after.searches.some((item) => item.id === "promoted-search"),
    false,
  );
});

void test("configuration uses separate rows and deleted identities retain their revision history", (t) => {
  const { store, state, revisions } = fixture(t);
  const search = state.config.searches[0];
  assert.ok(search);
  const removed = Effect.runSync(
    store.request("remove_search", {
      search_id: search.id,
      expected_entity_revision: revisions.searches[search.id],
    }),
  ).state;
  assert.equal(
    removed.searches.some((item) => item.id === search.id),
    false,
  );
  sql(store.databasePath, (db) => {
    assert.equal(
      db
        .query<{ is_deleted: number }, [string]>("SELECT is_deleted FROM saved_searches WHERE id=?")
        .get(search.id)?.is_deleted,
      1,
    );
    const data = db
      .query<{ data: string }, []>("SELECT document_json AS data FROM workspace_settings")
      .get();
    assert.ok(data);
    assert.equal(
      "searches" in z.record(z.string(), z.unknown()).parse(JSON.parse(data.data) as unknown),
      false,
    );
  });
  assert.throws(
    () =>
      Effect.runSync(
        store.request("save_search", {
          expected_entity_revision: revisions.searches[search.id],
          search: search,
        }),
      ),
    RevisionConflict,
  );
});

void test("import retries preserve one evaluateObservations and receipt across restart and reject request ID reuse", (t) => {
  const { store, folder } = fixture(t);
  const args = { request_id: randomUUID(), observations: [observation()] };
  const imported = Effect.runSync(store.request("import_listing_observations", args));
  const replayed = Effect.runSync(
    new WorkspaceStore(seedWorkspace(folder)).request("import_listing_observations", args),
  );
  assert.deepEqual(replayed["import_receipt"], imported["import_receipt"]);
  assert.equal(receiptSchema.parse(replayed["receipt"]).replayed, true);
  sql(store.databasePath, (db) => {
    assert.equal(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM listing_evaluations").get()
        ?.count,
      1,
    );
    assert.equal(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM listing_observations").get()
        ?.count,
      1,
    );
  });
  assert.throws(
    () =>
      Effect.runSync(store.request("import_listing_observations", { ...args, observations: [] })),
    /already used/u,
  );
});

void test("a failed import rolls back its receipt and can be retried with the original request ID", (t) => {
  const { store } = fixture(t);
  const args = { request_id: randomUUID(), observations: [observation()] };
  sql(store.databasePath, (db) =>
    db.run(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
    ),
  );
  assert.throws(
    () => Effect.runSync(store.request("import_listing_observations", args)),
    /injected receipt failure/u,
  );
  sql(store.databasePath, (db) => {
    assert.equal(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM listing_evaluations").get()
        ?.count,
      0,
    );
    db.run("DROP TRIGGER reject_receipt");
  });
  assert.equal(
    Effect.runSync(store.request("import_listing_observations", args)).state.listings.length,
    1,
  );
});

void test("workspace backup restores committed WAL data, media and operation receipts", (t) => {
  const { store, folder, state } = fixture(t);
  const output = resolve(folder, "backup"),
    restored = resolve(folder, "restored");
  const bytes = Buffer.from("immutable media");
  const id = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(resolve(folder, "media"));
  writeFileSync(resolve(folder, "media", id), bytes);
  const args = {
    expected_entity_revision: state.revisions.settings,
    request_id: randomUUID(),
    settings: { origin: "Backed up town" },
  };
  // Keep a connection open with WAL frames while snapshotting.
  sql(store.databasePath, (db) => {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA wal_autocheckpoint=0");
    Effect.runSync(store.request("save_settings", args));
    Effect.runSync(backupWorkspace(store.databasePath, output));
  });
  Effect.runSync(restoreWorkspace(output, restored));
  const restoredStore = new WorkspaceStore(seedWorkspace(restored));
  assert.equal(Effect.runSync(restoredStore.config()).origin, "Backed up town");
  assert.deepEqual(readFileSync(resolve(restored, "media", id)), bytes);
  assert.equal(
    receiptSchema.parse(Effect.runSync(restoredStore.request("save_settings", args))["receipt"])
      .replayed,
    true,
  );
  assert.throws(() => Effect.runSync(restoreWorkspace(output, restored)), /new output directory/u);
});

void test("restore verifies checksums and publishes no partial workspace on corruption", (t) => {
  const { store, folder } = fixture(t);
  const backup = resolve(folder, "backup"),
    restored = resolve(folder, "restore");
  Effect.runSync(backupWorkspace(store.databasePath, backup));
  writeFileSync(resolve(backup, "workspace.sqlite"), "corrupt");
  assert.throws(() => Effect.runSync(restoreWorkspace(backup, restored)), /checksum/u);
  assert.equal(existsSync(restored), false);
});

void test("MCP advertises concrete shared result schemas and returns resource results and structured conflicts", async (t) => {
  const { folder } = fixture(t);
  const { server } = createGoodfindsServer(seedWorkspace(folder));
  t.after(() => server.close());
  const client = new Client({ name: "Design test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(() => client.close());
  const listed = await client.listTools();
  for (const tool of listed.tools)
    if (tool.name !== "get_goodfinds_image")
      assert.ok(tool.outputSchema, `${tool.name} has a result schema`);
  assert.equal("search_id" in operations.get_settings.input.shape, false);
  const remove = listed.tools.find((tool) => tool.name === "remove_goodfinds_search");
  assert.equal(remove?.annotations?.destructiveHint, true);
  for (const definition of Object.values(operations))
    for (const name of definition.names)
      assert.ok(
        listed.tools.find((tool) => tool.name === name)?.outputSchema,
        `${name} has a result schema`,
      );
  const initial = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  const result = await client.callTool({
    name: "save_goodfinds_settings",
    arguments: {
      expected_entity_revision: revisionFor(initial, "save_goodfinds_settings"),
      request_id: randomUUID(),
      settings: { origin: "MCP town" },
    },
  });
  const output = operations.save_settings.output.parse(result.structuredContent);
  assert.equal(output.settings.origin, "MCP town");
  assert.equal("state" in output, false);
  assert.equal(stateFromToolResult(result).config.origin, "MCP town");
  const conflict = await client.callTool({
    name: "save_goodfinds_settings",
    arguments: {
      expected_entity_revision: revisionFor(initial, "save_goodfinds_settings"),
      settings: { origin: "Stale town" },
    },
  });
  assert.equal(conflict.isError, true);
  assert.equal(
    z.object({ error: errorSchema }).parse(conflict.structuredContent).error.code,
    "revision_conflict",
  );
});

void test("search lifecycle results expose prerequisites and never imply send permission", async (t) => {
  const { folder, state } = fixture(t);
  const { server, calls } = createGoodfindsServer(seedWorkspace(folder));
  t.after(() => server.close());
  const call = calls.get("request_goodfinds_search_run");
  assert.ok(call);
  const output = operations.request_search_run.output.parse(
    (await call({ request: { search_id: state.searches[0]?.id, request_id: randomUUID() } }))
      .structuredContent,
  );
  assert.ok(output.workflow.allowed_actions.includes("claim_goodfinds_search_run"));
  assert.equal(
    output.workflow.actions.find((a) => a.event === "claim")?.availability,
    "requires_input",
  );
  assert.equal(
    output.workflow.actions.find((a) => a.event === "cancel")?.availability,
    "available",
  );
  assert.ok(output.workflow.prerequisites.length);
  assert.equal("execution" in output, false);
});
