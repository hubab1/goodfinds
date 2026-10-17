import test from "node:test";
import assert from "node:assert/strict";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import type { Listing } from "@goodfinds/contracts/state";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { seedWorkspace } from "./helpers/workspace.ts";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
import { listingAvailabilityLabel } from "../apps/ui/src/lib/listing-presentation.ts";
import { availabilityIdentities } from "./helpers/availability-fixtures.ts";

void test("sold Vinted listings cannot remain promising or good deals after an availability update", () => {
  const listing: Listing = {
    key: "vinted:12345",
    listing_id: "12345",
    source: "vinted",
    product: "clothing",
    title: "Jacket",
    url: "https://www.vinted.co.uk/items/12345-jacket",
    price_minor: 4000,
    availability: "sold",
    photos: [],
    videos: [],
    events: [],
    price_history: [],
  };
  const state = {
    listings: [listing],
    searches: [{ id: "jackets", product: "clothing" }],
    config: { feedback: [] },
    decisions: [
      {
        search_id: "jackets",
        status: "qualifies" as const,
        suitability: "suitable" as const,
        listing,
      },
    ],
  };
  for (const result_type of ["promising", "good_deals"] as const)
    assert.equal(
      selectListings(state, { sellerFilters: EMPTY_SELLER_FILTERS, result_type }).length,
      0,
    );
});

void test("availability-only checks preserve evidence and history through sold, failed checks and reopening", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-availability-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(folder));
  const initial = Effect.runSync(store.request("get_workspace")).state;
  const search = initial.searches[0];
  assert.ok(search);
  const identity = {
    source: "vinted",
    provenance: "manual",
    listing_id: "12345",
    url: "https://www.vinted.co.uk/items/12345-jacket",
    product: search.product,
  };
  const original = {
    ...identity,
    observed_at: "2026-10-01T10:00:00Z",
    title: "Saved Vinted item",
    description: "Original seller description",
    availability: "active",
    price_minor: 4000,
    currency: "GBP",
    price_kind: "asking",
    collection_stage: "verification",
    attributes: { brand: "Example" },
    evidence: { brand: "Example brand" },
  };
  const first = Effect.runSync(
    store.request("import_listing_observations", { observations: [original] }),
  ).state.listings[0];
  assert.ok(first);
  const check = (availability: string, observed_at: string, check_outcome = "success") =>
    Effect.runSync(
      store.request("import_listing_observations", {
        observations: [
          {
            ...identity,
            collection_stage: "availability",
            observed_at,
            availability,
            availability_text: availability === "sold" ? "Sold" : "Buy now",
            check_outcome,
          },
        ],
      }),
    ).state;
  const soldState = check("sold", "2026-10-02T10:00:00Z");
  const sold = soldState.listings[0];
  assert.ok(sold);
  for (const key of [
    "title",
    "description",
    "price_minor",
    "currency",
    "attributes",
    "collection_stage",
    "first_observed_at",
    "observed_at",
    "last_successful_at",
    "price_history",
  ] as const)
    assert.deepEqual(sold[key], first[key], `Availability check must preserve ${key}`);
  assert.equal(sold.availability, "sold");
  assert.equal(sold.availability_checked_at, "2026-10-02T10:00:00.000Z");
  assert.ok(
    sold.events?.some((event) => event["kind"] === "status_changed" && event["state"] === "sold"),
  );
  assert.equal(Effect.runSync(store.query("list_listings", { availability: "current" })).total, 0);
  assert.equal(
    Effect.runSync(store.query("list_listings", { availability: "unavailable" })).total,
    1,
  );
  assert.equal(
    Effect.runSync(
      store.query("list_listings", { availability_check_before: "2026-10-03T10:00:00Z" }),
    ).total,
    0,
  );
  const failed = check("active", "2026-10-03T10:00:00Z", "network_error").listings[0];
  assert.ok(failed);
  assert.equal(failed.availability, "sold");
  assert.equal(listingAvailabilityLabel(failed), "Sold");
  const reopened = check("active", "2026-10-04T10:00:00Z").listings[0];
  assert.ok(reopened);
  assert.equal(reopened.availability, "active");
  assert.equal(reopened.price_history.length, first.price_history.length);
  assert.equal(
    Effect.runSync(
      store.query("list_listings", { availability_check_before: "2026-10-04T10:00:00Z" }),
    ).total,
    0,
  );
  assert.equal(
    Effect.runSync(
      store.query("list_listings", { availability_check_before: "2026-10-05T10:00:00Z" }),
    ).total,
    1,
  );
  assert.equal(
    Effect.runSync(new NativeWorkspace(folder).request("get_workspace")).state.listings[0]
      ?.availability,
    "active",
  );
  assert.throws(
    () =>
      Effect.runSync(
        store.request("import_listing_observations", {
          observations: [
            {
              ...identity,
              listing_id: "99999",
              url: "https://www.vinted.co.uk/items/99999-missing",
              collection_stage: "availability",
              observed_at: "2026-10-04T10:00:00Z",
              availability: "sold",
              availability_text: "Sold",
            },
          ],
        }),
      ),
    /previously saved listing/,
  );
  assert.throws(
    () =>
      Effect.runSync(
        store.request("import_listing_observations", {
          observations: [
            {
              ...identity,
              collection_stage: "availability",
              observed_at: "2026-10-04T10:00:00Z",
              availability: "sold",
            },
          ],
        }),
      ),
    /availability_text/,
  );
});

