import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_TEMPLATES, searchDefinitionSchema } from "@goodfinds/contracts/search-definition";
import { savedSearchSchema } from "@goodfinds/contracts/state";
import {
  searchBudget,
  searchLocation,
  searchRequirements,
  searchSummary,
} from "../apps/ui/src/lib/search-presentation.ts";

void test("compact laptop summaries keep the limits and leave complete requirements accessible", () => {
  const definition = SEARCH_TEMPLATES.find((item) => item.category === "macbook_pro");
  assert.ok(definition);
  const search = savedSearchSchema.parse({
    id: "laptop",
    name: "MacBook Pro",
    product: definition.category,
    definition,
    values: {
      min_chip_generation: 3,
      min_ram_gb: 32,
      min_ssd_gb: 1000,
      allowed_conditions: ["good"],
      max_price_minor: 120000,
      max_drive_minutes: 60,
      seller_listing_count: { max: 3 },
    },
  });
  assert.equal(searchSummary(search), "M3 or newer · 32 GB+ memory · 1 TB+");
  assert.equal(searchBudget(search), "£1,200");
  assert.deepEqual(searchLocation(search, "Birmingham"), {
    location: "Birmingham",
    distances: [{ label: "Up to 1 hour drive", kind: "drive" }],
  });
  assert.ok(searchRequirements(search).some((item) => item.value === "Up to 3 listings"));
  assert.ok(searchRequirements(search).some((item) => item.value === "Good"));
});

void test("rental rows follow conditional answers, location fields and weekly pricing", () => {
  const starter = SEARCH_TEMPLATES.find((item) => item.category === "rental");
  assert.ok(starter);
  const definition = searchDefinitionSchema.parse({
    ...starter,
    price: { currency: "GBP", period: "week" },
  });
  const search = savedSearchSchema.parse({
    id: "room",
    name: "Room to rent",
    product: definition.category,
    definition,
    values: {
      area: "Edinburgh",
      accommodation: "private_room",
      property_type: null,
      min_bedrooms: 4,
      floor: "ground",
      max_price_minor: 25000,
    },
  });
  assert.equal(searchSummary(search), "Private room · Ground floor");
  assert.deepEqual(searchLocation(search, "Birmingham"), { location: "Edinburgh", distances: [] });
  assert.ok(!searchRequirements(search).some((item) => item.id === "min_bedrooms"));
  assert.ok(
    searchRequirements(search).some(
      (item) => item.id === "property_type" && item.value === "No preference",
    ),
  );
  assert.ok(searchRequirements(search).some((item) => item.value === "£250 per week"));
});

void test("new categories retain false and zero preferences without a category-specific layout", () => {
  const definition = searchDefinitionSchema.parse({
    schema_version: 1,
    version: 1,
    category: "bicycle",
    title: "Bicycle",
    description: "",
    price: { currency: "GBP", period: "once" },
    comparison_attributes: ["frame_size"],
    fields: [
      { id: "district", label: "District", type: "location" },
      {
        id: "frame",
        label: "Frame size",
        type: "integer",
        unit: "cm",
        match: { attribute: "frame_size", operator: "eq" },
      },
      { id: "electric", label: "Electric", type: "boolean" },
      { id: "owners", label: "Previous owners", type: "integer" },
      { id: "colour", label: "Colour", type: "text" },
      {
        id: "seller",
        label: "Seller listings",
        type: "range",
        match: { attribute: "seller_listing_count", operator: "range" },
      },
    ],
  });
  const search = savedSearchSchema.parse({
    id: "bike",
    name: "Commuter bike",
    product: "bicycle",
    definition,
    values: {
      district: "Cambridge",
      frame: 54,
      electric: false,
      owners: 0,
      colour: null,
      seller: {},
    },
  });
  assert.equal(searchSummary(search), "54 cm frame size · Electric: No · 0 previous owners");
  assert.deepEqual(searchLocation(search, "Birmingham"), { location: "Cambridge", distances: [] });
  assert.equal(searchBudget(search), "No price limit");
  assert.ok(
    searchRequirements(search).some(
      (item) => item.id === "seller" && item.value === "No preference",
    ),
  );
  assert.equal(searchSummary({ ...search, values: { colour: null, seller: {} } }), "Bicycle");
});

void test("rental distance limits follow their saved units and visibility without becoming product specifications", () => {
  const starter = SEARCH_TEMPLATES.find((item) => item.category === "rental");
  assert.ok(starter);
  const definition = searchDefinitionSchema.parse({
    ...starter,
    fields: [
      ...starter.fields,
      {
        id: "search_radius",
        label: "Search radius",
        type: "number",
        unit: "km",
        match: { attribute: "distance_km", operator: "lte" },
        visible_when: { field: "accommodation", one_of: ["whole_property"] },
      },
    ],
  });
  const search = savedSearchSchema.parse({
    id: "home",
    name: "Home to rent",
    product: "rental",
    definition,
    values: {
      area: "Sydney, Australia",
      accommodation: "whole_property",
      min_bedrooms: 2,
      max_price_minor: 240000,
      search_radius: 15,
    },
  });
  assert.deepEqual(searchLocation(search, "Birmingham"), {
    location: "Sydney, Australia",
    distances: [{ label: "Within 15 km", kind: "radius" }],
  });
  assert.ok(!searchSummary(search).includes("15"));
  assert.deepEqual(
    searchLocation(
      { ...search, values: { ...search.values, accommodation: "private_room" } },
      "Birmingham",
    ),
    {
      location: "Sydney, Australia",
      distances: [],
    },
  );
  assert.deepEqual(
    searchLocation({ ...search, values: { ...search.values, search_radius: null } }, "Birmingham"),
    {
      location: "Sydney, Australia",
      distances: [],
    },
  );
});
