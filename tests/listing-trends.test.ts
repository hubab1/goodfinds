import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { listingSchema, savedSearchSchema, stateSchema } from "@goodfinds/contracts/state";
import type { Listing, MarketHistory } from "@goodfinds/contracts/state";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import {
  connect,
  evaluateObservations,
} from "../apps/server/src/platform/listing-evaluation-sqlite.ts";
import sampleRows from "../skills/marketplace-shopping/assets/demo-listings.json" with { type: "json" };
import {
  clusterPoints,
  targetPrice,
  trendGroups,
  trendLayout,
  trendStatus,
  trendWindow,
} from "../apps/ui/src/lib/listing-trends.ts";

const now = Date.parse("2026-10-04T12:00:00Z");
const definition = SEARCH_TEMPLATES.find((item) => item.category === "macbook_pro");
assert.ok(definition);
const search = savedSearchSchema.parse({
  id: "laptop",
  name: "Laptop",
  product: "macbook_pro",
  definition,
  values: { max_price_minor: 120000 },
});
function listing(id: string, extra: Partial<Listing> = {}): Listing {
  return listingSchema.parse({
    key: "facebook_marketplace:" + id,
    listing_id: id,
    title: id,
    source: "facebook_marketplace",
    url: "https://example.invalid/" + id,
    product: "macbook_pro",
    price_minor: 110000,
    price_kind: "asking",
    currency: "GBP",
    price_period: "once",
    availability: "active",
    observed_at: "2026-10-04T10:00:00Z",
    last_successful_at: "2026-10-04T10:00:00Z",
    first_observed_at: "2026-09-01T10:00:00Z",
    chip: "M3 Pro",
    ram_gb: 36,
    ssd_gb: 1000,
    ...extra,
  });
}
function cohort(members: Listing[], extra: Partial<MarketHistory> = {}): MarketHistory {
  return {
    cohort_listing_keys: members.map((row) => row.key),
    cohort_listing_ids: members.map((row) => row.listing_id),
    distinct_count: members.length,
    confirmed_active_count: members.length,
    sold_count: 0,
    unknown_outcome_count: 0,
    supported_arrivals: 0,
    coverage_days: 0,
    arrivals_per_day: null,
    median_arrival_gap_days: null,
    median_cash_price_minor: null,
    cash_price_sample_count: 0,
    window_days: 30,
    currency: "GBP",
    price_period: "once",
    note: "",
    completed_period_count: 0,
    unfinished_period_count: 0,
    median_completed_lower_days: null,
    median_completed_upper_days: null,
    ...extra,
  };
}
function quote(at: string, price: number | null, extra = {}) {
  return {
    evaluated_at: at,
    observed_at: at,
    price_minor: price,
    currency: "GBP",
    price_period: "once",
    ...extra,
  };
}

void test("the target follows the saved price rule, its units and conditional visibility", () => {
  assert.equal(targetPrice(search), 120000);
  const renamed = {
    ...search,
    definition: {
      ...search.definition,
      fields: [
        {
          id: "ceiling",
          label: "Budget",
          type: "integer" as const,
          required: true,
          display_divisor: 100 as const,
          match: {
            attribute: "price_minor",
            operator: "lte" as const,
            importance: "required" as const,
          },
        },
      ],
    },
    values: { ceiling: 95000 },
    max_price_minor: 120000,
  };
  assert.equal(targetPrice(renamed), 95000);
  assert.equal(targetPrice({ ...renamed, values: { ceiling: null } }), null);
  assert.equal(
    targetPrice({
      ...renamed,
      definition: {
        ...renamed.definition,
        fields: renamed.definition.fields.map((field) => ({
          ...field,
          visible_when: { field: "kind", one_of: ["priced"] },
        })),
      },
    }),
    null,
  );
  assert.equal(
    targetPrice({
      ...renamed,
      definition: {
        ...renamed.definition,
        fields: renamed.definition.fields.map((field) =>
          Object.assign({}, field, {
            match: { ...field.match, importance: "preferred" as const },
          }),
        ),
      },
    }),
    null,
  );
});

