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
await mock.module("@modelcontextprotocol/ext-apps", () => ({
  App: class {
    addEventListener(name: string, callback: (event: unknown) => void) {
      events.set(name, callback);
    }
    connect() {
      events.get("toolinput")?.({ arguments: { request: { search_id: inputSearch.id } } });
      return Promise.resolve();
    }
    getHostContext() {
      return {};
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
} finally {
  await act(async () => root.unmount());
  await server.close();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
