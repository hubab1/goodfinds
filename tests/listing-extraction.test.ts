import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";

const start = Date.now() - 60000;
function observation(extra: Record<string, unknown> = {}) {
  return {
    listing_id: "123456789012345",
    url: "https://www.facebook.com/marketplace/item/123456789012345/",
    source: "facebook_marketplace",
    provenance: "manual",
    collection_method: "user_requested_browser",
    collection_stage: "discovery",
    product: "macbook_pro",
    title: "MacBook Pro 2025 M5",
    price_minor: 125000,
    price_kind: "asking",
    currency: "GBP",
    observed_at: new Date(start).toISOString(),
    availability: "active",
    ...extra,
  };
}

void test("a detail import without price basis cannot erase a saved asking price", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-extraction-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const save = (row: Record<string, unknown>) =>
    Effect.runSync(store.request("import_listing_observations", { observations: [row] })).state;
  const before = save(observation());
  const detail = observation({
    price_kind: undefined,
    description: "M5, 1 TB SSD",
    observed_at: new Date(start + 1000).toISOString(),
  });
  assert.throws(() => save(detail), /price_kind/);
  const after = Effect.runSync(store.request("get_workspace")).state;
  assert.equal(after.revision, before.revision);
  assert.equal(after.listings[0]?.price_minor, 125000);
  assert.equal(save({ ...detail, price_kind: "asking" }).listings[0]?.price_minor, 125000);
});

void test("partial detail enrichment saves seller, location and condition without erasing a gallery", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-enrichment-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const save = (row: Record<string, unknown>) =>
    Effect.runSync(store.request("import_listing_observations", { observations: [row] })).state;
  const photos = [{ media_id: "a".repeat(64), position: 1, caption: "Saved original" }];
  save(observation({ photos, seller_name: "Old name", evidence: { seller_name: "Old source" } }));
  const profile = "https://www.facebook.com/marketplace/profile/123456789/";
  const checked = new Date(start + 1000).toISOString();
  const enriched = save(
    observation({
      observed_at: checked,
      description: "Works correctly. Collection from Birmingham",
      location: "Birmingham",
      seller_name: "Observed seller",
      seller_profile_url: profile,
      seller_account_joined_at: "2010",
      seller_metadata_checked_at: checked,
      seller_listing_count: 2,
      seller_listing_count_precision: "exact",
      seller_listing_count_text: "2 listings",
      seller_listings_checked_at: checked,
      condition: "good",
      functional: true,
      publication: { raw_text: "Listed 3 hours ago", precision: "approximate", kind: "published" },
      evidence: {
        location: "Birmingham",
        functional: "Works correctly",
        seller_listing_count: "2 listings",
      },
    }),
  ).listings[0];
  assert.ok(enriched);
  assert.equal(enriched.seller_name, "Observed seller");
  assert.equal(enriched.location, "Birmingham");
  assert.equal(enriched.seller_profile_url, profile);
  assert.equal(enriched.seller_account_joined_at, "2010");
  assert.equal(enriched.seller_metadata_checked_at, checked);
  assert.equal(enriched.seller_listing_count, 2);
  assert.equal(enriched.condition, "good");
  assert.equal(enriched.functional, true);
  assert.equal(enriched.evidence?.["seller_name"], undefined);
  assert.deepEqual(enriched.photos, photos);
  const later = save(observation({ observed_at: new Date(start + 2000).toISOString() }))
    .listings[0];
  assert.equal(later?.seller_name, "Observed seller");
  assert.equal(later?.location, "Birmingham");
  assert.deepEqual(later?.photos, photos);
  const refreshed = save(
    observation({
      observed_at: new Date(start + 3000).toISOString(),
      publication: { raw_text: "Listed 21 hours ago", precision: "approximate", kind: "published" },
    }),
  ).listings[0];
  assert.equal(refreshed?.publication?.raw_text, "Listed 21 hours ago");
  const published = new Date(start - 86400000).toISOString();
  save(
    observation({
      observed_at: new Date(start + 4000).toISOString(),
      publication: {
        raw_text: "Original publication date",
        precision: "exact",
        kind: "published",
        earliest_at: published,
        latest_at: published,
        evidence: "Explicit original date",
      },
    }),
  );
  const bounded = save(
    observation({
      observed_at: new Date(start + 5000).toISOString(),
      publication: { raw_text: "Listed 2 days ago", precision: "approximate", kind: "published" },
    }),
  ).listings[0];
  assert.equal(bounded?.publication?.earliest_at, published);
  assert.equal(bounded?.publication?.latest_at, published);
});
