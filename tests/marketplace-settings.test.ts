import { seedWorkspace } from "./helpers/workspace.ts";
import { createEbayClient } from "./reference-server/src/platform/ebay.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import {
  searchDefinitionSchema,
  savedSearchSchema,
  draftInputSchema,
} from "@goodfinds/contracts/search-definition";
import { locationSchema, accessAvailable, postalLabel } from "@goodfinds/contracts/integrations";
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { learnedCriteria } from "./reference-server/src/searches/learning.ts";
import {
  workspaceConfigurationSchema,
  listingObservationSchema,
} from "./reference-server/src/workspace/model.ts";
import { searchCohort } from "./reference-server/src/searches/definition.ts";
import { ebayEvidence, priceMinor } from "./reference-server/src/connections/ebay.ts";
import { deviceLocation, estimateIP, lookupPostal } from "../apps/ui/src/lib/location.ts";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { NOT_SURE } from "./reference-server/src/searches/interview.ts";
import { money } from "../apps/ui/src/lib/presentation.ts";
import { z } from "zod";

void test("one-use location pages restrict actions, enforce revisions and reject replay", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-location-page-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(folder));
  t.after(async () => {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const open = calls.get("open_goodfinds_location_chooser");
  assert.ok(open);
  const result = await open({ mode: "live" });
  const {
    result: { url },
  } = z.object({ result: z.object({ url: z.string() }) }).parse(result.structuredContent);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const token = (await page.text()).match(/token:"([a-f0-9]+)"/u)?.[1];
  assert.ok(token);
  const post = (name: string, args: unknown) =>
    fetch(new URL("/api/tool", url), {
      method: "POST",
      headers: { "X-Goodfinds-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
  assert.equal((await post("load_goodfinds_sample_workspace", { mode: "sample" })).status, 403);
  const raw: unknown = await (await post("get_goodfinds_workspace", { mode: "live" })).json();
  const state = stateFromToolResult(raw);
  const bad = await post("save_goodfinds_settings", {
    mode: "live",
    expected_entity_revision: state.revisions.settings,
    settings: { origin: "Not allowed" },
  });
  assert.equal(bad.status, 400);
  const settings = {
    location: {
      source: "manual",
      latitude: null,
      longitude: null,
      accuracy_m: null,
      area: "Example town",
      country: "GB",
      acquired_at: new Date().toISOString(),
      display: "town",
    },
  };
  const saved: unknown = await (
    await post("save_goodfinds_settings", {
      mode: "live",
      expected_entity_revision: state.revisions.settings,
      settings,
    })
  ).json();
  assert.equal(stateFromToolResult(saved).config.origin, "Example town");
  assert.equal(
    (
      await post("save_goodfinds_settings", {
        mode: "live",
        expected_entity_revision: state.revisions.settings,
        settings,
      })
    ).status,
    410,
  );
  assert.equal((await fetch(url)).status, 410);
  const reopened = await open({ mode: "live" });
  assert.equal(reopened.isError, undefined);
});

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

const now = Date.now();
const stamp = new Date(now).toISOString();
const definition = searchDefinitionSchema.parse({
  schema_version: 1,
  version: 1,
  category: "coffee_machine",
  title: "Coffee machines",
  description: "Hands-on espresso",
  price: { currency: "GBP", period: "once" },
  comparison_attributes: ["brand"],
  fields: [
    {
      id: "budget",
      label: "Budget",
      type: "integer",
      required: true,
      match: { attribute: "price_minor", operator: "lte" },
    },
  ],
});
const search = savedSearchSchema.parse({
  id: "coffee",
  name: "Coffee",
  product: "coffee_machine",
  enabled: true,
  definition,
  values: { budget: 20000 },
  marketplaces: ["ebay"],
  discovery: { scope: "alternatives", reference_model: "Barista Express" },
});
function coffeeRow(model = "Barista Pro", key = "ebay:123") {
  return listingObservationSchema.parse({
    key,
    listing_id: "123",
    title: model,
    url: "https://www.ebay.co.uk/itm/123",
    product: "coffee_machine",
    price_minor: 20000,
    currency: "GBP",
    source: "ebay",
    provenance: "manual",
    observed_at: stamp,
    attributes: { brand: "Sage", model, grinder: true },
    evidence: { model: `Listing says ${model}`, brand: "Sage", grinder: "Integrated grinder" },
  });
}
function config() {
  return workspaceConfigurationSchema.parse({
    origin: "Birmingham",
    baseline_days: 30,
    minimum_peer_listings: 3,
    alert_policy: "first_qualification_and_lower_price",
    searches: [search],
  });
}

void test("browser capability and marketplace login stay separate, scoped and stale-safe", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-sessions-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const report = {
    browser: "external",
    status: "available",
    host: "Codex",
    profile: "Chrome personal",
    evidence: "Host lists this connected Chrome profile",
  };
  assert.throws(
    () =>
      Effect.runSync(
        store.request("report_browser_access", {
          expected_entity_revision: revisionFor(state, "report_browser_access", { report }),
          context_id: "old-session",
          report,
        }),
      ),
    /Refresh/u,
  );
  state = Effect.runSync(
    store.request("report_browser_access", {
      expected_entity_revision: revisionFor(state, "report_browser_access", { report }),
      context_id: state.access_context,
      report,
    }),
  ).state;
  assert.equal(
    accessAvailable(
      state.config.browser_access,
      "external",
      state.access_context,
      Date.parse(state.generated_at),
    ),
    true,
  );
  assert.equal(
    accessAvailable(
      state.config.browser_access,
      "external",
      "new-process",
      Date.parse(state.generated_at),
    ),
    false,
  );
  assert.equal(
    accessAvailable(
      state.config.browser_access,
      "external",
      state.access_context,
      Date.parse(state.generated_at) + 31 * 60_000,
    ),
    false,
  );
  for (const [browser, status] of [
    ["in_app", "signed_out"],
    ["external", "signed_in"],
  ]) {
    state = Effect.runSync(
      store.request("report_marketplace_session", {
        expected_entity_revision: revisionFor(state, "report_marketplace_session", { report: {} }),
        context_id: state.access_context,
        report: {
          marketplace: "vinted",
          browser,
          status,
          host: "Codex",
          profile: browser,
          evidence: "Visible account or sign-in link checked",
        },
      }),
    ).state;
  }
  assert.deepEqual(
    state.config.platform_sessions.map((session) => session.status),
    ["signed_out", "signed_in"],
  );
  assert.equal(
    Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state.config
      .platform_sessions.length,
    2,
  );
  assert.equal(
    Effect.runSync(new WorkspaceStore(folder, "sample").request("get_workspace")).state.config
      .platform_sessions.length,
    0,
  );
});

void test("location confirmation retains coordinates, clearing removes them, and origin edits invalidate them", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-location-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let state = Effect.runSync(store.request("get_workspace")).state;
  const location = {
    source: "postal",
    latitude: 52.5,
    longitude: -1.9,
    accuracy_m: null,
    area: "Birmingham",
    country: "GB",
    postal_code: "B1",
    acquired_at: stamp,
    display: "postal",
  };
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(state, "save_settings"),
      settings: { location },
    }),
  ).state;
  assert.equal(state.config.origin, "B1");
  assert.equal(state.config.location?.latitude, 52.5);
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(state, "save_settings"),
      settings: { origin: "New area" },
    }),
  ).state;
  assert.equal(state.config.location, null);
  assert.equal(locationSchema.safeParse({ ...location, longitude: null }).success, false);
  assert.equal(locationSchema.safeParse({ ...location, latitude: 91 }).success, false);
  state = Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(state, "save_settings"),
      settings: { location: null },
    }),
  ).state;
  assert.equal(state.config.origin_confirmed, false);
  assert.equal(postalLabel("US"), "ZIP code");
  assert.equal(postalLabel("GB"), "Postcode");
  assert.equal(postalLabel("CA"), "Postal code");
});

