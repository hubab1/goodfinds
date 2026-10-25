import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_TEMPLATES, savedSearchSchema } from "@goodfinds/contracts/search-definition";
import { listingObservationSchema, searchCohort } from "./helpers/native-domain.ts";

const search = savedSearchSchema.parse({
  id: "juke-comparison",
  name: "Nissan Juke",
  product: "vehicle",
  definition: {
    schema_version: 1,
    version: 1,
    category: "vehicle",
    title: "Nissan Juke",
    description: "Automatic vehicle comparison",
    price: { currency: "GBP", period: "once" },
    comparison_attributes: ["make", "model", "year", "transmission", "fuel_type", "mileage"],
    fields: [{ id: "make", label: "Make", type: "text" }],
  },
  values: { make: "Nissan" },
});

function vehicle(mileage: number, mileage_unit: string | null = "miles") {
  return listingObservationSchema.parse({
    key: "manual:123456789",
    source: "facebook_marketplace",
    provenance: "manual",
    listing_id: "123456789",
    url: "https://www.facebook.com/marketplace/item/123456789/",
    title: "2017 Nissan Juke automatic",
    product: "vehicle",
    observed_at: "2026-10-18T14:00:00.000Z",
    price_minor: 500000,
    price_kind: "asking",
    attributes: {
      make: "Nissan",
      model: "Juke",
      year: 2017,
      transmission: "automatic",
      fuel_type: "petrol",
      mileage,
      mileage_unit,
    },
  });
}

void test("vehicle setup supplies typed identity, gearbox, history, price and journey fields", () => {
  const template = SEARCH_TEMPLATES.find((item) => item.category === "vehicle");
  assert.ok(template, "vehicle requests need a supported starter instead of ad hoc definitions");
  const attributes = new Set(template.fields.map((field) => field.match?.attribute));
  for (const attribute of [
    "make",
    "model",
    "year",
    "transmission",
    "clean_history",
    "fully_functioning",
    "price_minor",
    "drive_minutes",
  ])
    assert.ok(attributes.has(attribute), `${attribute} must be a typed matching field`);
  assert.ok(template.comparison_attributes.includes("mileage"));
});

void test("vehicle price peers use mileage bands instead of identical odometer readings", () => {
  assert.equal(searchCohort(vehicle(51000), search), searchCohort(vehicle(54091), search));
  assert.notEqual(searchCohort(vehicle(51000), search), searchCohort(vehicle(142947), search));
});

void test("vehicle comparison normalizes explicit distance units and holds unknown units", () => {
  assert.equal(searchCohort(vehicle(51000), search), searchCohort(vehicle(82076, "km"), search));
  assert.equal(searchCohort(vehicle(51000, null), search), null);
  assert.equal(searchCohort(vehicle(51000, "unknown"), search), null);
});

void test("mileage bands do not merge different vehicle models or transmissions", () => {
  const original = vehicle(51000);
  const other = { ...original, attributes: { ...original.attributes, model: "Qashqai" } };
  const manual = { ...original, attributes: { ...original.attributes, transmission: "manual" } };
  assert.notEqual(searchCohort(original, search), searchCohort(other, search));
  assert.notEqual(searchCohort(original, search), searchCohort(manual, search));
});
