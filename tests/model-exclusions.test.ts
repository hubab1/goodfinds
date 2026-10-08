import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { savedSearchSchema } from "@goodfinds/contracts/search-definition";
import { modelIsExcluded } from "@goodfinds/contracts/discovery";
import { queryPlan } from "@goodfinds/contracts/search-workflow";
import {
  listingQuerySchema,
  selectListings,
  EMPTY_SELLER_FILTERS,
} from "@goodfinds/contracts/listing-query";
import { revisionFor } from "./helpers/revisions.ts";

const coffeeSearch = savedSearchSchema.parse({
  id: "coffee-machine",
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
        id: "budget",
        label: "Budget",
        type: "integer",
        match: { attribute: "price_minor", operator: "lte" },
      },
    ],
  },
  values: { budget: 20000 },
});

void test("model exclusions survive restart, filter aliases in all views and planning, and Undo restores them", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-models-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const base = coffeeSearch;
  const search = {
    ...base,
    discovery: {
      scope: "alternatives" as const,
      model_attribute: "model",
      reference_model: "Sage Barista Express",
      model_aliases: [
        { canonical: "Sage Barista Express", aliases: ["Sage BES875", "Breville Barista Express"] },
      ],
    },
  };
  state = Effect.runSync(
    store.request("save_search", {
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", { search }),
      search,
    }),
  ).state;
  const models = ["Sage BES875", "Breville Barista Express", "Sage Bambino", "Unknown model"];
  state = Effect.runSync(
    store.request("import_listing_observations", {
      observations: models.map((model, i) => ({
        listing_id: String(123450 + i),
        source: "facebook_marketplace",
        provenance: "manual",
        url: `https://www.facebook.com/marketplace/item/${123450 + i}/`,
        title: model,
        product: search.product,
        price_minor: 10000,
        price_kind: "asking",
        currency: "GBP",
        observed_at: new Date().toISOString(),
        attributes: { model },
        evidence: { model: `Model label: ${model}` },
      })),
    }),
  ).state;
  const row = state.listings.find((listing) => listing.listing_id === "123450");
  assert.ok(row);
  state = Effect.runSync(
    store.request("record_listing_feedback", {
      expected_entity_revision: revisionFor(state, "record_goodfinds_listing_feedback"),
      feedback: {
        search_id: search.id,
        listing_key: row.key,
        action: "dismiss",
        reason: "Exclude this model from this search",
        exclude_model: true,
      },
    }),
  ).state;
  const event = state.config.feedback.at(-1);
  assert.equal(event?.rule?.value, "Sage Barista Express");
  assert.equal(event?.rule?.importance, "required");
  const restarted = new WorkspaceStore(seedWorkspace(folder));
  state = Effect.runSync(restarted.request("get_workspace")).state;
  const banned = state.listings.find((listing) => listing.listing_id === "123451");
  assert.ok(banned);
  assert.equal(modelIsExcluded(banned, search, state.config.feedback), true);
  const visible = selectListings(state, {
    search_id: search.id,
    sellerFilters: EMPTY_SELLER_FILTERS,
    result_type: "all",
  });
  assert.deepEqual(visible.map((listing) => listing.listing_id).toSorted(), ["123452", "123453"]);
  const page = Effect.runSync(
    restarted.query(
      "list_listings",
      listingQuerySchema.parse({
        search_id: search.id,
        include_excluded: true,
        include_dismissed: true,
      }),
    ),
  );
  assert.ok("total" in page);
  assert.equal(page.total, 4);
  const planned = queryPlan(search, state.config.feedback);
  assert.ok(planned.some((query) => query.purpose === "category"));
  assert.ok(!planned.some((query) => ["exact", "alias"].includes(query.purpose)));
  assert.ok(
    state.decisions
      .find((decision) => decision.listing.key === banned.key)
      ?.reasons.includes("Exclude Sage Barista Express"),
  );
  assert.ok(event);
  state = Effect.runSync(
    restarted.request("undo_listing_feedback", {
      expected_entity_revision: revisionFor(state, "undo_goodfinds_listing_feedback", {
        feedback_id: event.id,
      }),
      feedback_id: event.id,
    }),
  ).state;
  assert.equal(modelIsExcluded(banned, search, state.config.feedback), false);
  assert.equal(
    selectListings(state, { search_id: search.id, sellerFilters: EMPTY_SELLER_FILTERS }).length,
    4,
  );
  assert.ok(queryPlan(search, state.config.feedback).some((query) => query.purpose === "exact"));
});

void test("unknown models cannot create bans and old explicit model rejections upgrade only with verified identity", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-old-feedback-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const search = coffeeSearch;
  state = Effect.runSync(
    store.request("save_search", {
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", { search }),
      search,
    }),
  ).state;
  state = Effect.runSync(
    store.request("import_listing_observations", {
      observations: ["Sage Bambino", "DeLonghi espresso machine (exact model unknown)"].map(
        (model, i) => ({
          listing_id: String(99880 + i),
          source: "facebook_marketplace",
          provenance: "manual",
          url: `https://www.facebook.com/marketplace/item/${99880 + i}/`,
          title: model,
          product: search.product,
          price_minor: 10000,
          price_kind: "asking",
          observed_at: new Date().toISOString(),
          attributes: { model },
          evidence: { model },
        }),
      ),
    }),
  ).state;
  const unknown = state.listings.find((row) => row.listing_id === "99881");
  assert.ok(unknown);
  assert.throws(
    () =>
      Effect.runSync(
        store.request("record_listing_feedback", {
          expected_entity_revision: revisionFor(state, "record_goodfinds_listing_feedback"),
          feedback: {
            search_id: search.id,
            listing_key: unknown.key,
            action: "dismiss",
            reason: "Not interested in this model",
            exclude_model: true,
          },
        }),
      ),
    /model is not verified/u,
  );
  const db = new Database(store.databasePath);
  try {
    for (const [index, row] of state.listings.entries()) {
      const event = {
        id: `old-${index}`,
        search_id: search.id,
        listing_key: row.key,
        action: "dismiss",
        reason: "Not interested in this model",
        scope: "search",
        category: search.product,
        created_at: new Date().toISOString(),
        undone: false,
      };
      db.run("INSERT INTO listing_feedback_events VALUES (?,?,1,0,?,?)", [
        event.id,
        search.id,
        index,
        JSON.stringify(event),
      ]);
    }
  } finally {
    db.close();
  }
  state = Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state;
  const known = state.config.feedback.find((event) => event.listing_key !== unknown.key);
  assert.equal(known?.rule?.value, "Sage Bambino");
  assert.equal(
    state.config.feedback.find((event) => event.listing_key === unknown.key)?.rule,
    undefined,
  );
});
