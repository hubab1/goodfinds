import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { createNativeServer } from "./helpers/native-mcp.ts";
import { ruleHash, validateConfiguration } from "./helpers/native-domain.ts";
import exampleWorkspace from "../skills/marketplace-shopping/assets/example-workspace.json";
import { operations } from "@goodfinds/contracts/operations";

void test("the unreleased API exposes canonical tools and rejects former mutation arguments", async (t) => {
  const { calls, server } = createNativeServer();
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
  const { calls, server } = createNativeServer();
  t.after(() => server.close());
  const root = resolve("skills/marketplace-shopping");
  for (const file of new Bun.Glob("**/*.md").scanSync(root)) {
    const text = readFileSync(resolve(root, file), "utf8");
    for (const name of text.match(/\b[a-z]+_(?:goodfinds|marketplace)_[a-z_]+\b/gu) ?? [])
      assert.equal(calls.has(name), true, `${file}: ${name}`);
  }
});
