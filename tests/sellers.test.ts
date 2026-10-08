import { seedWorkspace } from "./helpers/workspace.ts";
import { Effect } from "effect";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Listing } from "@goodfinds/contracts/state";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { normalize } from "./reference-server/src/listings/tracking.ts";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { SEARCH_TEMPLATES, validateAnswers } from "@goodfinds/contracts/search-definition";
import {
  joinedLabel,
  listingCountLabel,
  matchesListingCount,
  matchesJoinedYear,
  matchesSellerFilters,
  EMPTY_SELLER_FILTERS,
  sellerFilterError,
  sellerFilterChips,
  sellerFilterCount,
  normalizeListingLimit,
  sellerInventorySignal,
  withSellerListingField,
} from "../apps/ui/src/lib/seller.ts";

const now = Date.parse("2026-10-04T12:00:00Z");
const listing: Listing = {
  key: "sample",
  listing_id: "sample",
  title: "Fictional listing",
  url: "https://example.invalid/item/sample",
  product: "rental",
  price_minor: 100000,
  price_kind: "asking",
  seller_profile_url: "https://example.invalid/seller/sample",
  seller_listing_count: 5,
  seller_listing_count_precision: "exact",
  seller_listings_checked_at: "2026-10-04T11:00:00Z",
  evidence: { seller_listing_count: "5 current listings" },
  photos: [],
  videos: [],
  events: [],
  price_history: [],
};

const inventoryReview: NonNullable<Listing["seller_inventory_review"]> = {
  checked_at: "2026-10-04T11:00:00Z",
  source_url: "https://www.facebook.com/marketplace/profile/123/",
  category: "coffee_machine",
  category_label: "coffee machines",
  item_kind: "goods",
  evidence: "Fictional test: five current coffee machines on this seller profile.",
  listings: Array.from({ length: 5 }, (_, index) => ({
    listing_id: String(index + 1),
    url: `https://www.facebook.com/marketplace/item/${index + 1}/`,
    title: `Fictional coffee machine ${index + 1}`,
    availability: "active" as const,
    evidence: "Fictional test: this seller's available coffee-machine listing.",
  })),
};

const inventoryListing: Listing = {
  ...listing,
  product: "coffee_machine",
  source: "facebook_marketplace",
  listing_id: "1",
  url: "https://www.facebook.com/marketplace/item/1/",
  seller_profile_url: inventoryReview.source_url,
  seller_listing_count: 10,
  seller_inventory_review: inventoryReview,
};

void test("only inspected similar goods add a seller label; total volume is already shown by the count", () => {
  assert.equal(
    sellerInventorySignal({ ...inventoryListing, seller_inventory_review: null }, now)?.label,
    undefined,
  );
  assert.equal(sellerInventorySignal(inventoryListing, now)?.label, "Possible reseller");
  assert.equal(sellerInventorySignal(inventoryListing, now)?.listings.length, 5);
  for (const changes of [
    { category: "camera" },
    { item_kind: "rental" as const },
    { item_kind: "service" as const },
    { source_url: "https://www.facebook.com/marketplace/profile/999/" },
    { checked_at: "2026-09-03T12:00:00Z" },
    { checked_at: "2026-10-05T12:00:00Z" },
    { listings: inventoryReview.listings.slice(0, 4) },
    {
      listings: Array.from({ length: 5 }, () => inventoryReview.listings[0]).filter(
        (item) => item !== undefined,
      ),
    },
  ])
    assert.equal(
      sellerInventorySignal(
        { ...inventoryListing, seller_inventory_review: { ...inventoryReview, ...changes } },
        now,
      )?.label,
      undefined,
    );
  assert.equal(
    sellerInventorySignal(
      {
        ...inventoryListing,
        product: "rental",
        seller_inventory_review: { ...inventoryReview, category: "rental" },
      },
      now,
    )?.label,
    undefined,
  );
  assert.equal(
    sellerInventorySignal(
      { ...inventoryListing, seller_inventory_review: null, seller_listing_count: 9 },
      now,
    ),
    undefined,
  );
  assert.equal(
    sellerInventorySignal(
      { ...inventoryListing, seller_inventory_review: null, seller_listing_count: null },
      now,
    ),
    undefined,
  );
  assert.equal(
    sellerInventorySignal(
      {
        ...inventoryListing,
        seller_inventory_review: null,
        seller_listing_count_precision: "approximate",
      },
      now,
    ),
    undefined,
  );
});

