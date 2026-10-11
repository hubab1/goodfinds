import { nativeBinary } from "./helpers/native-driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  resolveRegion,
  localeCountry,
  localizeTemplate,
  hostLocaleHints,
} from "@goodfinds/contracts/regional";
import { marketSearchUrl, isMarketplaceUrl } from "@goodfinds/contracts/integrations";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { marketplaceCapabilitiesResultSchema } from "@goodfinds/contracts/external-tools";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import { operations } from "@goodfinds/contracts/operations";

void test("locale hints never imply a country from language alone or override saved currency", () => {
  assert.equal(localeCountry("en"), undefined);
  assert.equal(localeCountry("en-u-rg-uszzzz"), undefined);
  assert.equal(localeCountry("zh-Hant-TW"), "TW");
  assert.deepEqual(
    hostLocaleHints({
      "openai/locale": "bad locale",
      "openai/userLocation": { country: "united states" },
    }),
    {},
  );
  assert.equal(resolveRegion({}, {}, { locale: "en" }).currency, null);
  const saved = { regional_preferences: { country: "GB", currency: "EUR" } };
  const result = resolveRegion(saved, {}, { locale: "en-US", country: "US" });
  assert.equal(result.country, "GB");
  assert.equal(result.currency, "EUR");
  assert.equal(result.sources.currency, "saved");
  assert.equal(resolveRegion(saved, { currency: "USD" }).currency, "USD");
});

const ids = (country: string, category: string, fulfilment: "collection" | "delivery" | "either") =>
  resolveRegion({}, { country, fulfilment }, {}, category).marketplaces.map((m) => m.id);

void test("recommendations combine country, category, fulfilment and disabled preferences", () => {
  assert.deepEqual(ids("US", "clothing", "delivery"), ["poshmark", "depop", "mercari", "ebay"]);
  assert.deepEqual(ids("GB", "vehicle", "collection"), [
    "autotrader",
    "facebook_marketplace",
    "ebay",
    "gumtree",
  ]);
  assert.deepEqual(ids("US", "vehicle", "collection"), [
    "cargurus",
    "cars_com",
    "autotrader_us",
    "facebook_marketplace",
    "ebay",
    "craigslist",
  ]);
  assert.deepEqual(ids("DE", "furniture", "collection"), ["facebook_marketplace", "ebay"]);
  assert.deepEqual(ids("CA", "clothing", "delivery"), ["ebay"]);
  assert.deepEqual(ids("AU", "clothing", "delivery"), ["vinted", "ebay"]);
  assert.deepEqual(
    resolveRegion(
      { platforms: { ebay: { enabled: false } } },
      { country: "US", fulfilment: "delivery" },
      {},
      "laptop",
    ).marketplaces.map((m) => m.id),
    ["mercari"],
  );
});

void test("regional URLs preserve language variants, accept regional evidence and never fall back to UK", () => {
  assert.match(
    marketSearchUrl("ebay", "camera", "BE", "fr-FR") ?? "",
    /^https:\/\/befr\.ebay\.be\//u,
  );
  assert.match(
    marketSearchUrl("ebay", "camera", "CA", "fr-CA") ?? "",
    /^https:\/\/cafr\.ebay\.ca\//u,
  );
  assert.match(marketSearchUrl("vinted", "coat", "AU") ?? "", /vinted\.com\.au/u);
  assert.equal(marketSearchUrl("ebay", "camera", "PT"), undefined);
  assert.equal(marketSearchUrl("vinted", "coat", "CA"), undefined);
  assert.equal(marketSearchUrl("autotrader", "car", "US"), undefined);
  assert.equal(marketSearchUrl("gumtree", "sofa"), undefined);
  assert.ok(isMarketplaceUrl("https://www.ebay.it/itm/123", "ebay"));
  assert.ok(isMarketplaceUrl("https://www.vinted.com.au/items/123-coat", "vinted"));
  assert.ok(!isMarketplaceUrl("https://www.ebay.it.attacker.example/itm/123"));
  assert.ok(!isMarketplaceUrl("https://www.vinted.ca/items/123-coat"));
});

void test("fresh templates use currency minor units without mutating the source", () => {
  const template = SEARCH_TEMPLATES[0];
  assert.ok(template);
  for (const [currency, divisor] of [
    ["EUR", 100],
    ["JPY", 1],
    ["KWD", 1000],
  ] as const) {
    const definition = localizeTemplate(template, currency);
    assert.equal(definition.price.currency, currency);
    assert.equal(
      definition.fields.find((f) => f.match?.attribute === "price_minor")?.display_divisor,
      divisor,
    );
  }
  assert.equal(template.price.currency, "GBP");
});