void test("availability filtering rechecks temporary unavailability and keeps failures uncertain", () => {
  const base = {
    key: "item",
    product: "clothing",
    price_minor: 1000,
    observed_at: "2026-10-01T10:00:00Z",
  };
  const listings = [
    "active",
    "reserved",
    "unknown",
    "sold",
    "removed",
    "expired",
    "out_of_stock",
    "ended_unsold",
    "unknown_unavailable",
  ].map((availability) => Object.assign({}, base, { key: availability, availability }));
  const state = { listings, searches: [], config: { feedback: [] }, decisions: [] };
  assert.deepEqual(
    selectListings(state, {
      sellerFilters: EMPTY_SELLER_FILTERS,
      availability_check_before: "2026-10-02T10:00:00Z",
    })
      .map((row) => row.key)
      .toSorted((a, b) => a.localeCompare(b)),
    ["active", "out_of_stock", "reserved", "unknown", "unknown_unavailable"],
  );
  assert.deepEqual(
    selectListings(state, { sellerFilters: EMPTY_SELLER_FILTERS, availability: "current" })
      .map((row) => row.key)
      .toSorted((a, b) => a.localeCompare(b)),
    ["active", "unknown"],
  );
  assert.equal(
    listingAvailabilityLabel({ availability: "active", check_outcome: "not_found" }),
    "Check availability",
  );
});

void test("every marketplace retains sold history, reopens and rechecks temporary unavailability", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-marketplace-availability-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(folder));
  const search = Effect.runSync(store.request("get_workspace")).state.searches[0];
  assert.ok(search);
  const identities = availabilityIdentities(search.product);
  const saved = Effect.runSync(
    store.request("import_listing_observations", {
      observations: identities.map((identity) =>
        Object.assign({}, identity, {
          title: `${identity.source} fixture`,
          description: "Original seller description",
          observed_at: "2026-10-01T10:00:00Z",
          availability: "active",
          price_minor: 4000,
          currency: "GBP",
          price_kind: "asking",
        }),
      ),
    }),
  ).state;
  const check = (availability: string, observed_at: string, check_outcome = "success") =>
    Effect.runSync(
      store.request("import_listing_observations", {
        observations: identities.map((identity) =>
          Object.assign({}, identity, {
            collection_stage: "availability",
            observed_at,
            availability,
            availability_text: `Fixture status: ${availability}`,
            check_outcome,
          }),
        ),
      }),
    ).state;
  const count = (args: Record<string, unknown>) =>
    Effect.runSync(store.query("list_listings", args)).total;
  const before = "2026-10-09T10:00:00Z";
  const sold = check("sold", "2026-10-02T10:00:00Z");
  assert.equal(sold.listings.length, identities.length);
  for (const listing of sold.listings) {
    const original = saved.listings.find((row) => row.key === listing.key);
    assert.ok(original, listing.key);
    assert.equal(listingAvailabilityLabel(listing), "Sold", listing.key);
    assert.deepEqual(listing.price_history, original.price_history, listing.key);
    assert.equal(listing.description, original.description, listing.key);
    assert.equal(listing.observed_at, original.observed_at, listing.key);
    assert.equal(listing.availability_checked_at, "2026-10-02T10:00:00.000Z");
  }
  assert.equal(count({ availability: "current" }), 0);
  assert.equal(count({ availability: "unavailable" }), identities.length);
  assert.equal(count({ availability_check_before: before }), 0);
  const restored = check("active", "2026-10-03T10:00:00Z");
  assert.ok(restored.listings.every((listing) => listing.availability === "active"));
  assert.equal(count({ availability: "current" }), identities.length);
  const failed = check("sold", "2026-10-04T10:00:00Z", "not_found");
  for (const listing of failed.listings) {
    assert.equal(listing.availability, "active", listing.key);
    assert.equal(listingAvailabilityLabel(listing), "Check availability", listing.key);
  }
  for (const [index, availability] of [
    "reserved",
    "out_of_stock",
    "unknown_unavailable",
  ].entries()) {
    const observed_at = `2026-10-0${index + 5}T10:00:00Z`;
    const state = check(availability, observed_at);
    assert.equal(count({ availability: "current" }), 0);
    assert.equal(count({ availability: "unavailable" }), identities.length);
    assert.equal(count({ availability_check_before: observed_at }), 0);
    assert.equal(count({ availability_check_before: before }), identities.length);
    assert.equal(
      selectListings(state, {
        sellerFilters: EMPTY_SELLER_FILTERS,
        availability_check_before: before,
      }).length,
      identities.length,
    );
  }
  assert.equal(check("active", "2026-10-08T10:00:00Z").listings.length, identities.length);
  assert.equal(count({ availability: "unavailable" }), 0);
});