void test("reference alternatives remain eligible with separate model price cohorts; exact scope excludes upgrades", () => {
  const cfg = config(),
    pro = coffeeRow(),
    express = coffeeRow("Barista Express", "ebay:124");
  assert.deepEqual(learnedCriteria(pro, search, cfg, true)[0], []);
  assert.notEqual(searchCohort(pro, search), searchCohort(express, search));
  const exact = {
    ...search,
    discovery: {
      ...search.discovery,
      scope: "exact" as const,
      reference_model: "Barista Express",
      model_attribute: "model",
    },
  };
  assert.match(learnedCriteria(pro, exact, cfg, true)[0].join(), /Different model/u);
  assert.deepEqual(learnedCriteria(express, exact, cfg, true)[0], []);
  const otherSource = coffeeRow();
  otherSource.source = "gumtree";
  assert.match(learnedCriteria(otherSource, search, cfg, true)[0].join(), /Marketplace/u);
});

void test("listing damage does not ban a model, explicit rules apply within scope, and undo restores matching", () => {
  const cfg = config(),
    pro = coffeeRow();
  cfg.feedback = [
    feedbackEventSchema.parse({
      id: "damaged",
      search_id: search.id,
      category: search.product,
      listing_key: pro.key,
      action: "dismiss",
      reason: "This one leaks",
      scope: "search",
      created_at: stamp,
      undone: false,
    }),
  ];
  assert.match(learnedCriteria(pro, search, cfg, true)[0].join(), /Dismissed/u);
  assert.deepEqual(
    learnedCriteria(coffeeRow("Barista Pro", "ebay:another"), search, cfg, true)[0],
    [],
  );
  cfg.feedback[0] = feedbackEventSchema.parse({
    ...cfg.feedback[0],
    rule: {
      attribute: "model",
      operator: "neq",
      value: "Barista Pro",
      importance: "required",
      label: "Avoid Barista Pro",
    },
    reason: "I do not want a Barista Pro",
  });
  assert.match(
    learnedCriteria(coffeeRow("Barista Pro", "ebay:another"), search, cfg, true)[0].join(),
    /Avoid/u,
  );
  assert.deepEqual(learnedCriteria(pro, { ...search, id: "other" }, cfg, true)[0], []);
  cfg.feedback[0].undone = true;
  assert.deepEqual(learnedCriteria(pro, search, cfg, true)[0], []);
});

