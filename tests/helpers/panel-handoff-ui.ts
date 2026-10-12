import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createNativeServer } from "./native-mcp.ts";
import { nativeOptions } from "./native-mcp.ts";
import { seedWorkspace } from "./workspace.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { panelPath } from "@goodfinds/contracts/panel-presentation";

const dom = new Window({ url: "https://panel.example", width: 1000, height: 900 });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Node",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "MouseEvent",
  "SVGElement",
  "IntersectionObserver",
])
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
  });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const)
  Object.defineProperty(globalThis, key, { value: dom[key].bind(dom), configurable: true });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-panel-ui-"));
const { server, calls } = createNativeServer(
  seedWorkspace(folder),
  nativeOptions(folder, null, () => Promise.resolve(null)),
);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const handler = calls.get(name);
  assert.ok(handler, name);
  const result = await handler(args);
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};
const events = new Map<string, (event: unknown) => void>();
const deliver = (result: CallToolResult) => events.get("toolresult")?.(result);
const initialForInput = stateFromToolResult(await call("get_goodfinds_workspace"));
const inputSearch = initialForInput.searches[1];
assert.ok(inputSearch);
const initialLink = process.argv.includes("--initial-link");
const contextUpdates: Record<string, unknown>[] = [];
let contextSupported = true;
const hostContext = initialLink
  ? { "openai/deepLink": { url: panelPath({ search_id: inputSearch.id }) } }
  : {};
await mock.module("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener(name: string, callback: (event: unknown) => void) {
      events.set(name, callback);
    }
    connect() {
      events.get("toolinput")?.({
        arguments: {
          request: { search_id: initialLink ? initialForInput.searches[0]?.id : inputSearch.id },
        },
      });
      return Promise.resolve();
    }
    getHostContext() {
      return hostContext;
    }
    getHostCapabilities() {
      return contextSupported ? { updateModelContext: { structuredContent: {} } } : {};
    }
    updateModelContext(value: Record<string, unknown>) {
      contextUpdates.push(value);
      return Promise.resolve({});
    }
    callServerTool({
      name,
      arguments: args,
    }: {
      name: string;
      arguments: Record<string, unknown>;
    }) {
      return call(name, args);
    }
  },
  applyDocumentTheme: () => {},
}));
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GoodfindsApp } = await import("../../apps/ui/src/App.tsx");
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const pause = () => new Promise((done) => setTimeout(done, 30));
const selectedTab = () =>
  container.querySelector('[aria-label="Goodfinds sections"] [aria-selected="true"]')?.textContent;
