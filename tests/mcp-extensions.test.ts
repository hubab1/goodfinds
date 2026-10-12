import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { nativeBinary } from "./helpers/native-driver.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { parsePanelPath, panelPath, panelDeepLink } from "@goodfinds/contracts/panel-presentation";
import { createSelectionPublisher } from "../apps/ui/src/lib/selection-context.ts";

void test("Deep links preserve identity and workspace, and reject non-navigation input", () => {
  const target = {
    listing_key: "manual:marketplace:a/b + £",
    search_id: "buying/brief",
    mode: "sample" as const,
  };
  assert.deepEqual(parsePanelPath(panelPath(target)), target);
  assert.deepEqual(parsePanelPath("/searches/my%20search"), {
    search_id: "my search",
    mode: "live",
  });
  assert.deepEqual(parsePanelPath("/"), { view: "searches", mode: "live" });
  assert.deepEqual(parsePanelPath("/listings"), { view: "listings", mode: "live" });
  for (const value of [
    "https://evil.test/",
    "//evil.test/",
    "/listings/x#fragment",
    "/listings/%",
    "/listings/%00",
    "/searches/..",
    "/searches/%2e%2e",
    "/listings/x?mode=bad",
    "/listings/x?mode=live&mode=sample",
    "/listings/x?send=true",
    "/searches/x?search_id=other",
    "/listings/x?search_id=",
    "/\\evil.test/x",
  ]) {
    assert.equal(parsePanelPath(value), undefined, value);
  }
  const link = new URL(
    panelDeepLink(target, { pluginId: "goodfinds-marketplace", marketplace: "local-goodfinds" }),
  );
  assert.equal(link.protocol, "codex:");
  assert.equal(link.pathname, "/goodfinds-marketplace@local-goodfinds/app/open_goodfinds_home");
  assert.equal(link.searchParams.get("path"), panelPath(target));
});

void test("Selection updates coalesce, remain ordered, and clear only their own selection", async () => {
  const sent: Record<string, unknown>[] = [];
  let finish: (() => void) | undefined;
  const publish = createSelectionPublisher(async (value) => {
    sent.push(value);
    if (sent.length === 1)
      await new Promise<void>((done) => {
        finish = done;
      });
  });
  const old = publish({ selected_listing: "one" });
  const current = publish({ selected_listing: "two" });
  old();
  current();
  finish?.();
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(sent, [{ selected_listing: "one" }, { selected_listing: null }]);
  let attempts = 0;
  const recovering = createSelectionPublisher(async () => {
    if (++attempts === 1) throw new Error("Host unavailable");
  });
  recovering({ selected_listing: "one" });
  await new Promise((done) => setTimeout(done, 0));
  recovering({ selected_listing: "two" });
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(attempts, 2);
});

void test("Native entrypoints and mentions expose bounded, readable, isolated resources", async (t) => {
  const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-extensions-"));
  const client = new Client({ name: "Extensions integration", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(folder, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: nativeBinary,
      env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
    }),
  );
  assert.deepEqual(client.getServerCapabilities()?.extensions?.["openai/mentions"], {
    searchTool: "search_goodfinds_mentions",
  });
  const tools = (await client.listTools()).tools;
  const entries = tools.filter((tool) => tool._meta?.["openai/ui"]);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((tool) => tool.title)).size, 2);
  const entryMeta = z.object({ entrypoints: z.array(z.object({ type: z.string() })) });
  assert.deepEqual(
    entryMeta.parse(
      entries.find((tool) => tool.name === "open_goodfinds_home")?._meta?.["openai/ui"],
    ).entrypoints,
    [{ type: "global" }],
  );
  assert.deepEqual(
    entryMeta.parse(
      entries.find((tool) => tool.name === "open_goodfinds_panel")?._meta?.["openai/ui"],
    ).entrypoints,
    [{ type: "thread" }],
  );
  const mentionTool = tools.find((tool) => tool.name === "search_goodfinds_mentions");
  assert.equal(mentionTool?.annotations?.readOnlyHint, true);
  assert.deepEqual(mentionTool?._meta?.["ui"], { visibility: ["app"] });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  for (const result of await Promise.all(entries.map((entry) => call(entry.name))))
    assert.equal(result.isError, undefined);
  const initial = stateFromToolResult(await call("get_goodfinds_workspace"));
  const sample = stateFromToolResult(
    await call("load_goodfinds_sample_workspace", { mode: "sample" }),
  );
  const mentions = z.object({
    items: z.array(
      z.object({ uri: z.string(), name: z.string(), type: z.literal("resource_link") }),
    ),
  });
  const live = mentions.parse(
    (await call("search_goodfinds_mentions", { query: "" })).structuredContent,
  );
  assert.deepEqual(live.items, []);
  const found = mentions.parse(
    (await call("search_goodfinds_mentions", { query: "", mode: "sample" })).structuredContent,
  );
  assert.ok(found.items.length > 0 && found.items.length <= 20);
  const search = found.items.find((item) => item.uri.includes("/searches/"));
  const listing = found.items.find((item) => item.uri.includes("/listings/"));
  assert.ok(search);
  assert.ok(listing);
  for (const result of await Promise.all(
    [search, listing].map((item) => client.readResource({ uri: item.uri })),
  )) {
    const content = z
      .object({ mimeType: z.literal("application/json"), text: z.string() })
      .parse(result.contents[0]);
    const data = z
      .object({ mode: z.literal("sample") })
      .loose()
      .parse(JSON.parse(content.text));
    assert.ok(data["search"] || data["listing"]);
  }
  assert.equal(
    stateFromToolResult(await call("get_goodfinds_workspace")).revision,
    initial.revision,
  );
  assert.equal(
    stateFromToolResult(await call("get_goodfinds_workspace", { mode: "sample" })).revision,
    sample.revision,
  );
  const filtered = mentions.parse(
    (await call("search_goodfinds_mentions", { query: search.name.toUpperCase(), mode: "sample" }))
      .structuredContent,
  );
  assert.ok(filtered.items.some((item) => item.uri === search.uri));
  assert.deepEqual(
    mentions.parse(
      (await call("search_goodfinds_mentions", { query: "' OR 1=1 --", mode: "sample" }))
        .structuredContent,
    ).items,
    [],
  );
  assert.equal((await call("search_goodfinds_mentions", { query: "x".repeat(201) })).isError, true);
  await assert.rejects(client.readResource({ uri: listing.uri.replace("sample", "live") }));
  await assert.rejects(client.readResource({ uri: `${listing.uri}?mode=live` }));
  await assert.rejects(client.readResource({ uri: "goodfinds://sample/searches/missing" }));
  const imported = await call("import_goodfinds_listing_observations", {
    observations: [
      {
        source: "facebook_marketplace",
        provenance: "manual",
        listing_id: "900002",
        url: "https://www.facebook.com/marketplace/item/900002/",
        title: "Écran portable",
        product: "macbook_pro",
        observed_at: new Date().toISOString(),
        currency: "EUR",
        price_minor: 50000,
        price_kind: "asking",
        collection_stage: "discovery",
      },
    ],
  });
  assert.ok(!imported.isError, JSON.stringify(imported));
  const unicode = mentions.parse(
    (await call("search_goodfinds_mentions", { query: "ÉCRAN" })).structuredContent,
  );
  assert.equal(unicode.items.length, 1);
  const row = unicode.items[0];
  assert.ok(row);
  assert.equal(row.name, "Écran portable");
  await client.readResource({ uri: row.uri });
});