void test("inventory inspection imports reject mismatched sources, duplicates and conflicting totals", () => {
  const input = { ...inventoryListing, provenance: "manual", observed_at: "2026-10-04T12:00:00Z" };
  assert.equal(
    Effect.runSync(normalize(input, false, now)).seller_inventory_review?.listings.length,
    5,
  );
  for (const changes of [
    { source_url: "https://www.facebook.com/marketplace/profile/999/" },
    { category: "camera" },
    { checked_at: "2026-10-04T12:00:01Z" },
    { listings: [...inventoryReview.listings, inventoryReview.listings[0]] },
    { listings: [{ ...inventoryReview.listings[0], url: "https://www.ebay.com/itm/1" }] },
    {
      listings: [
        { ...inventoryReview.listings[0], url: "https://www.facebook.com/marketplace/item/999/" },
      ],
    },
  ])
    assert.throws(() =>
      Effect.runSync(
        normalize(
          { ...input, seller_inventory_review: { ...inventoryReview, ...changes } },
          false,
          now,
        ),
      ),
    );
  assert.throws(() => Effect.runSync(normalize({ ...input, seller_listing_count: 4 }, false, now)));
});

void test("inspected inventory evidence survives the import and shared-state round trip", async (context) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-inventory-test-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  context.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const importListings = calls.get("import_goodfinds_listing_observations");
  const getState = calls.get("get_goodfinds_workspace");
  assert.ok(importListings && getState);
  const observed = new Date().toISOString();
  const imported = stateFromToolResult(
    await importListings({
      observations: [
        {
          ...inventoryListing,
          provenance: "manual",
          observed_at: observed,
          seller_listings_checked_at: observed,
          seller_inventory_review: { ...inventoryReview, checked_at: observed },
        },
      ],
    }),
  );
  assert.equal(imported.listings[0]?.seller_inventory_review?.listings.length, 5);
  const reread = stateFromToolResult(await getState({}));
  assert.deepEqual(
    reread.listings[0]?.seller_inventory_review,
    imported.listings[0]?.seller_inventory_review,
  );
  assert.equal(sellerInventorySignal(reread.listings[0] ?? listing)?.label, "Possible reseller");
});

void test("seller filters distinguish exact zero, unavailable counts and reported lower bounds", () => {
  assert.equal(matchesListingCount(listing, { min: 5, max: 5 }, now), true);
  assert.equal(matchesListingCount(listing, { max: 4 }, now), false);
  assert.equal(matchesListingCount({ ...listing, seller_listing_count: 0 }, { max: 0 }, now), true);
  assert.equal(listingCountLabel({ ...listing, seller_listing_count: 0 }), "0 listings");
  assert.equal(
    matchesListingCount({ ...listing, seller_listing_count: null }, { max: 0 }, now),
    undefined,
  );
  assert.equal(matchesListingCount({ ...listing, seller_listing_count: null }, {}, now), true);
  const partial = { ...listing, seller_listing_count_precision: "lower_bound" as const };
  assert.equal(matchesListingCount(partial, { min: 5 }, now), true);
  assert.equal(matchesListingCount(partial, { max: 5 }, now), undefined);
  assert.equal(matchesListingCount(partial, { max: 4 }, now), false);
  assert.equal(listingCountLabel(partial), "5+ listings");
});

void test("count limits require current sourced evidence and cannot treat rounded counts as exact", () => {
  for (const changes of [
    { seller_profile_url: null },
    { evidence: {} },
    { seller_listings_checked_at: null },
    { seller_listings_checked_at: "2026-09-03T12:00:00Z" },
    { seller_listings_checked_at: "2026-10-05T12:00:00Z" },
    { seller_listing_count_precision: "approximate" as const },
    { seller_listing_count_precision: null },
  ])
    assert.equal(matchesListingCount({ ...listing, ...changes }, { max: 10 }, now), undefined);
});

void test("profile copy preserves a year-only join date without inventing a date", () => {
  assert.equal(joinedLabel("2019"), "Joined Facebook in 2019");
  assert.equal(joinedLabel("2019-02-04"), "Joined Facebook 4 Feb 2019");
  assert.equal(joinedLabel(null), "Join date unavailable");
});

