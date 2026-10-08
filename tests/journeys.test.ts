import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import {
  journeyQueue,
  journeyOriginKey,
  journeyReportSchema,
  journeyFresh,
  journeyLifetime,
} from "@goodfinds/contracts/journeys";
import { savedSearchSchema } from "@goodfinds/contracts/search-definition";
import { criteria } from "../apps/server/src/searches/definition.ts";
import { listingObservationSchema } from "../apps/server/src/workspace/model.ts";
import { stateFromToolResult, listingSchema } from "@goodfinds/contracts/state";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { revisionFor } from "./helpers/revisions.ts";
import { initializeWorkspaceDatabase } from "../apps/server/src/platform/database-schema.ts";
const search = savedSearchSchema.parse({
  id: "coffee",
  name: "Coffee",
  product: "espresso_machine",
  enabled: true,
  definition: {
    schema_version: 1,
    version: 1,
    category: "espresso_machine",
    title: "Coffee",
    description: "Find a coffee machine",
    price: { currency: "GBP", period: "once" },
    comparison_attributes: ["model"],
    fields: [
      {
        id: "drive",
        label: "Travel limit",
        type: "integer",
        match: { attribute: "drive_minutes", operator: "lte" },
      },
    ],
  },
  values: { drive: 60 },
});
const queueSchema = z.object({
  origin_key: z.string(),
  enabled: z.boolean(),
  total: z.number(),
  checks: z.array(
    z.object({
      destination: z.string(),
      country: z.string().nullable(),
      listing_keys: z.array(z.string()),
      maps_url: z.string(),
    }),
  ),
});

void test("checked routes share a persistent local cache without refreshing listing facts, and changed origins invalidate reuse", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-journeys-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  state = Effect.runSync(
    store.request("save_search", {
      search,
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", { search }),
    }),
  ).state;
  state = Effect.runSync(
    store.request("save_settings", {
      settings: { origin: "Example origin town" },
      expected_entity_revision: state.revisions.settings,
    }),
  ).state;
  const observed = new Date(Date.now() - 60000).toISOString();
  const row = (id: number, location = "Example destination town") => ({
    listing_id: String(id),
    source: "facebook_marketplace",
    provenance: "manual",
    product: search.product,
    title: "Coffee machine",
    price_minor: 10000,
    price_kind: "asking",
    currency: "GBP",
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    location,
    country: "GB",
    location_precision: "approximate",
    observed_at: observed,
    attributes: { model: "Sage Bambino" },
    evidence: { model: "Model label Sage Bambino" },
    availability: "active",
  });
  state = Effect.runSync(
    store.request("import_listing_observations", {
      observations: [row(88001), row(88002), row(88003, "Long Eaton")],
    }),
  ).state;
  const queue = queueSchema.parse(
    Effect.runSync(store.query("list_journey_checks", { search_id: search.id })),
  );
  assert.equal(queue.total, 2);
  const town = queue.checks.find((item) => item.destination === "Example destination town");
  assert.ok(town);
  assert.equal(town.listing_keys.length, 2);
  assert.equal(new URL(town.maps_url).searchParams.get("origin"), "Example origin town");
  const report = {
    origin_key: queue.origin_key,
    destination: town.destination,
    country: town.country,
    listing_keys: town.listing_keys,
    drive_minutes: 39,
    estimate_kind: "typical",
    source_url: town.maps_url,
    evidence: "Example origin town to Example destination town, driving, usually 39 min",
    checked_at: new Date().toISOString(),
  };
  state = Effect.runSync(
    store.request("record_journey_check", { request_id: randomUUID(), report }),
  ).state;
  const checked = state.listings.filter((listing) => listing.location === town.destination);
  assert.ok(
    checked.every(
      (listing) => listing.drive_minutes === 39 && listing.journey_estimate?.precision === "town",
    ),
  );
  assert.ok(
    checked.every(
      (listing) => listing.observed_at === observed && listing.last_observed_at === observed,
    ),
  );
  const detail = Effect.runSync(store.query("get_listing", { listing_key: checked[0]?.key }));
  assert.ok("listing" in detail);
  assert.equal(detail.listing.drive_minutes, 39);
  assert.equal(
    queueSchema.parse(
      Effect.runSync(
        new WorkspaceStore(seedWorkspace(folder)).query("list_journey_checks", {
          search_id: search.id,
        }),
      ),
    ).total,
    1,
  );
  state = Effect.runSync(
    store.request("import_listing_observations", { observations: [row(88004)] }),
  ).state;
  assert.equal(state.listings.find((listing) => listing.listing_id === "88004")?.drive_minutes, 39);
  assert.throws(
    () =>
      Effect.runSync(
        store.request("record_journey_check", { report: { ...report, destination: "Telford" } }),
      ),
    /destination must match/u,
  );
  state = Effect.runSync(
    store.request("import_listing_observations", {
      observations: [
        {
          ...row(88001, "Telford"),
          collection_stage: "discovery",
          observed_at: new Date().toISOString(),
        },
      ],
    }),
  ).state;
  assert.equal(
    state.listings.find((listing) => listing.listing_id === "88001")?.drive_minutes,
    null,
  );
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: state.revisions.settings,
      settings: { origin: "Birmingham town centre" },
    }),
  ).state;
  assert.equal(
    queueSchema.parse(Effect.runSync(store.query("list_journey_checks", { search_id: search.id })))
      .total,
    3,
  );
  assert.throws(
    () => Effect.runSync(store.request("record_journey_check", { report })),
    /origin changed/u,
  );
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: state.revisions.settings,
      settings: { journey_checks_enabled: false },
    }),
  ).state;
  assert.equal(
    queueSchema.parse(Effect.runSync(store.query("list_journey_checks", { search_id: search.id })))
      .total,
    0,
  );
});

