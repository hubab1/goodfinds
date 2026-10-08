import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { initializeWorkspaceDatabase } from "./reference-server/src/platform/database-schema.ts";
import { listingDiscoveryLabel } from "../apps/ui/src/lib/listing-presentation.ts";
import { firstDiscovery } from "@goodfinds/contracts/listing-discovery";
import { stateToolResult } from "./reference-server/src/entrypoints/mcp.ts";
import { stateSummarySchema } from "@goodfinds/contracts/operations";
import { revisionFor } from "./helpers/revisions.ts";

void test("discovery keeps the original search run through repeat sightings and restart, and counts unique listings per search", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-discovery-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const search = state.searches[0];
  assert.ok(search);
  const start = (search_id = search.id) => {
    state = Effect.runSync(
      store.request("request_search_run", {
        request: { search_id, request_id: randomUUID(), resume: false },
      }),
    ).state;
    const run = state.search_runs.find((item) => item.search_id === search_id);
    assert.ok(run);
    return run;
  };
  const row = (id: number) => ({
    listing_id: String(id),
    source: "facebook_marketplace",
    provenance: "manual",
    title: "Laptop",
    product: search.product,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    price_minor: 90000,
    price_kind: "asking",
    observed_at: new Date().toISOString(),
    collection_stage: "discovery",
  });
  const first = start();
  state = Effect.runSync(
    store.request("import_listing_observations", {
      run_id: first.id,
      observations: [row(200001), row(200001), row(200002)],
    }),
  ).state;
  assert.equal(state.searches.find((item) => item.id === search.id)?.found_count, 2);
  assert.equal(
    stateSummarySchema
      .parse(stateToolResult({ state }).structuredContent?.["state"])
      .searches.find((item) => item.id === search.id)?.found_count,
    2,
  );
  const listing = state.listings.find((item) => item.listing_id === "200001");
  assert.ok(listing);
  assert.equal(listing.first_found_runs?.[0]?.run_id, first.id);
  assert.equal(listing.first_found_runs?.[0]?.run_started_at, first.created_at);
  assert.ok(listing.first_found_runs?.[0]?.recorded_at);
  state = Effect.runSync(
    store.request("cancel_search_run", { request: { run_id: first.id } }),
  ).state;
  const later = start();
  state = Effect.runSync(
    store.request("import_listing_observations", {
      run_id: later.id,
      observations: [row(200001), row(200003)],
    }),
  ).state;
  assert.equal(state.searches.find((item) => item.id === search.id)?.found_count, 3);
  assert.equal(
    state.listings.find((item) => item.key === listing.key)?.first_found_runs?.[0]?.run_id,
    first.id,
  );
  // A second search in the same category records its own discovery and independent count.
  const other = {
    ...state.config.searches.find((item) => item.id === search.id),
    id: "second-search",
    name: "Second search",
  };
  state = Effect.runSync(
    store.request("save_search", {
      search: other,
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", { search: other }),
    }),
  ).state;
  const otherRun = start(other.id);
  assert.equal(state.searches.find((item) => item.id === other.id)?.found_count, 0);
  state = Effect.runSync(
    store.request("import_listing_observations", {
      run_id: otherRun.id,
      observations: [row(200001)],
    }),
  ).state;
  state = Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state;
  assert.equal(state.searches.find((item) => item.id === other.id)?.found_count, 1);
  assert.equal(state.searches.find((item) => item.id === search.id)?.found_count, 3);
  const associations =
    state.listings.find((item) => item.key === listing.key)?.first_found_runs ?? [];
  assert.equal(firstDiscovery(associations, other.id)?.run_id, otherRun.id);
  assert.equal(firstDiscovery(associations, search.id)?.run_id, first.id);
  assert.equal(firstDiscovery(associations, "unrelated"), undefined);
  const detail = Effect.runSync(store.query("get_listing", { listing_key: listing.key }));
  assert.ok("listing" in detail);
  assert.equal(detail.listing.first_found_runs?.length, 2);
  // Media repair/manual fact refresh is not a new discovery run.
  state = Effect.runSync(
    store.request("import_listing_observations", { observations: [row(200001)] }),
  ).state;
  assert.equal(
    firstDiscovery(
      state.listings.find((item) => item.key === listing.key)?.first_found_runs ?? [],
      search.id,
    )?.run_id,
    first.id,
  );
});

void test("older workspaces recover original run links from all retained runs, beyond the progress page limit", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE search_runs (id TEXT PRIMARY KEY,search_id TEXT,document_json TEXT); PRAGMA user_version=2;",
    );
    const original = randomUUID();
    db.run("INSERT INTO search_runs VALUES (?,?,?)", [
      original,
      "laptop",
      JSON.stringify({
        created_at: "2026-10-01T08:15:00.000Z",
        listing_keys: ["manual:1", "manual:1"],
      }),
    ]);
    for (let i = 0; i < 60; i++)
      db.run("INSERT INTO search_runs VALUES (?,?,?)", [
        randomUUID(),
        "laptop",
        JSON.stringify({ created_at: "2026-10-06T15:00:00.000Z", listing_keys: ["manual:1"] }),
      ]);
    initializeWorkspaceDatabase(db);
    const found = db
      .query<{ run_id: string; recorded_at: string | null }, []>(
        "SELECT run_id,recorded_at FROM listing_search_discoveries",
      )
      .get();
    assert.equal(found?.run_id, original);
    assert.equal(found?.recorded_at, null, "Backfill must not invent an ingestion timestamp");
    initializeWorkspaceDatabase(db);
    assert.equal(
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM listing_search_discoveries")
        .get()?.count,
      1,
    );
  } finally {
    db.close();
  }
});

void test("card discovery copy uses the run hour, local timezone and scoped search; missing run metadata is omitted", () => {
  const discovery = {
    search_id: "coffee",
    run_id: randomUUID(),
    run_started_at: "2026-10-06T09:47:00.000Z",
    recorded_at: "2026-10-06T11:22:00.000Z",
  };
  const label = listingDiscoveryLabel({ first_found_runs: [discovery] }, "coffee", "Europe/London");
  assert.equal(label?.label, "Found 6 Oct 2026 · 10am search");
  assert.equal(label?.started_at, discovery.run_started_at);
  assert.equal(listingDiscoveryLabel({ first_found_runs: [discovery] }, "other", "UTC"), undefined);
  assert.equal(listingDiscoveryLabel({ first_found_runs: [] }), undefined);
  assert.equal(listingDiscoveryLabel({}), undefined);
  assert.equal(
    listingDiscoveryLabel(
      { first_found_runs: [{ ...discovery, run_started_at: "2026-10-06T00:00:00.000Z" }] },
      "coffee",
      "UTC",
    )?.label,
    "Found 6 Oct 2026 · 12am search",
  );
});
