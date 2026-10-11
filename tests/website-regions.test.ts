import assert from "node:assert/strict";
import test from "node:test";
import { exampleCountry } from "../website/locale.js";
import { exampleCurrency } from "../website/currency.js";
import { marketplaceExamples, marketplaceRegions } from "../website/marketplace-examples.js";
import { resolveRegion } from "@goodfinds/contracts/regional";
import { marketHome, marketplaceSchema } from "@goodfinds/contracts/integrations";

void test("website examples follow country hints and explicit choices without guessing from language", () => {
  assert.equal(exampleCountry(["en"]), null);
  assert.equal(exampleCountry(["bad locale", "fr", "en-US"]), "US");
  assert.equal(exampleCountry(["en-GB"], "US"), "US");
  assert.equal(exampleCountry(["en-US"], "GB"), "GB");
  assert.equal(exampleCountry(["en-US"], "other"), null);
  assert.equal(exampleCountry(["en-u-rg-gbzzzz"]), null);
  assert.deepEqual(
    marketplaceExamples("US").map((m) => m.marketplace),
    ["facebook_marketplace", "ebay", "poshmark", "craigslist", "cargurus", "mercari"],
  );
  assert.deepEqual(
    marketplaceExamples("GB").map((m) => m.marketplace),
    ["facebook_marketplace", "ebay", "vinted", "gumtree", "autotrader"],
  );
  assert.deepEqual(
    marketplaceExamples("DE").map((m) => m.marketplace),
    ["facebook_marketplace", "ebay", "vinted"],
  );
  assert.deepEqual(
    marketplaceExamples(null).map((m) => m.marketplace),
    ["generic"],
  );
  assert.equal(exampleCurrency(["en-GB"], "US").currency, "USD");
  assert.equal(exampleCurrency(["en-US"], "GB").currency, "GBP");
});

void test("every website marketplace and vehicle priority agrees with the plugin registry", () => {
  for (const [country, region] of Object.entries(marketplaceRegions)) {
    for (const market of region.marketplaces) {
      assert.equal(market.url, marketHome(marketplaceSchema.parse(market.id), country));
    }
    const vehicles = resolveRegion(
      {},
      { country, fulfilment: "collection" },
      {},
      "vehicle",
    ).marketplaces.map((m) => m.id);
    assert.deepEqual(region.vehicle, vehicles);
    for (const example of marketplaceExamples(country)) {
      assert.ok(region.marketplaces.some((market) => market.id === example.marketplace));
    }
  }
});
