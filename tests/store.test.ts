import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import { Effect } from "effect";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import {
  rationalRound,
  validateConfiguration,
  comparisonPool,
  historyCohort,
} from "./reference-server/src/listings/evaluation.ts";
import {
  acknowledge,
  connect,
  evaluateObservations,
} from "./reference-server/src/platform/listing-evaluation-sqlite.ts";
import { load, insights } from "./reference-server/src/platform/tracking-sqlite.ts";
import { DAY, iso } from "./reference-server/src/workspace/model.ts";
import { all } from "./reference-server/src/platform/sqlite.ts";
import { runDemo, renderReport } from "./reference-server/src/entrypoints/cli.ts";
import exampleConfig from "../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import sampleRows from "../skills/marketplace-shopping/assets/demo-listings.json" with { type: "json" };

function publication(stamp: number) {
  return {
    raw_text: iso(stamp),
    earliest_at: iso(stamp),
    latest_at: iso(stamp),
    precision: "exact",
    kind: "published",
    evidence: "Listing displays timestamp",
  };
}

void test("Bun storage preserves edits, rejects stale and invalid writes, and isolates sample data", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-state-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const live = new WorkspaceStore(seedWorkspace(folder)),
    sample = new WorkspaceStore(folder, "sample"),
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
    Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state
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
    /changed elsewhere/u,
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
  assert.throws(() => Effect.runSync(live.request("load_sample_workspace")), /sample mode/u);
  assert.throws(() =>
    Effect.runSync(live.request("import_listing_observations", { observations: sampleRows })),
  );
});

void test("separate Bun processes serialize revision checks and prevent lost edits", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-concurrent-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const before = Effect.runSync(
    new WorkspaceStore(seedWorkspace(folder)).request("get_workspace"),
  ).state;
  const code = `import {Effect} from "effect"; import {WorkspaceStore} from ${JSON.stringify(resolve("tests/reference-server/src/platform/workspace-sqlite.ts"))}; try { Effect.runSync(new WorkspaceStore(process.env.GOODFINDS_TEST_DATA).request("save_settings",{expected_entity_revision:process.env.GOODFINDS_TEST_REVISION,settings:{origin:process.env.GOODFINDS_TEST_ORIGIN}})); process.stdout.write("saved"); } catch (error) {process.stdout.write(error.message); process.exitCode=2;}`;
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
  assert.ok(results.some((item) => item.text.includes("changed elsewhere")));
  assert.ok(
    ["First town", "Second town"].includes(
      Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state
        .config.origin,
    ),
  );
});

void test("draft definition changes require a new version and invalid saves keep the draft", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-draft-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder)),
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
    Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state
      .drafts[0]?.id,
    draft.id,
  );
});

void test("coverage measures evidenced arrivals and leaves gaps and missing publication unknown", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-coverage-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = resolve(folder, "history.sqlite"),
    now = Date.parse("2026-10-04T12:00:00Z"),
    start = now - (3 * DAY) / 24;
  const config = Effect.runSync(validateConfiguration(exampleConfig)),
    search = config.searches[0],
    row = sampleRows[0];
  assert.ok(search && row);
  const run = (stamp: number, status = "success") => ({
    source: "facebook_marketplace",
    search_id: search.id,
    query: "MacBook Pro",
    filters: { area: "Example origin" },
    sort: "newest",
    started_at: iso(stamp),
    finished_at: iso(stamp),
    status,
    pagination_complete: status === "success",
    result_count: null,
    inspected_count: null,
  });
  Effect.runSync(
    evaluateObservations(
      config,
      [Object.assign({}, row, { publication: publication(start - 5 * DAY) })],
      path,
      true,
      start,
      [run(start)],
    ),
  );
  Effect.runSync(
    evaluateObservations(
      config,
      [
        Object.assign({}, row, {
          listing_id: "arrival",
          url: "https://example.invalid/arrival",
          publication: publication(start + DAY / 48),
        }),
      ],
      path,
      true,
      start + DAY / 24,
      [run(start + DAY / 24)],
    ),
  );
  const read = (at = now) => {
    const db = Effect.runSync(connect(path));
    try {
      const rows = Effect.runSync(load(db, "synthetic"));
      return Effect.runSync(
        insights(
          db,
          rows,
          search,
          config,
          at,
          historyCohort,
          comparisonPool(rows, search, config, at, true),
        ),
      );
    } finally {
      db.close();
    }
  };
  const group = read()[0];
  assert.ok(group);
  assert.equal(group.supported_arrivals, 1);
  assert.equal(group.arrivals_per_day, 24);
  Effect.runSync(
    evaluateObservations(config, [], path, true, start + (2 * DAY) / 24, [
      run(start + (2 * DAY) / 24, "failed"),
    ]),
  );
  Effect.runSync(evaluateObservations(config, [], path, true, now, [run(now)]));
  assert.equal(read()[0]?.coverage_days, group.coverage_days);
  Effect.runSync(
    evaluateObservations(
      config,
      [Object.assign({}, row, { listing_id: "unknown", url: "https://example.invalid/unknown" })],
      path,
      true,
      now + DAY / 24,
      [run(now + DAY / 24)],
    ),
  );
  assert.equal(read(now + DAY / 24)[0]?.arrivals_per_day, null);
  assert.equal(read(now + DAY / 24)[0]?.publication_unknown_count, 1);
});

void test("Bun CLI demo suppresses repeats, reports escape evidence, and acknowledgements are atomic", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-cli-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const summary = Effect.runSync(runDemo(folder));
  assert.equal(summary.first_run_new_alerts, 4);
  assert.equal(summary.second_run_new_alerts, 0);
  const path = resolve(folder, "alerts.sqlite"),
    now = Date.now(),
    config = Effect.runSync(validateConfiguration(exampleConfig));
  const rows = sampleRows.map((row) =>
    Object.assign({}, row, {
      drive_origin: config.origin,
      travel_checked_at: iso(now),
      description: "<script>alert('unsafe')</script>",
    }),
  );
  const first = Effect.runSync(evaluateObservations(config, rows, path, true, now));
  assert.equal(first.new_alerts.length, 4);
  const ids = first.new_alerts.map((alert) => alert.id);
  assert.throws(
    () => Effect.runSync(acknowledge(path, [ids[0] ?? "", "unknown"])),
    /pending alert/u,
  );
  const db = Effect.runSync(connect(path));
  assert.equal(
    Effect.runSync(all(db, "SELECT id FROM deal_alerts WHERE status='delivered'")).length,
    0,
  );
  db.close();
  assert.equal(Effect.runSync(acknowledge(path, ids)), 4);
  assert.equal(
    Effect.runSync(evaluateObservations(config, rows, path, true, now + 1000)).new_alerts.length,
    0,
  );
  Effect.runSync(renderReport(first, resolve(folder, "report.html")));
  const html = readFileSync(resolve(folder, "report.html"), "utf8");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.equal(rationalRound(25n, 10n, 0), 2);
  assert.equal(rationalRound(35n, 10n, 0), 4);
  assert.equal(rationalRound(-25n, 10n, 0), -2);
  z.object({ mode: z.literal("synthetic") }).parse(summary);
});