void test("first prices stay at their actual observed dates and repeated listing_evaluations don't add dots", () => {
  const row = listing("1", {
    price_minor: 100000,
    price_history: [
      quote("2026-10-03T10:00:00Z", 100000),
      quote("2026-10-01T10:00:00Z", 130000),
      quote("2026-10-02T10:00:00Z", 130000),
    ],
  });
  const group = trendGroups([row], [cohort([row])], search, now)[0];
  assert.ok(group);
  assert.equal(group.initial.length, 1);
  assert.equal(group.initial[0]?.price, 130000);
  assert.equal(group.initial[0]?.at, Date.parse("2026-10-01T10:00:00Z"));
  assert.deepEqual(
    group.history.map((point) => point.price),
    [130000, 100000],
  );
});

void test("finance, deposits, foreign currencies, recurring quotes and invalid dates stay out of a purchase chart", () => {
  const row = listing("cash", {
    price_history: [
      quote("2026-10-01T10:00:00Z", null),
      quote("2026-10-01T11:00:00Z", 30000, { price_period: "month" }),
      quote("2026-10-01T12:00:00Z", 100000, { currency: "USD" }),
      quote("invalid", 120000),
      quote("2026-10-05T10:00:00Z", 110000),
      quote("2026-10-02T10:00:00Z", 0),
      quote("2026-10-03T10:00:00Z", 120000),
    ],
  });
  const finance = listing("finance", { price_minor: 30000, price_kind: "finance" });
  const deposit = listing("deposit", { price_kind: "deposit" });
  const group = trendGroups(
    [row, finance, deposit],
    [cohort([row, finance, deposit])],
    search,
    now,
  )[0];
  assert.equal(group?.initial.length, 1);
  assert.equal(group?.unpricedCount, 2);
  assert.equal(group?.initial[0]?.at, Date.parse("2026-10-03T10:00:00Z"));
  assert.equal(
    trendGroups([row], [cohort([row], { price_period: "month" })], search, now).length,
    0,
  );
});

void test("platform-qualified IDs stay separate and only confirmed copies share a scatter dot", () => {
  const facebook = listing("1", {
    entity_key: "facebook_marketplace:1",
    observed_at: "2026-10-01T10:00:00Z",
    last_successful_at: "2026-10-01T10:00:00Z",
    price_history: [quote("2026-10-01T10:00:00Z", 130000)],
  });
  const ebay = listing("1", { key: "ebay:1", source: "ebay", price_minor: 90000 });
  let group = trendGroups([facebook, ebay], [cohort([facebook, ebay])], search, now)[0];
  assert.equal(group?.initial.length, 2);
  const confirmedCopy = { ...ebay, entity_key: facebook.key };
  group = trendGroups(
    [facebook, confirmedCopy],
    [cohort([facebook, confirmedCopy])],
    search,
    now,
  )[0];
  assert.equal(group?.initial.length, 1);
  assert.equal(group?.initial[0]?.price, 130000);
  assert.equal(group?.initial[0]?.listing.key, "ebay:1");
  assert.equal(new Set(group?.history.map((point) => point.series)).size, 2);
  const other = listing("2", { chip: "M4 Pro" });
  const groups = trendGroups([facebook, other], [cohort([facebook]), cohort([other])], search, now);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0]?.label, groups[1]?.label);
});

void test("status is explicit and failed or stale checks never appear confirmed active", () => {
  assert.equal(trendStatus(listing("1"), now), "active");
  assert.equal(trendStatus(listing("1", { availability: "sold" }), now), "unavailable");
  assert.equal(
    trendStatus(listing("1", { availability: "unknown_unavailable" }), now),
    "unavailable",
  );
  assert.equal(
    trendStatus(listing("1", { availability: "sold", check_outcome: "failed" }), now),
    "uncertain",
  );
  assert.equal(
    trendStatus(listing("1", { last_successful_at: "2026-09-30T10:00:00Z" }), now),
    "uncertain",
  );
  assert.equal(
    trendStatus(listing("1", { last_successful_at: null, observed_at: undefined }), now),
    "uncertain",
  );
});