void test("feedback persists with its original wording and is isolated from live data", (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-feedback-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const sample = new WorkspaceStore(folder, "sample");
  let state = Effect.runSync(sample.request("load_sample_workspace")).state;
  const laptop = state.searches[0],
    listing = state.listings.find((item) => item.product === laptop?.product);
  assert.ok(laptop);
  assert.ok(listing);
  state = Effect.runSync(
    sample.request("record_listing_feedback", {
      expected_entity_revision: revisionFor(state, "record_listing_feedback"),
      feedback: {
        search_id: laptop.id,
        listing_key: listing.key,
        action: "dismiss",
        reason: "This one is damaged",
      },
    }),
  ).state;
  const event = state.config.feedback[0];
  assert.ok(event);
  assert.equal(event.reason, "This one is damaged");
  assert.equal(event.scope, "search");
  assert.equal(event.rule, undefined);
  assert.equal(
    Effect.runSync(new WorkspaceStore(folder, "sample").request("get_workspace")).state.config
      .feedback.length,
    1,
  );
  assert.equal(
    Effect.runSync(new WorkspaceStore(seedWorkspace(folder)).request("get_workspace")).state.config
      .feedback.length,
    0,
  );
  state = Effect.runSync(
    sample.request("undo_listing_feedback", {
      expected_entity_revision: revisionFor(state, "undo_listing_feedback", {
        feedback_id: event.id,
      }),
      feedback_id: event.id,
    }),
  ).state;
  assert.equal(state.config.feedback[0]?.undone, true);
});

