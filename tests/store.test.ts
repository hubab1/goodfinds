import sampleRows from "../skills/marketplace-shopping/assets/demo-listings.json";
import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import { Effect } from "effect";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
void test("Native storage preserves edits, rejects stale and invalid writes, and isolates sample data", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-state-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const live = new NativeWorkspace(seedWorkspace(folder)),
    sample = new NativeWorkspace(folder, "sample"),
    before = Effect.runSync(live.request("get_workspace")).state;
  const search = before.config.searches[0];
  assert.ok(search);
  assert.throws(() =>
    Effect.runSync(
      live.request("save_search", {
        search: { ...search, values: { ...search.values, min_ram_gb: -1 } },
        expected_entity_revision: revisionFor(before, "save_search", { search: { ...search } }),
      }),
    ),
  );
  assert.equal(Effect.runSync(live.request("get_workspace")).state.revision, before.revision);
  Effect.runSync(
    live.request("save_search", {
      search: { ...search, values: { ...search.values, max_price_minor: 99999 } },
      expected_entity_revision: revisionFor(before, "save_search", { search: { ...search } }),
    }),
  );
  assert.equal(
    Effect.runSync(new NativeWorkspace(seedWorkspace(folder)).request("get_workspace")).state
      .searches[0]?.values["max_price_minor"],
    99999,
  );
  const settingsChanged = Effect.runSync(
    live.request("save_settings", {
      expected_entity_revision: before.revisions.settings,
      settings: { origin: "Another town" },
    }),
  ).state;
  assert.equal(settingsChanged.config.origin, "Another town");
  assert.throws(
    () =>
      Effect.runSync(
        live.request("save_settings", {
          expected_entity_revision: before.revisions.settings,
          settings: { origin: "A stale edit" },
        }),
      ),
    /does not match this resource/u,
  );
  const first = Effect.runSync(sample.request("load_sample_workspace")).state;
  assert.equal(first.counts.listings, 20);
  // Demo results use their own fictional budget, not the edited live search.
  assert.equal(first.counts.deals, 4);
  const second = Effect.runSync(sample.request("load_sample_workspace")).state;
  assert.equal(second.counts.pending_alerts, first.counts.pending_alerts);
  assert.equal(second.activity.length, 2);
  assert.equal(second.listings[0]?.price_history?.length, 2);
  assert.equal(Effect.runSync(live.request("get_workspace")).state.counts.listings, 0);
  assert.equal(
    Effect.runSync(live.request("get_workspace")).state.revision,
    settingsChanged.revision,
  );
  assert.throws(
    () => Effect.runSync(live.request("load_sample_workspace")),
    /"sample" was expected/u,
  );
  assert.throws(() =>
    Effect.runSync(live.request("import_listing_observations", { observations: sampleRows })),
  );
});

void test("separate native processes serialize revision checks and prevent lost edits", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-concurrent-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const before = Effect.runSync(
    new NativeWorkspace(seedWorkspace(folder)).request("get_workspace"),
  ).state;
  const code = `import {Effect} from "effect"; import {NativeWorkspace} from ${JSON.stringify(resolve("tests/helpers/native-workspace.ts"))}; try { Effect.runSync(new NativeWorkspace(process.env.GOODFINDS_TEST_DATA).request("save_settings",{expected_entity_revision:process.env.GOODFINDS_TEST_REVISION,settings:{origin:process.env.GOODFINDS_TEST_ORIGIN}})); process.stdout.write("saved"); } catch (error) {process.stdout.write(error.message); process.exitCode=2;}`;
  const children = ["First town", "Second town"].map((origin) =>
    Bun.spawn([process.execPath, "-e", code], {
      env: {
        ...process.env,
        GOODFINDS_TEST_DATA: folder,
        GOODFINDS_TEST_REVISION: before.revisions.settings,
        GOODFINDS_TEST_ORIGIN: origin,
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      text: await new Response(child.stdout).text(),
    })),
  );
  assert.deepEqual(
    results.map((item) => item.code).toSorted((a, b) => a - b),
    [0, 2],
  );
  assert.ok(results.some((item) => item.text.includes("does not match this resource")));
  assert.ok(
    ["First town", "Second town"].includes(
      Effect.runSync(new NativeWorkspace(seedWorkspace(folder)).request("get_workspace")).state
        .config.origin,
    ),
  );
});

void test("draft definition changes require a new version and invalid saves keep the draft", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-draft-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(folder)),
    before = Effect.runSync(store.request("get_workspace")).state,
    search = before.config.searches[0];
  assert.ok(search);
  const created = Effect.runSync(
    store.request("save_search_draft", {
      expected_entity_revision: revisionFor(before, "save_search_draft", { draft: {} }),
      draft: { name: "Laptop", definition: search.definition, values: {} },
    }),
  ).state;
  const draft = created.drafts[0];
  assert.ok(draft);
  assert.throws(
    () =>
      Effect.runSync(
        store.request("save_search_draft", {
          expected_entity_revision: revisionFor(created, "save_search_draft", {
            draft: { ...draft },
          }),
          draft: { ...draft, definition: { ...draft.definition, title: "Changed" } },
        }),
      ),
    /version/u,
  );
  assert.throws(() =>
    Effect.runSync(
      store.request("save_search", {
        expected_entity_revision: revisionFor(created, "save_search", {
          draft_id: draft.id,
          search: {},
        }),
        draft_id: draft.id,
        search: {
          name: draft.name,
          product: search.product,
          definition: draft.definition,
          values: {},
        },
      }),
    ),
  );
  assert.equal(
    Effect.runSync(new NativeWorkspace(seedWorkspace(folder)).request("get_workspace")).state
      .drafts[0]?.id,
    draft.id,
  );
});
