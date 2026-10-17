import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { NativeWorkspace } from "./native-workspace.ts";
const dom = new Window({ url: "https://panel.example", width: 1200, height: 900 });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
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
])
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
  });
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const)
  Object.defineProperty(globalThis, key, { value: dom[key].bind(dom), configurable: true });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  configurable: true,
});

const clientPath = resolve(import.meta.dir, "../../apps/ui/src/lib/client.ts");
const client = await import("../../apps/ui/src/lib/client.ts");
await mock.module(clientPath, () => ({
  ...client,
  getSavedImage: () =>
    Promise.resolve("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="),
  publishListingContext: () => () => {},
}));
const { createElement: el, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Deals } = await import("../../apps/ui/src/features/listings/listings-page.tsx");
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-availability-ui-"));
const store = new NativeWorkspace(folder, "sample");
const state = Effect.runSync(store.request("load_sample_workspace")).state;
const original = state.listings[0];
assert.ok(original);
state.listings = ["active", "sold", "reserved", "unknown"].map((availability) =>
  Object.assign({}, original, {
    key: availability,
    title: `${availability} item`,
    availability,
    photos: [],
    videos: [],
    seller_avatar_url: null,
  }),
);
state.decisions = [];
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const cards = () =>
  [...container.querySelectorAll("article.listing-card")].map((card) =>
    card.getAttribute("aria-label"),
  );
try {
  await act(async () =>
    root.render(
      el(Deals, {
        state,
        busy: false,
        action: () => Promise.resolve(undefined),
        recordSeen: () => Promise.resolve(true),
      }),
    ),
  );
  assert.deepEqual(
    cards().toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ["active item", "unknown item"],
  );
  const unavailable = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.textContent?.startsWith("Unavailable"),
  );
  assert.ok(unavailable);
  assert.equal(unavailable.textContent?.trim(), "Unavailable 2");
  await act(async () => unavailable.click());
  assert.deepEqual(
    cards().toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ["reserved item", "sold item"],
  );
  const sold = container.querySelector('article[aria-label="sold item"]');
  assert.ok(sold);
  assert.equal(sold.querySelector('[data-slot="badge"]')?.textContent, "Sold");
  const detail = sold.querySelector<HTMLButtonElement>('[aria-label="See details for sold item"]');
  assert.ok(detail);
  await act(async () => detail.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog?.textContent?.includes("Sold"));
} finally {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  rmSync(folder, { recursive: true, force: true });
}