void test("IP estimate uses existing locality without reverse-geocoding or retaining raw IP", async () => {
  const urls: string[] = [];
  const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (
    input,
  ) => {
    urls.push(fetchUrl(input));
    return Response.json({
      success: true,
      latitude: 52.5,
      longitude: -1.9,
      city: "Birmingham",
      region: "England",
      country_code: "GB",
      ip: "private-value",
    });
  };
  const location = await estimateIP(fetcher);
  assert.equal(location.source, "ip");
  assert.equal(location.area, "Birmingham, England");
  assert.equal(urls.length, 1);
  assert.equal("ip" in location, false);
});

void test("device reverse geocoding stays on the same client after consent and fails cleanly on denial", async () => {
  let calls = 0;
  const geo: Pick<Geolocation, "getCurrentPosition"> = {
    getCurrentPosition(success) {
      success({
        coords: {
          latitude: 52.5,
          longitude: -1.9,
          accuracy: 50,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: now,
        toJSON: () => ({}),
      });
    },
  };
  const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (
    input,
  ) => {
    calls++;
    assert.match(fetchUrl(input), /reverse-geocode-client\?latitude=52.5&longitude=-1.9/u);
    return Response.json({
      city: "Birmingham",
      principalSubdivision: "England",
      countryCode: "GB",
    });
  };
  const location = await deviceLocation(geo, fetcher);
  assert.equal(location.accuracy_m, 50);
  assert.equal(calls, 1);
  const denied: Pick<Geolocation, "getCurrentPosition"> = {
    getCurrentPosition(_success, fail) {
      fail?.({
        code: 1,
        message: "denied",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
    },
  };
  await assert.rejects(deviceLocation(denied, fetcher), /declined/u);
  assert.equal(calls, 1);
});

void test("postal lookup preserves leading zeros and returns ambiguous places for user selection", async () => {
  const expectedUrl = "/us/02108";
  const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (
    input,
  ) => {
    assert.ok(fetchUrl(input).endsWith(expectedUrl));
    return Response.json({
      places: [
        { "place name": "Boston", latitude: "42.35", longitude: "-71.06", state: "Massachusetts" },
        { "place name": "Other area", latitude: "42.36", longitude: "-71.05" },
      ],
    });
  };
  const result = await lookupPostal("US", "02108", fetcher);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.postal_code, "02108");
  await assert.rejects(lookupPostal("GB", "BT1 1AA", fetcher), /Enter your town/u);
});

void test("eBay uses application OAuth, fixed-price filters, token caching and honest pagination", async () => {
  const calls: string[] = [];
  const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (
    input,
    init,
  ) => {
    const url = fetchUrl(input);
    calls.push(url);
    if (url.includes("oauth2/token")) {
      assert.equal(init?.method, "POST");
      return Response.json({ access_token: "test-token", expires_in: 7200 });
    }
    assert.equal(new Headers(init?.headers).get("X-EBAY-C-MARKETPLACE-ID"), "EBAY_GB");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
    assert.match(url, /buyingOptions%3A%7BFIXED_PRICE%7D/u);
    return Response.json({
      total: 2,
      next: "another-page",
      itemSummaries: [
        {
          itemId: "v1|123|0",
          title: "Coffee machine",
          itemWebUrl: "https://www.ebay.co.uk/itm/123",
          price: { value: "200.00", currency: "GBP" },
          buyingOptions: ["FIXED_PRICE"],
        },
      ],
    });
  };
  const ebay = createEbayClient({ clientId: "test-id", clientSecret: "test-secret", fetcher });
  const page = await ebay.search({ query: "espresso machine" });
  await ebay.search({ query: "Barista Pro" });
  assert.equal(calls.filter((url) => url.includes("oauth2/token")).length, 1);
  assert.equal(page.pagination_complete, false);
  assert.equal(page.items[0]?.price_minor, 20000);
  assert.equal(page.items[0]?.listing_id, "123");
  assert.equal(page.items[0]?.variation_id, null);
  const auction = ebayEvidence({
    itemId: "v1|123|0",
    title: "Auction",
    itemWebUrl: "https://www.ebay.co.uk/itm/123",
    price: { value: "10", currency: "GBP" },
    buyingOptions: ["AUCTION"],
  });
  assert.equal(auction.price_minor, null);
  assert.equal(priceMinor("10.005", "GBP"), null);
  assert.equal(priceMinor("200", "JPY"), 200);
  assert.equal(priceMinor("200", "BHD"), null);
  assert.equal(money(200, "JPY"), "JP¥200");
  assert.equal(money(20000, "GBP"), "£200");
  assert.throws(
    () =>
      ebayEvidence({
        itemId: "v1|123|0",
        title: "x",
        itemWebUrl: "https://attacker.example/itm/123",
      }),
    /Unexpected/u,
  );
  assert.throws(
    () =>
      ebayEvidence({
        itemId: "v1|123|0",
        title: "x",
        itemWebUrl: "https://www.ebay.co.uk/itm/456",
      }),
    /disagree/u,
  );
});

void test("native not-sure persists uncertainty without inventing an answer and repeated decisions are rejected", async (t) => {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-unsure-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const { server } = createGoodfindsServer(seedWorkspace(folder)),
    client = new Client(
      { name: "Unsure buyer", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(a);
  await client.connect(b);
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (request.params.mode !== "form") throw new Error("Expected a native form");
    return {
      action: "accept",
      content: request.params.requestedSchema.properties["purpose"]
        ? { purpose: [NOT_SURE] }
        : { budget: 200 },
    };
  });
  const d = searchDefinitionSchema.parse({
    ...definition,
    fields: [
      {
        id: "purpose",
        decision_id: "drink_workflow",
        label: "How would you like to make coffee?",
        type: "multiple_choice",
        required: true,
        question_stage: "setup",
        allow_unsure: true,
        options: [{ value: "espresso", label: "Espresso" }],
      },
      {
        id: "budget",
        label: "Maximum price",
        type: "integer",
        required: true,
        display_divisor: 100,
      },
    ],
  });
  let state = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  state = stateFromToolResult(
    await client.callTool({
      name: "save_goodfinds_search_draft",
      arguments: {
        expected_entity_revision: revisionFor(state, "save_goodfinds_search_draft", { draft: {} }),
        draft: { name: "Coffee", definition: d, values: {} },
      },
    }),
  );
  const result = await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: state.drafts[0]?.id },
  });
  assert.equal(
    z.object({ interview: z.object({ status: z.string() }) }).parse(result.structuredContent)
      .interview.status,
    "needs_guidance",
  );
  state = stateFromToolResult(result);
  assert.deepEqual(state.drafts[0]?.uncertain_fields, ["purpose"]);
  assert.equal(state.drafts[0]?.values["purpose"], undefined);
  const answered = await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: state.drafts[0]?.id },
  });
  assert.equal(
    z.object({ interview: z.object({ status: z.string() }) }).parse(answered.structuredContent)
      .interview.status,
    "needs_guidance",
  );
  state = stateFromToolResult(answered);
  assert.equal(state.drafts[0]?.values["budget"], 20000);
  const pending = state.drafts[0];
  assert.ok(pending);
  state = stateFromToolResult(
    await client.callTool({
      name: "save_goodfinds_search_draft",
      arguments: {
        expected_entity_revision: revisionFor(state, "save_goodfinds_search_draft", {
          draft: { ...pending },
        }),
        draft: {
          ...pending,
          uncertain_fields: [],
          values: { ...pending.values, purpose: ["espresso"] },
        },
      },
    }),
  );
  const ready = await client.callTool({
    name: "ask_goodfinds_search_question",
    arguments: { draft_id: state.drafts[0]?.id },
  });
  assert.equal(
    z.object({ interview: z.object({ status: z.string() }) }).parse(ready.structuredContent)
      .interview.status,
    "ready",
  );
  assert.equal(
    searchDefinitionSchema.safeParse({
      ...d,
      fields: [...d.fields, { ...d.fields[0], id: "purpose_again" }],
    }).success,
    false,
  );
  assert.equal(
    draftInputSchema.safeParse({
      name: "Coffee",
      definition: d,
      values: {},
      uncertain_fields: ["purpose"],
    }).success,
    true,
  );
});