void test(
  `native MCP setup uses metadata before questions and preserves saved searches`,
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "goodfinds-region-"));
    const client = new Client({ name: "Regional regression", version: "1" });
    t.after(async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: nativeBinary,
        env: { PATH: "", GOODFINDS_WORKSPACE_DIR: root },
      }),
    );
    const call = async (
      name: string,
      args: Record<string, unknown> = {},
      meta?: Record<string, unknown>,
    ) => {
      const result = await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    const setup = async (args: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
      operations.get_setup_context.output.parse(
        await call("get_goodfinds_setup_context", args, meta),
      );
    const hinted = await setup(
      { category: "macbook_pro" },
      { "openai/locale": "en-US", "openai/userLocation": { country: "DE" } },
    );
    assert.equal(hinted.regional_context.country, "DE");
    assert.equal(hinted.templates[0]?.price.currency, "EUR");
    assert.equal(hinted.origin_confirmed, false);
    const unhinted = await setup({ category: "macbook_pro" });
    assert.deepEqual(unhinted.regional_context.needs, ["country", "currency"]);
    assert.equal(unhinted.templates.length, 0);
    await call("save_goodfinds_settings", {
      expected_entity_revision: unhinted.revisions.settings,
      settings: {
        regional_preferences: { country: "US", currency: "GBP", fulfilment: "delivery" },
      },
    });
    const saved = await setup({ category: "macbook_pro" }, { "openai/locale": "fr-FR" });
    assert.equal(saved.regional_context.country, "US");
    assert.equal(saved.templates[0]?.price.currency, "GBP");
    await call("save_goodfinds_settings", {
      expected_entity_revision: saved.revisions.settings,
      settings: { regional_preferences: { country: "DE" } },
    });
    const explicit = await setup({ preferences: { currency: "EUR" }, category: "macbook_pro" });
    assert.equal(explicit.regional_context.currency, "EUR");
    assert.equal(explicit.settings.regional_preferences?.currency, "GBP");
    assert.equal(explicit.settings.regional_preferences?.fulfilment, "delivery");
    const definition = {
      schema_version: 1,
      version: 1,
      category: "clothing",
      title: "Coat",
      description: "A coat under €500",
      price: { currency: "EUR", period: "once" },
      comparison_attributes: ["brand"],
      fields: [
        {
          id: "budget",
          label: "Budget",
          type: "integer",
          match: { attribute: "price_minor", operator: "lte" },
        },
      ],
    };
    const draft = {
      id: "draft-region",
      name: "Coat",
      definition,
      values: { budget: 50000 },
      market: { country: "DE", fulfilment: "delivery" },
    };
    const drafted = operations.save_search_draft.output.parse(
      await call("save_goodfinds_search_draft", {
        request_id: crypto.randomUUID(),
        expected_entity_revision: explicit.revisions.absent,
        draft,
      }),
    );
    const current = await setup();
    const promoted = operations.save_search.output.parse(
      await call("save_goodfinds_search", {
        request_id: crypto.randomUUID(),
        expected_entity_revision: current.revisions.absent,
        draft_id: draft.id,
        expected_draft_revision: drafted.revisions.drafts[draft.id],
        search: {
          id: "coat",
          name: "Coat",
          product: "clothing",
          definition,
          values: draft.values,
        },
        initial_monitoring: { preference: "once" },
      }),
    );
    assert.equal(promoted.search?.definition.price.currency, "EUR");
    assert.deepEqual(promoted.search?.values, { budget: 50000 });
    assert.deepEqual(promoted.search?.market, draft.market);
    assert.deepEqual(promoted.search?.marketplaces, ["vinted", "ebay"]);
    const after = await setup();
    await call("save_goodfinds_settings", {
      expected_entity_revision: after.revisions.settings,
      settings: {
        regional_preferences: { country: "US", currency: "USD", fulfilment: "collection" },
      },
    });
    const edit = await setup();
    const edited = operations.save_search.output.parse(
      await call("save_goodfinds_search", {
        request_id: crypto.randomUUID(),
        expected_entity_revision: edit.revisions.searches["coat"],
        search: {
          id: "coat",
          name: "Coat",
          product: "clothing",
          definition,
          values: { budget: 45000 },
        },
      }),
    );
    assert.equal(edited.search?.definition.price.currency, "EUR");
    assert.deepEqual(edited.search?.market, draft.market);
    assert.deepEqual(edited.search?.marketplaces, ["vinted", "ebay"]);
    const context = operations.get_search_context.output.parse(
      await call("get_goodfinds_search_context", { search_id: "coat" }),
    );
    assert.match(JSON.stringify(context["marketplace_routes"]), /vinted\.de/u);
    const changed = operations.save_search.output.parse(
      await call("save_goodfinds_search", {
        request_id: crypto.randomUUID(),
        expected_entity_revision: context.revisions.searches["coat"],
        search: {
          id: "coat",
          name: "Coat",
          product: "clothing",
          definition,
          values: { budget: 45000 },
          market: { fulfilment: "collection" },
        },
      }),
    );
    assert.equal(changed.search?.market?.country, "DE");
    assert.equal(changed.search?.market?.fulfilment, "collection");
    assert.deepEqual(
      changed.search?.marketplaces,
      ["vinted", "ebay"],
      "Explicit source choices survive preference edits",
    );
    const capabilities = marketplaceCapabilitiesResultSchema.parse(
      await call("list_goodfinds_marketplace_capabilities", { country: "BE", locale: "fr-BE" }),
    );
    assert.equal(
      capabilities.result.marketplaces.find((m) => m.id === "ebay")?.home,
      "https://befr.ebay.be/",
    );
    assert.equal(capabilities.result.marketplaces.find((m) => m.id === "gumtree")?.home, null);
    const defaults = await setup();
    const check = connectionCheckResultSchema.parse(
      await call("start_goodfinds_connection_check", {
        request_id: crypto.randomUUID(),
        expected_entity_revision: defaults.revisions.settings,
        marketplaces: ["ebay", "gumtree"],
      }),
    );
    assert.equal(
      check.run?.targets.find((m) => m.marketplace === "ebay")?.url,
      "https://www.ebay.com/",
    );
    assert.equal(check.run?.targets.find((m) => m.marketplace === "gumtree")?.url, null);
    await Promise.all(
      ["US", "GB"].flatMap((country) =>
        ["Toyota Camry", "Volkswagen Golf GTI"].map(async (model) => {
          const car = await setup(
            {
              category: "vehicle",
              preferences: { country, currency: "EUR", fulfilment: "collection" },
            },
            { "openai/locale": country === "US" ? "en-GB" : "en-US" },
          );
          const expected = ids(country, "vehicle", "collection");
          assert.deepEqual(
            car.regional_context.marketplaces.map((m) => m.id),
            expected,
          );
          assert.equal(expected[0], country === "US" ? "cargurus" : "autotrader");
          const search = {
            id: `${country.toLowerCase()}-${model.toLowerCase().replaceAll(" ", "-")}`,
            name: model,
            product: "vehicle",
            definition: { ...definition, title: model, category: "vehicle" },
            values: { budget: 2500000 },
            market: { country, fulfilment: "collection" },
          };
          const savedCar = operations.save_search.output.parse(
            await call("save_goodfinds_search", {
              request_id: crypto.randomUUID(),
              expected_entity_revision: car.revisions.absent,
              search,
              initial_monitoring: { preference: "once" },
            }),
          );
          assert.equal(savedCar.search?.name, model);
          assert.equal(savedCar.search?.definition.price.currency, "EUR");
          assert.deepEqual(savedCar.search?.marketplaces, expected);
          const savedContext = operations.get_search_context.output.parse(
            await call("get_goodfinds_search_context", { search_id: search.id }),
          );
          const routes = savedContext.marketplace_routes[search.id] ?? [];
          assert.ok(routes.every((route) => route.url));
          assert.equal(
            routes.some((route) => route.url?.includes("autotrader.co.uk")),
            country === "GB",
          );
          const rejected = await client.callTool({
            name: "save_goodfinds_search",
            arguments: {
              request_id: crypto.randomUUID(),
              expected_entity_revision: car.revisions.absent,
              search: {
                ...search,
                id: `${search.id}-wrong-country`,
                marketplaces: [country === "US" ? "autotrader" : "cargurus"],
              },
              initial_monitoring: { preference: "once" },
            },
          });
          assert.equal(rejected.isError, true, "New briefs reject unsupported regional sites");
          assert.match(JSON.stringify(rejected.content), /no supported route/u);
        }),
      ),
    );
  },
);