void test("joined-by years include the whole selected year without guessing an exact join date", () => {
  assert.equal(matchesJoinedYear("2019", "2020"), true);
  assert.equal(matchesJoinedYear("2020", "2020"), true);
  assert.equal(matchesJoinedYear("2020-12-31", "2020"), true);
  assert.equal(matchesJoinedYear("2021-01-01", "2020"), false);
  assert.equal(matchesJoinedYear("2021", "2020"), false);
  assert.equal(matchesJoinedYear("2019-02-30", "2020"), undefined);
  assert.equal(matchesJoinedYear(null, "2020"), undefined);
  assert.equal(matchesJoinedYear(null, ""), true);
});

void test("count and year filters keep unknown metadata distinct from confirmed values", () => {
  const filters = {
    ...EMPTY_SELLER_FILTERS,
    maximumListings: "10",
    joinedBy: "2020",
  };
  const seller = { ...listing, seller_account_joined_at: "2019", seller_has_profile_image: true };
  assert.equal(matchesSellerFilters(seller, filters, now), true);
  for (const seller_has_profile_image of [null, false]) {
    const checkedSeller = { ...seller, seller_has_profile_image };
    assert.equal(matchesSellerFilters(checkedSeller, filters, now), true);
  }
  assert.equal(
    matchesSellerFilters({ ...seller, seller_account_joined_at: null }, filters, now),
    false,
  );
  assert.equal(
    matchesSellerFilters({ ...seller, seller_listing_count: null }, filters, now),
    false,
  );
  assert.equal(
    matchesSellerFilters({ ...seller, seller_listing_count: null }, EMPTY_SELLER_FILTERS, now),
    true,
  );
  for (const changes of [
    { minimumListings: "1.5" },
    { minimumListings: "10", maximumListings: "5" },
    { joinedBy: "2020-12-31" },
    { joinedBy: "1899" },
    { joinedBy: "2027" },
  ])
    assert.ok(sellerFilterError({ ...EMPTY_SELLER_FILTERS, ...changes }, 2026));
});

void test("zero and negative listing limits reset to Any and do not exclude unknown sellers", () => {
  for (const value of ["", "0", "-1", "-20", "0.5"]) assert.equal(normalizeListingLimit(value), "");
  assert.equal(normalizeListingLimit("1"), "1");
  assert.equal(normalizeListingLimit("20"), "20");
  const filters = {
    ...EMPTY_SELLER_FILTERS,
    minimumListings: normalizeListingLimit("0"),
    maximumListings: normalizeListingLimit("-1"),
  };
  assert.equal(sellerFilterError(filters), "");
  assert.equal(
    matchesSellerFilters({ ...listing, seller_listing_count: null }, filters, now),
    true,
  );
  assert.ok(sellerFilterError({ ...filters, minimumListings: "1.5" }));
});

void test("applied chips keep each active filter independently removable", () => {
  const filters = {
    ...EMPTY_SELLER_FILTERS,
    minimumListings: "10",
    maximumListings: "50",
    joinedBy: "2020",
  };
  assert.equal(sellerFilterCount(filters), 3);
  assert.deepEqual(
    sellerFilterChips(filters).map((chip) => chip.label),
    ["10+ listings", "Up to 50 listings", "Joined by 2020"],
  );
  assert.deepEqual(
    sellerFilterChips({ ...filters, minimumListings: "" }).map((chip) => chip.field),
    ["maximumListings", "joinedBy"],
  );
  assert.deepEqual(sellerFilterChips(EMPTY_SELLER_FILTERS), []);
});

void test("existing custom searches gain an optional count range with an increased version", () => {
  const template = SEARCH_TEMPLATES[0];
  assert.ok(template);
  const old = {
    ...template,
    fields: template.fields.filter((field) => field.match?.attribute !== "seller_listing_count"),
  };
  const updated = withSellerListingField(old);
  assert.equal(updated.version, old.version + 1);
  assert.deepEqual(updated.fields.slice(0, -1), old.fields);
  assert.deepEqual(updated.comparison_attributes, old.comparison_attributes);
  assert.equal(withSellerListingField(updated), updated);
  for (const value of [{ min: 0 }, { max: 5 }, { min: 2, max: 5 }])
    assert.deepEqual(validateAnswers(updated, { seller_listing_count: value }, true), []);
  for (const value of [{ min: -1 }, { max: 1.5 }, { min: 5, max: 2 }])
    assert.ok(validateAnswers(updated, { seller_listing_count: value }, true).length > 0);
});