void test("the maximum-price line stays in range, one-date charts scale, and overlapping points remain selectable", () => {
  const a = listing("1"),
    b = listing("2");
  const points = trendGroups([a, b], [cohort([a, b])], search, now)[0]?.initial ?? [];
  for (const width of [280, 720]) {
    const layout = trendLayout(points, 1200000, now, null, width);
    assert.ok(layout.y(1200000) >= layout.top && layout.y(1200000) <= layout.bottom);
    assert.ok(
      points.every(
        (point) => Number.isFinite(layout.x(point.at)) && Number.isFinite(layout.y(point.price)),
      ),
    );
    const clusters = clusterPoints(points, layout);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.points.length, 2);
  }
  const lower = trendLayout(points, 100, now, null, 280);
  assert.ok(lower.low <= 100 && lower.high > 110000);
  assert.equal(trendWindow(points, now, 7).length, 2);
  assert.equal(trendWindow(points, now + 8 * 86400000, 7).length, 0);
  assert.equal(trendWindow(points, now + 8 * 86400000, null).length, 2);
  assert.ok(Number.isFinite(trendLayout([], null, now, null, 280).y(0)));
});

void test("real server snapshots expose cohort keys and observation history usable by the panel", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-trends-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(folder, "sample");
  const state = stateSchema.parse(Effect.runSync(store.request("load_sample_workspace")).state);
  const saved = state.searches[0];
  assert.ok(saved);
  assert.ok(saved.market_history.length);
  assert.ok(
    saved.market_history.every((group) =>
      group.cohort_listing_keys.every((key) => state.listings.some((row) => row.key === key)),
    ),
  );
  assert.ok(saved.market_history.some((group) => group.cohort_listing_keys.length > 1));
  const groups = trendGroups(
    state.listings,
    saved.market_history,
    saved,
    Date.parse(state.generated_at),
  );
  assert.ok(groups.some((group) => group.initial.length > 1));
  assert.equal(targetPrice(saved), 125000);
});

void test("stored cross-platform IDs remain separate until a confirmed relationship merges them", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-trend-copies-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(folder, "sample");
  Effect.runSync(store.request("get_workspace"));
  const config = Effect.runSync(store.config());
  const db = Effect.runSync(connect(store.databasePath));
  t.after(() => db.close());
  const stamp = Date.now();
  const facebook = {
    ...sampleRows[0],
    listing_id: "123",
    url: "https://example.invalid/item/123",
    observed_at: new Date(stamp).toISOString(),
  };
  const ebay = { ...facebook, source: "ebay", price_minor: 130000 };
  Effect.runSync(
    evaluateObservations(config, [facebook, ebay], store.databasePath, true, stamp, null, db),
  );
  let state = stateSchema.parse(Effect.runSync(store.snapshot(db, config, stamp)));
  let saved = state.searches[0];
  assert.ok(saved);
  assert.equal(saved.market_history[0]?.cohort_listing_keys.length, 2);
  assert.equal(
    trendGroups(state.listings, saved.market_history, saved, stamp)[0]?.initial.length,
    2,
  );
  const copy = {
    ...ebay,
    observed_at: new Date(stamp + 1).toISOString(),
    relationships: [
      {
        source: "facebook_marketplace",
        listing_id: "123",
        kind: "cross_post_of",
        confidence: "confirmed",
        evidence: "Fixture confirms this is the same item",
      },
    ],
  };
  Effect.runSync(
    evaluateObservations(config, [copy], store.databasePath, true, stamp + 1, null, db),
  );
  state = stateSchema.parse(Effect.runSync(store.snapshot(db, config, stamp + 1)));
  saved = state.searches[0];
  assert.ok(saved);
  assert.equal(saved.market_history[0]?.distinct_count, 1);
  assert.equal(saved.market_history[0]?.cohort_listing_keys.length, 2);
  const group = trendGroups(state.listings, saved.market_history, saved, stamp + 1)[0];
  assert.equal(group?.initial.length, 1);
  assert.equal(new Set(group?.history.map((point) => point.series)).size, 2);
});
