import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isToolVisibilityAppOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import {
  selectListings,
  querySellerFilters,
  listingQuerySchema,
} from "@goodfinds/contracts/listing-query";

async function fixture(t: TestContext) {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-parity-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown = {}) => {
    const handler = calls.get(name);
    assert.ok(handler, `Missing tool: ${name}`);
    return handler(args);
  };
  return { data, server, call };
}

void test("every named panel action has a registered model action or a media equivalent", async (t) => {
  const { server } = await fixture(t);
  const client = new Client({ name: "Parity test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  const names = new Set<string>();
  const folder = resolve("apps/ui/src");
  const files = (await readdir(folder, { recursive: true })).filter((file) =>
    /\.tsx?$/u.test(file),
  );
  const sources = await Promise.all(files.map((file) => readFile(resolve(folder, file), "utf8")));
  for (const text of sources) {
    for (const match of text.matchAll(/["']([a-z_]*goodfinds[a-z_]*)["']/gu)) {
      if (match[1]) names.add(match[1]);
    }
  }
  assert.ok(names.size > 20, "Discover actual panel calls rather than a hand-maintained list");
  for (const name of names) {
    const tool = registered.get(name);
    assert.ok(tool, `${name} exists in the panel but is absent from MCP`);
    const agentTool =
      name === "get_goodfinds_video" ? registered.get("get_goodfinds_media_file") : tool;
    assert.ok(agentTool, `${name} has no agent equivalent`);
    assert.equal(isToolVisibilityAppOnly(agentTool), false, `${name} is unavailable to agents`);
  }
});

const pageSchema = z.object({
  listings: z.array(z.object({ key: z.string(), saved_photos: z.number() }).loose()),
  total: z.number(),
  next_offset: z.number().nullable(),
});
const sortingObservation = (listing_id: string, observed_at: string, price_minor: number) => ({
  source: "facebook_marketplace",
  provenance: "manual",
  collection_method: "user_requested_browser",
  listing_id,
  url: `https://www.facebook.com/marketplace/item/${listing_id}/`,
  title: `Laptop ${listing_id}`,
  product: "macbook_pro",
  collection_stage: "discovery",
  observed_at,
  price_kind: "asking",
  price_minor,
  currency: "GBP",
});
void test("listing tools sort by first discovery before pagination despite newer rechecks", async (t) => {
  const { call } = await fixture(t);
  const now = Date.now();
  const older = new Date(now - 3 * 86400000).toISOString();
  const newer = new Date(now - 86400000).toISOString();
  const rechecked = new Date(now - 60000).toISOString();
  stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        sortingObservation("801", older, 30000),
        sortingObservation("802", newer, 10000),
      ],
    }),
  );
  const state = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [sortingObservation("801", rechecked, 25000)],
    }),
  );
  await Promise.all(
    (["found_newest", "found_oldest", "price_low", "price_high"] as const).map(async (sort) => {
      const selected = selectListings(state, { sellerFilters: querySellerFilters({}), sort });
      const expected =
        sort === "found_newest" || sort === "price_low" ? "manual:802" : "manual:801";
      assert.equal(selected[0]?.key, expected);
      const [firstPage, nextPage] = await Promise.all([
        call("list_goodfinds_listings", { sort, limit: 1 }),
        call("list_goodfinds_listings", { sort, limit: 1, offset: 1 }),
      ]);
      const page = pageSchema.parse(firstPage.structuredContent);
      assert.equal(page.listings[0]?.key, expected);
      assert.equal(page.total, 2);
      assert.equal(page.next_offset, 1);
      const next = pageSchema.parse(nextPage.structuredContent);
      assert.equal(next.listings[0]?.key, selected[1]?.key);
    }),
  );
});
void test("conversation listing filters match the panel, paginate after filtering and undo dismissals", async (t) => {
  const { call } = await fixture(t);
  const before = stateFromToolResult(await call("get_goodfinds_workspace"));
  const search = before.searches.find((item) => item.product === "macbook_pro");
  assert.ok(search);
  const observed_at = new Date(Date.now() - 60000).toISOString();
  const seller = (
    id: string,
    count: number | null,
    precision: string | null,
    year: string,
    stale = false,
    ram = 32,
  ) => ({
    source: "facebook_marketplace",
    provenance: "manual",
    collection_method: "user_requested_browser",
    listing_id: id,
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title: `Laptop ${id}`,
    product: "macbook_pro",
    price_minor: Number(id) * 100,
    currency: "GBP",
    price_kind: "asking",
    collection_stage: "discovery",
    observed_at,
    chip: "M3 Pro",
    ram_gb: ram,
    ssd_gb: 1000,
    screen_inches: 14,
    condition: "like_new",
    item_state: "used",
    functional: true,
    availability: "active",
    drive_minutes: 30,
    drive_origin: before.config.origin,
    travel_source: "Observed drive",
    travel_checked_at: observed_at,
    seller_account_joined_at: year,
    seller_profile_url: "https://www.facebook.com/marketplace/profile/444/",
    seller_listing_count: count,
    seller_listing_count_precision: precision,
    seller_listings_checked_at: new Date(
      Date.now() - (stale ? 31 * 86400000 : 60000),
    ).toISOString(),
    evidence: {
      chip: "M3 Pro",
      ram_gb: `${ram} GB RAM`,
      ssd_gb: "1 TB SSD",
      screen_inches: "14 inch",
      condition: "Like new",
      functional: "Works",
      seller_listing_count: `${count ?? "Unknown"} listings`,
    },
  });
  const state = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        seller("101", 12, "exact", "2018"),
        seller("102", 20, "lower_bound", "2017"),
        seller("103", 100, "approximate", "2012"),
        seller("104", 30, "exact", "2018", true),
        seller("105", null, null, "2024"),
        seller("106", 10, "exact", "2022"),
        seller("107", 15, "exact", "2019", false, 16),
      ],
    }),
  );
  const query = listingQuerySchema.parse({
    search_id: search.id,
    seller_filters: { minimum_listings: 10, maximum_listings: 20, joined_by: 2020 },
    sort: "price_high",
    limit: 1,
  });
  const page = pageSchema.parse((await call("list_goodfinds_listings", query)).structuredContent);
  assert.equal(page.total, 2);
  assert.equal(page.next_offset, 1);
  assert.equal(page.listings[0]?.key, "manual:107");
  const selected = selectListings(
    state,
    { search_id: search.id, sellerFilters: querySellerFilters(query), sort: query.sort },
    Date.parse(state.generated_at),
  );
  assert.deepEqual(
    selected.map((item) => item.key),
    ["manual:107", "manual:101"],
  );
  const second = pageSchema.parse(
    (await call("list_goodfinds_listings", { ...query, offset: 1 })).structuredContent,
  );
  assert.equal(second.listings[0]?.key, "manual:101");
  const promising = pageSchema.parse(
    (await call("list_goodfinds_listings", { ...query, result_type: "promising", limit: 100 }))
      .structuredContent,
  );
  assert.deepEqual(
    promising.listings.map((item) => item.key),
    ["manual:101"],
  );
  const lowerBound = pageSchema.parse(
    (
      await call("list_goodfinds_listings", {
        ...query,
        seller_filters: { minimum_listings: 10, joined_by: 2020 },
        limit: 100,
      })
    ).structuredContent,
  );
  assert.deepEqual(lowerBound.listings.map((item) => item.key).toSorted(), [
    "manual:101",
    "manual:102",
    "manual:107",
  ]);
  const dismissed = stateFromToolResult(
    await call("record_goodfinds_listing_feedback", {
      expected_entity_revision: state.revisions.absent,
      feedback: {
        search_id: search.id,
        listing_key: "manual:107",
        action: "dismiss",
        reason: "Not interested",
      },
    }),
  );
  assert.equal(
    pageSchema.parse((await call("list_goodfinds_listings", query)).structuredContent).total,
    1,
  );
  assert.equal(
    pageSchema.parse(
      (await call("list_goodfinds_listings", { ...query, include_dismissed: true }))
        .structuredContent,
    ).total,
    2,
  );
  const feedback = dismissed.config.feedback.at(-1);
  assert.ok(feedback);
  await call("undo_goodfinds_listing_feedback", {
    expected_entity_revision:
      dismissed.revisions.feedback[feedback.id] ?? dismissed.revisions.absent,
    feedback_id: feedback.id,
  });
  assert.equal(
    pageSchema.parse((await call("list_goodfinds_listings", query)).structuredContent).total,
    2,
  );
  const invalidResults = await Promise.all(
    [
      { minimum_listings: 20, maximum_listings: 10 },
      { joined_by: new Date().getUTCFullYear() + 1 },
    ].map((seller_filters) => call("list_goodfinds_listings", { seller_filters })),
  );
  for (const result of invalidResults) assert.equal(result.isError, true);
  const settings = z
    .object({
      revision: z.string(),
      revisions: z.object({ settings: z.string() }),
      settings: z.object({ interval_minutes: z.number(), browser_preference: z.string() }).loose(),
    })
    .parse((await call("get_goodfinds_settings")).structuredContent);
  assert.equal(settings.settings.interval_minutes, state.config.schedule.interval_minutes);
  const changed = stateFromToolResult(
    await call("save_goodfinds_settings", {
      expected_entity_revision: settings.revisions.settings,
      settings: { minimum_peer_listings: 7 },
    }),
  );
  assert.equal(changed.config.minimum_peer_listings, 7);
  const activity = z
    .object({
      activity: z.array(z.object({ observed_count: z.number() }).loose()),
      total: z.number(),
      next_offset: z.number().nullable(),
    })
    .parse((await call("list_goodfinds_activity", { limit: 1 })).structuredContent);
  assert.equal(activity.activity[0]?.observed_count, 7);
  assert.equal(activity.total, 1);
  assert.equal(activity.next_offset, null);
});

