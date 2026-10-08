import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { savedSearchSchema } from "@goodfinds/contracts/state";
import type { Decision } from "@goodfinds/contracts/state";
import {
  friendlyDecisionReasons,
  listingDetailFacts,
} from "../apps/ui/src/lib/listing-presentation.ts";
import { photoBackdropLayout } from "../apps/ui/src/lib/photo-background.ts";

void test("photo fills select the edges bordering the actual unused space", () => {
  assert.deepEqual(photoBackdropLayout(900, 1600, 220, 220), {
    axis: "sides",
    gap: 48.125,
  });
  assert.deepEqual(photoBackdropLayout(1600, 900, 220, 220), {
    axis: "top-bottom",
    gap: 48.125,
  });
  assert.deepEqual(photoBackdropLayout(800, 600, 400, 300), { axis: "none", gap: 0 });
  assert.deepEqual(photoBackdropLayout(960, 720, 299, 224.25), { axis: "none", gap: 0 });
  assert.deepEqual(photoBackdropLayout(960, 720, 299, 224), { axis: "none", gap: 0 });
  assert.deepEqual(photoBackdropLayout(800, 600, 220, 220), { axis: "top-bottom", gap: 27.5 });
  assert.deepEqual(photoBackdropLayout(0, 900, 220, 220), { axis: "none", gap: 0 });
  assert.deepEqual(photoBackdropLayout(900, 1600, 0, 220), { axis: "none", gap: 0 });
  assert.deepEqual(photoBackdropLayout(NaN, 1600, 220, 220), { axis: "none", gap: 0 });
});

const definition = SEARCH_TEMPLATES.find((item) => item.category === "mac_mini");
assert.ok(definition);
const search = savedSearchSchema.parse({
  id: "mini",
  name: "Mac mini",
  product: "mac_mini",
  definition,
  values: { min_ram_gb: 32, max_drive_minutes: 60 },
});
const decision: Decision = {
  listing: {
    key: "mini",
    listing_id: "mini",
    product: "mac_mini",
    title: "Mac mini",
    url: "https://example.invalid/item/mini",
    price_minor: null,
    ram_gb: 16,
    photos: [],
    videos: [],
    events: [],
    price_history: [],
  },
  status: "not_matching",
  search_id: "mini",
  search_name: "Mac mini",
  reasons: [
    "Minimum memory does not meet your requirement",
    "Maximum drive needs verification",
    "Driving time from the configured origin is unknown",
    "Journey check time is unknown",
    "Journey source is unknown",
  ],
};

void test("listing copy explains the actual mismatch and merges missing journey evidence", () => {
  assert.deepEqual(friendlyDecisionReasons(decision, search), [
    "16 GB memory; you asked for at least 32 GB",
    "Journey time hasn’t been checked",
  ]);
  assert.equal(decision.reasons.length, 5);
  assert.deepEqual(
    friendlyDecisionReasons(
      {
        ...decision,
        listing: { ...decision.listing, drive_minutes: 45 },
        reasons: ["Journey estimate needs a fresh check", "Journey source is unknown"],
      },
      search,
    ),
    ["Journey time needs updating"],
  );
});

void test("copy preserves unfamiliar reasons and avoids inventing a requirement without a search", () => {
  assert.deepEqual(
    friendlyDecisionReasons({
      ...decision,
      reasons: [
        "Minimum memory does not meet your requirement",
        "A custom category check",
        "Full asking price needs verification",
      ],
    }),
    [
      "Minimum memory does not meet your requirement",
      "A custom category check",
      "Price not confirmed",
    ],
  );
});

void test("detail facts use observed values and category units without inventing missing specifications", () => {
  const computer = listingDetailFacts(
    { ...decision.listing, chip: "M4", ssd_gb: 512, availability: "active" },
    search,
  );
  assert.deepEqual(computer.slice(0, 3), [
    { label: "Chip", value: "M4" },
    { label: "Memory", value: "16 GB" },
    { label: "Storage", value: "512 GB" },
  ]);
  assert.ok(computer.some((fact) => fact.label === "Availability" && fact.value === "Available"));
  const rental = listingDetailFacts({
    ...decision.listing,
    product: "rental",
    attributes: { bedrooms: 0, property_type: "flat", accommodation: "whole_property" },
    availability: "unknown",
  });
  assert.ok(rental.some((fact) => fact.label === "Bedrooms" && fact.value === "0"));
  assert.ok(
    rental.some((fact) => fact.label === "Accommodation" && fact.value === "Whole property"),
  );
  assert.equal(
    rental.some((fact) => fact.label === "Memory"),
    false,
  );
  const generic = listingDetailFacts(
    { ...decision.listing, product: "custom", attributes: { capacity: 125, supported: false } },
    {
      ...search,
      definition: {
        ...search.definition,
        comparison_attributes: ["capacity", "supported"],
        fields: [
          {
            id: "capacity",
            label: "Minimum capacity",
            type: "integer",
            required: true,
            unit: "litres",
            display_divisor: 100,
            match: { attribute: "capacity", operator: "gte", importance: "required" },
          },
        ],
      },
    },
  );
  assert.ok(generic.some((fact) => fact.label === "Capacity" && fact.value === "1.25 litres"));
  assert.ok(generic.some((fact) => fact.label === "Supported" && fact.value === "No"));
});
