import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { initializeWorkspaceDatabase } from "../apps/server/src/platform/database-schema.ts";
import { ruleHash, validateConfiguration } from "../apps/server/src/listings/evaluation.ts";
import exampleWorkspace from "../skills/marketplace-shopping/assets/example-workspace.json";
import { operations } from "@goodfinds/contracts/operations";

void test("the unreleased API exposes canonical tools and rejects former mutation arguments", async (t) => {
  const { calls, server } = createGoodfindsServer();
  t.after(() => server.close());
  for (const name of calls.keys()) assert.match(name, /^[a-z]+_goodfinds_[a-z_]+$/u);
  for (const name of [
    "save_goodfinds_watch",
    "get_goodfinds_state",
    "start_goodfinds_search_run",
    "get_goodfinds_conversation",
    "import_marketplace_listings",
  ])
    assert.equal(calls.has(name), false);
  assert.equal(calls.has("get_goodfinds_workspace"), true);
  assert.equal(calls.has("request_goodfinds_search_run"), true);
  assert.equal(
    operations.save_settings.input.safeParse({
      expected_revision: "a".repeat(64),
      settings: { origin: "Town" },
    }).success,
    false,
  );
  assert.equal(
    operations.set_search_cover.input.safeParse({
      expected_entity_revision: "a".repeat(64),
      watch_id: "search",
      image: null,
    }).success,
    false,
  );
});

void test("workspace initialization is idempotent and refuses noncanonical data without rewriting it", () => {
  const empty = new Database(":memory:");
  try {
    initializeWorkspaceDatabase(empty);
    empty.run("INSERT INTO workspace_settings VALUES(1,'{}',1)");
    initializeWorkspaceDatabase(empty);
    assert.deepEqual(empty.query("SELECT document_json FROM workspace_settings").get(), {
      document_json: "{}",
    });
  } finally {
    empty.close();
  }
  const old = new Database(":memory:");
  try {
    old.run(
      "CREATE TABLE workspace_config(id INTEGER, data TEXT); INSERT INTO workspace_config VALUES(1,'preserved')",
    );
    assert.throws(() => initializeWorkspaceDatabase(old), /Unsupported workspace schema/u);
    assert.deepEqual(old.query("SELECT data FROM workspace_config").get(), { data: "preserved" });
    assert.equal(
      old.query("SELECT name FROM sqlite_master WHERE name='workspace_settings'").get(),
      null,
    );
  } finally {
    old.close();
  }
});

void test("representative covers cannot change deal rules while budget changes do", () => {
  const config = Effect.runSync(validateConfiguration(exampleWorkspace));
  const search = config.searches[0];
  assert.ok(search);
  const original = ruleHash(search, config);
  assert.equal(
    ruleHash(
      {
        ...search,
        cover: {
          media_id: "a".repeat(64),
          kind: "user",
          alt: "My cover",
          source_name: "Buyer",
        },
      },
      config,
    ),
    original,
  );
  assert.notEqual(
    ruleHash({ ...search, values: { ...search.values, max_price_minor: 12345 } }, config),
    original,
  );
});

void test("skill references use only tools advertised by the current server", (t) => {
  const { calls, server } = createGoodfindsServer();
  t.after(() => server.close());
  const root = resolve("skills/marketplace-shopping");
  for (const file of new Bun.Glob("**/*.md").scanSync(root)) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const name of text.match(/\b[a-z]+_(?:goodfinds|marketplace)_[a-z_]+\b/gu) ?? [])
      assert.equal(calls.has(name), true, `${file}: ${name}`);
  }
});
