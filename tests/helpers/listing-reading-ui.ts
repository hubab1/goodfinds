import { seedWorkspace } from "./workspace.ts";
import assert from "node:assert/strict";
import { z } from "zod";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { backendLayer } from "../reference-server/src/entrypoints/backend.ts";
import { WorkspaceStore } from "../reference-server/src/platform/workspace-sqlite.ts";

const dom = new Window({
  url: "https://panel.example",
  width: 1200,
  height: 900,
});
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
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
    writable: true,
  });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const)
  Object.defineProperty(globalThis, key, {
    value: dom[key].bind(dom),
    configurable: true,
  });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});
let hidden = false;
Object.defineProperty(document, "hidden", {
  get: () => hidden,
  configurable: true,
});
const rect = (height: number) => new dom.DOMRect(0, 0, 800, height);
const hasNewBadge = (item: HTMLElement) =>
  [...item.querySelectorAll("span")].some((span) => span.textContent?.trim() === "New");
class Observer implements IntersectionObserver {
  root = null;
  rootMargin = "0px";
  scrollMargin = "0px";
  thresholds = [0, 0.5, 1];
  readonly callback: IntersectionObserverCallback;
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(element: Element) {
    this.elements.delete(element);
  }
  static all = new Set<Observer>();
  elements = new Set<Element>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    Observer.all.add(this);
  }
  observe(element: Element) {
    this.elements.add(element);
  }
  disconnect() {
    this.elements.clear();
    Observer.all.delete(this);
  }
  emit(element: Element, height = 300) {
    this.callback(
      [
        {
          target: element,
          isIntersecting: height > 0,
          boundingClientRect: rect(300),
          intersectionRect: rect(height),
          rootBounds: rect(900),
          time: 0,
          intersectionRatio: height / 300,
        },
      ],
      this,
    );
  }
}
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: Observer,
  configurable: true,
});
const { createElement: el, act, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { observeListingVisibility } = await import("../../apps/ui/src/lib/listing-visibility.ts");
const { createSeenRecorder } = await import("../../apps/ui/src/features/listings/listing-seen.ts");
const { GoodfindsApp } = await import("../../apps/ui/src/App.tsx");

// A controllable clock verifies brief passes, hidden tabs, obscured cards and retry behavior.
const originalSetTimeout = globalThis.setTimeout,
  originalClearTimeout = globalThis.clearTimeout;
let at = 0,
  sequence = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const setTimer = (callback: () => void, delay = 0) => {
  const id = ++sequence;
  timers.set(id, { at: at + delay, callback });
  return id;
};
Object.defineProperty(globalThis, "setTimeout", {
  value: setTimer,
  configurable: true,
});
Object.defineProperty(globalThis, "clearTimeout", {
  value: (id: number) => timers.delete(id),
  configurable: true,
});
async function advance(ms: number) {
  at += ms;
  for (const [id, timer] of timers)
    if (timer.at <= at) {
      timers.delete(id);
      timer.callback();
    }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
const card = document.createElement("article");
document.body.append(card);
let attempts = 0;
const stop = observeListingVisibility(card, () => {
  attempts++;
  return Promise.resolve(attempts > 1);
});
const observer = [...Observer.all][0];
assert.ok(observer);
observer.emit(card, 20);
await advance(2000);
assert.equal(attempts, 0, "A sliver of a card does not count");
observer.emit(card);
await advance(500);
observer.emit(card, 0);
await advance(1000);
assert.equal(attempts, 0, "Scrolling past briefly does not count");
observer.emit(card);
hidden = true;
document.dispatchEvent(new Event("visibilitychange"));
await advance(1500);
assert.equal(attempts, 0, "A hidden app does not count");
hidden = false;
document.dispatchEvent(new Event("visibilitychange"));
const dialog = document.createElement("div");
dialog.setAttribute("role", "dialog");
dialog.setAttribute("aria-modal", "true");
document.body.append(dialog);
await advance(1500);
assert.equal(attempts, 0, "A modal obscuring a card does not count");
dialog.remove();
await Promise.resolve();
await advance(1000);
assert.equal(attempts, 1);
await advance(5000);
assert.equal(attempts, 2, "A failed receipt can retry without blocking the app");
await advance(6000);
assert.equal(attempts, 2, "A successful receipt saves once");
stop();
card.remove();

const batches: string[][] = [];
const recorder = createSeenRecorder((pairs) => {
  batches.push(pairs.map((p) => p.listing_key));
  return Promise.resolve();
});
const first = recorder.record([{ listing_key: "a", search_id: "one" }]);
const duplicate = recorder.record([{ listing_key: "a", search_id: "one" }]);
const second = recorder.record([{ listing_key: "b", search_id: "one" }]);
await advance(200);
assert.equal(await first, true);
assert.equal(await duplicate, true);
assert.equal(await second, true);
assert.deepEqual(batches, [["a", "b"]]);
recorder.dispose();
Object.defineProperty(globalThis, "setTimeout", {
  value: originalSetTimeout,
  configurable: true,
});
Object.defineProperty(globalThis, "clearTimeout", {
  value: originalClearTimeout,
  configurable: true,
});

// Exercise real app navigation and MCP persistence in an isolated workspace under StrictMode.
const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-reading-ui-"));
const store = new WorkspaceStore(seedWorkspace(dir));
const state = Effect.runSync(store.request("get_workspace")).state;
const search = state.searches[0];
assert.ok(search);
Effect.runSync(
  store.request("import_listing_observations", {
    observations: ["401", "402"].map((listing_id) => ({
      listing_id,
      source: "facebook_marketplace",
      provenance: "manual",
      title: `Laptop ${listing_id}`,
      product: search.product,
      url: `https://www.facebook.com/marketplace/item/${listing_id}/`,
      price_minor: 90000,
      price_kind: "asking",
      observed_at: new Date().toISOString(),
      collection_stage: "discovery",
    })),
  }),
);
const { server, calls } = createGoodfindsServer(
  dir,
  backendLayer(dir, null, () => Promise.resolve(null)),
);
window.__GOODFINDS_PREVIEW__ = { token: "fixture" };
const called: string[] = [];
Object.defineProperty(globalThis, "fetch", {
  value: async (_url: string, options: RequestInit) => {
    if (typeof options.body !== "string") throw new Error("Expected tool request JSON");
    const body = z
      .object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(options.body));
    called.push(body.name);
    const handler = calls.get(body.name);
    assert.ok(handler);
    return Response.json(await handler(body.arguments));
  },
  configurable: true,
});
const rootElement = document.createElement("div");
document.body.append(rootElement);
const root = createRoot(rootElement);
const pause = (ms: number) => new Promise((resolveWait) => originalSetTimeout(resolveWait, ms));
try {
  await act(async () => {
    root.render(el(StrictMode, null, el(GoodfindsApp)));
  });
  for (
    let i = 0;
    i < 200 && rootElement.textContent?.includes("Opening your saved searches");
    i++
  ) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for this fixture’s initial MCP response before navigating.
    await act(async () => {
      await pause(25);
    });
  }
  const unseen = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === `Show 2 new listings for ${search.name}`,
  );
  assert.ok(unseen, `Search row links its unseen count to results: ${rootElement.textContent}`);
  await act(async () => unseen.click());
  const articles = [...document.querySelectorAll<HTMLElement>("article.listing-card")];
  assert.equal(articles.length, 2);
  assert.equal(articles.filter(hasNewBadge).length, 2);
  assert.equal(document.querySelector('[aria-busy="true"]'), null);
  await act(async () => {
    for (const entry of Observer.all) for (const element of entry.elements) entry.emit(element);
    await pause(1300);
  });
  assert.equal(
    called.filter((name) => name === "set_goodfinds_listing_seen").length,
    1,
    "Visible cards save together without chat dispatch",
  );
  assert.equal(Effect.runSync(store.request("get_workspace")).state.searches[0]?.unseen_count, 0);
  assert.equal(
    [...document.querySelectorAll<HTMLElement>("article.listing-card")].some(hasNewBadge),
    false,
    "New badges clear when the cards have been viewed",
  );
  assert.equal(
    document.querySelectorAll("article.listing-card").length,
    2,
    "Seen cards stay in place during this visit",
  );
  assert.equal(
    document.querySelector('[aria-busy="true"]'),
    null,
    "Read receipts never disable the interface",
  );
  await act(async () => {
    const tab = document.querySelector<HTMLButtonElement>('[role="tab"][data-active]');
    assert.ok(tab);
    const searches = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (item) => item.textContent === "Searches",
    );
    assert.ok(searches);
    searches.click();
  });
  assert.doesNotMatch(rootElement.textContent ?? "", /All seen|\bunseen\b|\b0 new\b/iu);
  assert.ok(
    [...document.querySelectorAll<HTMLButtonElement>("button")].some(
      (item) =>
        item.getAttribute("aria-label") === `Show listings for ${search.name}` &&
        item.textContent?.includes("2 listings"),
    ),
    "The listing count remains without a redundant reading status",
  );
} finally {
  await act(async () => root.unmount());
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  await dom.happyDOM.close();
}
