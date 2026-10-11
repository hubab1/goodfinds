import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SELLER_FILTERS,
  listingQuerySchema,
  selectListings,
  shortlistEvents,
} from "@goodfinds/contracts/listing-query";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";

const searches = [
  { id: "first", product: "laptop" },
  { id: "second", product: "laptop" },
  { id: "other", product: "camera" },
];
const listings = [
  { key: "saved", product: "laptop", price_minor: 20000 },
  { key: "second-saved", product: "laptop", price_minor: 10000 },
  { key: "ordinary", product: "laptop", price_minor: 5000 },
  { key: "undone", product: "laptop", price_minor: 0 },
];
const event = (search_id: string, listing_key: string, action: FeedbackEvent["action"]) => ({
  id: `${search_id}:${listing_key}:${action}`,
  search_id,
  listing_key,
  action,
  scope: "search" as const,
  category: "laptop",
  created_at: "2026-10-11T10:00:00Z",
  undone: false,
});
const feedback: FeedbackEvent[] = [
  event("first", "saved", "shortlist"),
  event("first", "saved", "more_like"),
  event("second", "second-saved", "shortlist"),
  { ...event("first", "undone", "shortlist"), undone: true },
];
const state = { listings, searches, config: { feedback }, decisions: [] };
const [savedListing, secondListing] = listings;
const [, secondSearch, otherSearch] = searches;
assert.ok(savedListing && secondListing && secondSearch && otherSearch);

void test("shortlisted results respect search scope, Undo and independent Find similar feedback", () => {
  const options = { sellerFilters: EMPTY_SELLER_FILTERS, shortlisted: true };
  assert.deepEqual(
    selectListings(state, options).map((listing) => listing.key),
    ["saved", "second-saved"],
  );
  assert.deepEqual(
    selectListings(state, { ...options, search_id: "first" }).map((listing) => listing.key),
    ["saved"],
  );
  assert.deepEqual(
    selectListings(state, { ...options, search_id: "second" }).map((listing) => listing.key),
    ["second-saved"],
  );
  assert.deepEqual(
    selectListings(state, { ...options, sort: "price_low" }).map((listing) => listing.key),
    ["second-saved", "saved"],
  );
  assert.equal(shortlistEvents(savedListing, searches, feedback).length, 1);
  assert.equal(listingQuerySchema.parse({ shortlisted: true }).shortlisted, true);
  assert.equal(listingQuerySchema.parse({}).shortlisted, false);
});

void test("category/global bookmarks apply only to matching listings and active search scopes", () => {
  for (const scope of ["category", "global"] as const) {
    const bookmark = { ...event("first", "saved", "shortlist"), scope };
    assert.equal(shortlistEvents(savedListing, [secondSearch], [bookmark]).length, 1);
    assert.equal(shortlistEvents(savedListing, [otherSearch], [bookmark]).length, 0);
    assert.equal(shortlistEvents(secondListing, searches, [bookmark]).length, 0);
  }
});