const tab = (name: string) => {
  const target = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Goodfinds sections"] [role="tab"]',
    ),
  ].find((item) => item.textContent?.startsWith(name));
  assert.ok(target);
  target.click();
};
try {
  await act(async () => {
    root.render(createElement(GoodfindsApp));
    await pause();
  });
  assert.match(
    selectedTab() ?? "",
    /^Listings/,
    "Opening arguments must select the search when the host omits result metadata",
  );
  assert.equal(
    container.querySelector('[aria-label="Current search"] h2')?.textContent,
    inputSearch.name,
  );
  if (initialLink) {
    await act(async () => {
      deliver(await call("open_goodfinds_home"));
      await pause();
    });
    assert.match(
      selectedTab() ?? "",
      /^Listings/,
      "Late opening result cannot replace the initial deep link",
    );
  }
  const initial = stateFromToolResult(await call("get_goodfinds_workspace"));
  const search = initial.searches[1];
  assert.ok(search);
  const opening = await call("start_goodfinds_search", {
    request: { search_id: search.id, request_id: crypto.randomUUID() },
  });
  await act(async () => {
    deliver?.(opening);
    await pause();
  });
  assert.match(selectedTab() ?? "", /^Listings/);
  assert.equal(
    container.querySelector('[aria-label="Current search"] h2')?.textContent,
    search.name,
  );
  assert.match(container.textContent ?? "", /Waiting to start/);
  assert.match(container.textContent ?? "", /first finds will appear here automatically/);
  assert.equal(
    container.querySelector(".listing-trends"),
    null,
    "An empty price chart must not push first-search progress out of view",
  );
  assert.ok(
    container.querySelector('[aria-label="Current search"] figure'),
    "A cover placeholder exists before media fetching",
  );
  const firstFind = await call("import_goodfinds_listing_observations", {
    observations: [
      {
        source: "facebook_marketplace",
        provenance: "manual",
        listing_id: "900001",
        url: "https://www.facebook.com/marketplace/item/900001/",
        title: "Pending details fixture",
        product: search.product,
        observed_at: new Date().toISOString(),
        price_minor: 95000,
        price_kind: "asking",
        currency: search.definition.price.currency,
        collection_stage: "discovery",
      },
    ],
  });
  await act(async () => {
    deliver?.(firstFind);
    await pause();
  });
  assert.ok(
    container.querySelector('article[aria-label="Pending details fixture"]'),
    "Incoming provisional finds appear in the focused search",
  );
  assert.equal(
    container.querySelector(".listing-trends"),
    null,
    "A provisional find without comparison evidence does not reveal an empty chart",
  );
  await act(async () => {
    tab("Settings");
    await pause();
  });
  const updated = await call("get_goodfinds_workspace");
  await act(async () => {
    deliver?.(updated);
    await pause();
  });
  assert.equal(selectedTab(), "Settings", "A refresh preserves the buyer's chosen tab");
  const reopened = await call("open_goodfinds_panel", { search_id: search.id });
  await act(async () => {
    deliver?.(reopened);
    await pause();
  });
  assert.match(selectedTab() ?? "", /^Listings/);
  await act(async () => {
    const stop = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Stop",
    );
    assert.ok(stop);
    stop.click();
    await pause();
  });
  assert.match(container.textContent ?? "", /Search stopped/);
  assert.doesNotMatch(container.textContent ?? "", /first finds will appear here automatically/);
  assert.equal(stateFromToolResult(await call("get_goodfinds_workspace")).search_runs.length, 1);
  const listing = stateFromToolResult(firstFind).listings.find(
    (item) => item.title === "Pending details fixture",
  );
  assert.ok(listing);
  const navigate = async (url: string) => {
    await act(async () => {
      events.get("hostcontextchanged")?.({ "openai/deepLink": { url } });
      await pause();
    });
  };
  await navigate(panelPath({ listing_key: listing.key, search_id: search.id }));
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, listing.title);
  assert.deepEqual(contextUpdates.at(-1), {
    structuredContent: {
      goodfinds: {
        mode: "live",
        selected_listing: {
          listing_key: listing.key,
          search_id: search.id,
          title: listing.title,
          url: listing.url,
          price_minor: listing.price_minor,
          currency: listing.currency,
          price_period: listing.price_period ?? null,
          observed_at: listing.observed_at ?? null,
        },
        detail_tool: "get_goodfinds_listing",
      },
    },
  });
  await act(async () => {
    events.get("hostcontextchanged")?.({ theme: "dark" });
    await pause();
  });
  assert.equal(
    document.querySelectorAll('[role="dialog"]').length,
    1,
    "Unrelated context changes preserve the selection",
  );
  await navigate("/");
  assert.equal(selectedTab(), "Searches");
  assert.deepEqual(contextUpdates.at(-1), {
    structuredContent: { goodfinds: { selected_listing: null } },
  });
  await navigate("/listings/missing");
  assert.match(container.textContent ?? "", /no longer available/);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await navigate("https://untrusted.test/");
  assert.match(selectedTab() ?? "", /^Listings/, "Invalid paths do not navigate");
  contextSupported = false;
  const before = contextUpdates.length;
  await navigate(panelPath({ listing_key: listing.key }));
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, listing.title);
  assert.equal(contextUpdates.length, before, "Unsupported context hosts still open listings");
  await navigate("/");
  contextSupported = true;
  const sampleState = stateFromToolResult(
    await call("load_goodfinds_sample_workspace", { mode: "sample" }),
  );
  const sampleListing = sampleState.listings[0];
  assert.ok(sampleListing);
  await navigate(panelPath({ listing_key: sampleListing.key, mode: "sample" }));
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, sampleListing.title);
  assert.match(container.textContent ?? "", /Sample workspace/);
  await navigate(panelPath({ listing_key: listing.key }));
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, listing.title);
  assert.doesNotMatch(container.textContent ?? "", /Sample workspace/);
} finally {
  await act(async () => root.unmount());
  await server.close();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