void test("saved photos and videos are accessible to agents without encoded video payloads", async (t) => {
  const { data, call } = await fixture(t);
  const bytes = Buffer.from(
    "000000186674797069736f6d0000020069736f6d6d703432000000086d646174",
    "hex",
  );
  const videoPath = resolve(data, "seller.mp4");
  await writeFile(videoPath, bytes);
  const cached = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(
      (await call("cache_goodfinds_media", { files: [{ path: videoPath, label: "Seller video" }] }))
        .structuredContent,
    );
  const id = cached.media[0]?.id;
  assert.ok(id);
  const result = await call("get_goodfinds_media_file", { media_id: id });
  const file = z
    .object({ path: z.string(), mime_type: z.string(), size_bytes: z.number() })
    .parse(result.structuredContent);
  assert.equal(file.mime_type, "video/mp4");
  assert.equal(file.size_bytes, bytes.length);
  assert.deepEqual(await readFile(file.path), bytes);
  assert.equal(JSON.stringify(result).includes(bytes.toString("base64")), false);
  assert.equal(
    (await call("get_goodfinds_media_file", { media_id: "../seller.mp4" })).isError,
    true,
  );
  assert.equal(
    (await call("get_goodfinds_media_file", { media_id: "0".repeat(64) })).isError,
    true,
  );
  await writeFile(file.path, Buffer.from("changed"));
  assert.equal((await call("get_goodfinds_media_file", { media_id: id })).isError, true);
});
