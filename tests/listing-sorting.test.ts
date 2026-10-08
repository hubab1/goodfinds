import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SELLER_FILTERS,
  listingQuerySchema,
  selectListings,
} from "@goodfinds/contracts/listing-query";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";
import type { Listing } from "@goodfinds/contracts/state";

const listings = [
  {
    key: "older",
    product: "laptop",
    price_minor: 30000,
    currency: "GBP",
    first_observed_at: "2026-10-01T10:00:00Z",
    observed_at: "2026-10-07T10:00:00Z",
    last_observed_at: "2026-10-07T10:00:00Z",
  },
  {
    key: "newer",
    product: "laptop",
    price_minor: 10000,
    currency: "GBP",
    first_observed_at: "2026-10-05T10:00:00Z",
    observed_at: "2026-10-05T10:00:00Z",
  },
  {
    key: "free",
    product: "laptop",
    price_minor: 0,
    currency: "GBP",
    observed_at: "2026-10-03T10:00:00Z",
  },
  { key: "unknown-a", product: "laptop", price_minor: null },
  { key: "unknown-b", product: "laptop", price_minor: null, first_observed_at: "unknown" },
];
const state = { listings, searches: [], config: { feedback: [] }, decisions: [] };
const keys = (sort: ListingQuery["sort"]) =>
  selectListings(state, { sellerFilters: EMPTY_SELLER_FILTERS, sort }).map((item) => item.key);

void test("date found keeps original discovery order after rechecks, with unknown dates last", () => {
  assert.deepEqual(keys("found_newest"), ["newer", "free", "older", "unknown-a", "unknown-b"]);
  assert.deepEqual(keys("found_oldest"), ["older", "free", "newer", "unknown-a", "unknown-b"]);
  assert.equal(keys("recent")[0], "older");
  assert.equal(state.listings[0]?.key, "older", "Sorting must not mutate the saved collection");
  assert.equal(listingQuerySchema.parse({ sort: "found_newest" }).sort, "found_newest");
  assert.equal(listingQuerySchema.parse({ sort: "found_oldest" }).sort, "found_oldest");
});

void test("price sorting handles free listings and puts unknown amounts last in both directions", () => {
  assert.deepEqual(keys("price_low"), ["free", "newer", "older", "unknown-a", "unknown-b"]);
  assert.deepEqual(keys("price_high"), ["older", "newer", "free", "unknown-a", "unknown-b"]);
});

void test("price sorting keeps different currencies and rental periods in separate groups", () => {
  const rows: Pick<Listing, "key" | "product" | "price_minor" | "currency" | "price_period">[] = [
    {
      key: "monthly-high",
      product: "rental",
      price_minor: 10000,
      currency: "GBP",
      price_period: "month",
    },
    { key: "weekly", product: "rental", price_minor: 100, currency: "GBP", price_period: "week" },
    { key: "usd", product: "rental", price_minor: 10, currency: "USD", price_period: "month" },
    {
      key: "monthly-low",
      product: "rental",
      price_minor: 5000,
      currency: "GBP",
      price_period: "month",
    },
  ];
  for (const sort of ["price_low", "price_high"] as const) {
    assert.deepEqual(
      selectListings(
        { ...state, listings: rows },
        { sellerFilters: EMPTY_SELLER_FILTERS, sort },
      ).map((item) => item.key),
      sort === "price_low"
        ? ["monthly-low", "monthly-high", "weekly", "usd"]
        : ["monthly-high", "monthly-low", "weekly", "usd"],
    );
  }
});