void test("town routes expire according to evidence and unresolved destinations stay unknown", () => {
  const now = Date.now();
  const config = { origin: "Example origin town", origin_confirmed: true };
  const row = listingSchema.parse({
    key: "manual:1",
    listing_id: "1",
    url: "https://www.facebook.com/marketplace/item/1/",
    title: "Machine",
    product: "espresso_machine",
    price_minor: 1000,
    location: "Telford",
  });
  const report = journeyReportSchema.parse({
    origin_key: journeyOriginKey(config),
    destination: "Telford",
    country: null,
    listing_keys: [row.key],
    drive_minutes: 38,
    estimate_kind: "traffic",
    source_url: "https://www.google.com/maps/dir/?api=1",
    evidence: "Driving route to Telford: 38 min",
    checked_at: new Date(now - 2 * 86400000).toISOString(),
  });
  const route = {
    ...report,
    expires_at: new Date(
      Date.parse(report.checked_at) + journeyLifetime(report.estimate_kind),
    ).toISOString(),
  };
  assert.equal(journeyFresh(route, config, row, now), false);
  assert.equal(
    journeyFresh(
      {
        ...route,
        estimate_kind: "typical",
        expires_at: new Date(
          Date.parse(report.checked_at) + journeyLifetime("typical"),
        ).toISOString(),
      },
      config,
      row,
      now,
    ),
    true,
  );
  assert.equal(journeyFresh(route, { ...config, origin: "Birmingham" }, row, now), false);
  assert.equal(journeyQueue([{ ...row, location: null }], [search], [], config, now).length, 0);
});

void test("journey tools register in MCP and the additive database upgrade preserves old tables", async (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.run(
    "CREATE TABLE preserved (id TEXT); INSERT INTO preserved VALUES ('saved'); PRAGMA user_version=1;",
  );
  initializeWorkspaceDatabase(db);
  assert.ok(db.query("SELECT 1 FROM journey_estimates").all());
  assert.deepEqual(db.query("SELECT id FROM preserved").get(), { id: "saved" });
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-journey-tools-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(folder));
  t.after(async () => {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  });
  assert.ok(calls.has("list_goodfinds_journey_checks"));
  const record = calls.get("record_goodfinds_journey_check");
  const load = calls.get("get_goodfinds_workspace");
  const importRows = calls.get("import_goodfinds_listing_observations");
  assert.ok(record);
  assert.ok(load);
  assert.ok(importRows);
  let state = stateFromToolResult(await load({}));
  const product = state.searches[0]?.product;
  assert.ok(product);
  state = stateFromToolResult(
    await importRows({
      observations: [
        {
          listing_id: "88991",
          source: "facebook_marketplace",
          provenance: "manual",
          title: "Example",
          product,
          price_minor: 10000,
          price_kind: "asking",
          url: "https://www.facebook.com/marketplace/item/88991/",
          observed_at: new Date().toISOString(),
          location: "Example town",
        },
      ],
    }),
  );
  const row = state.listings[0];
  assert.ok(row?.location);
  const result = await record({
    report: {
      origin_key: journeyOriginKey(state.config),
      destination: row.location,
      country: null,
      listing_keys: [row.key],
      drive_minutes: 35,
      source_url: "https://www.google.com/maps/dir/?api=1",
      evidence: "Example driving route: 35 min",
      checked_at: new Date().toISOString(),
    },
  });
  assert.equal(
    stateFromToolResult(result).listings.find((item) => item.key === row.key)?.drive_minutes,
    35,
  );
});

void test("town estimates on either side of the travel boundary stay conditional", () => {
  const row = listingObservationSchema.parse({
    key: "manual:1",
    source: "facebook_marketplace",
    provenance: "manual",
    observed_at: new Date().toISOString(),
    listing_id: "1",
    url: "https://www.facebook.com/marketplace/item/1/",
    title: "Machine",
    product: search.product,
    price_minor: 10000,
    drive_minutes: 61,
    journey_estimate: {
      origin_key: "origin",
      destination: "Town",
      country: null,
      drive_minutes: 61,
      precision: "town",
      estimate_kind: "traffic",
      source_url: "https://www.google.com/maps/dir/?api=1",
      evidence: "61 min",
      checked_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  const [rejected, uncertain] = criteria(row, search, true);
  assert.ok(!rejected.some((reason) => reason.includes("Travel limit")));
  assert.ok(uncertain.some((reason) => reason.includes("Travel limit")));
  const [far] = criteria({ ...row, drive_minutes: 90 }, search, true);
  assert.ok(far.some((reason) => reason.includes("Travel limit")));
});
