import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { NativeWorkspace } from "./native-workspace.ts";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { FeedbackResponse } from "../../apps/ui/src/features/listings/feedback-outbox.ts";

const dom = new Window({ url: "https://panel.example" });
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
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
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-outbox-"));
const store = new NativeWorkspace(folder, "sample");
const initial = Effect.runSync(store.request("load_sample_workspace")).state;
const search = initial.searches[0];
assert.ok(search);
const searchId = search.id;
const calls: {
  args: Record<string, unknown>;
  accept: (response: FeedbackResponse) => void;
  reject: (error: Error) => void;
}[] = [];
let listener: ((state: GoodfindsState) => void) | undefined;
await mock.module(resolve(import.meta.dir, "../../apps/ui/src/lib/client.ts"), () => ({
  invokeFeedback: (_name: string, args: Record<string, unknown>) =>
    new Promise<FeedbackResponse>((accept, reject) => calls.push({ args, accept, reject })),
  invoke: (name: string, args: Record<string, unknown>) => {
    if (name === "get_goodfinds_workspace") return Promise.resolve(initial);
    throw new Error(`Unexpected action: ${name}, ${Object.keys(args).join(",")}`);
  },
  subscribeToState: (next: (state: GoodfindsState) => void) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  },
  readSearchRuns: () => Promise.resolve([]),
  readMonitoring: () => Promise.resolve({}),
  requestBrowserSearch: () => Promise.resolve({}),
  requireHostActions: () => Promise.resolve({}),
}));
const { createElement: el, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useWorkspace } = await import("../../apps/ui/src/app/use-workspace.ts");
const { ListingDisregard } =
  await import("../../apps/ui/src/features/listings/listing-disregard.tsx");
function Panel() {
  const { state, busy, action } = useWorkspace(() => {});
  if (!state) return el("span", null, "Loading");
  const listings = selectListings(state, {
    search_id: searchId,
    sellerFilters: EMPTY_SELLER_FILTERS,
  });
  return el(
    "div",
    { "aria-busy": busy },
    listings.map((listing) =>
      el(
        "article",
        { key: listing.key, "data-key": listing.key },
        el(ListingDisregard, { listing, state, busy, action, preferredWatchId: searchId }),
      ),
    ),
  );
}
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
try {
  await act(async () => root.render(el(Panel)));
  const articles = [...container.querySelectorAll("article")];
  assert.ok(articles.length >= 2);
  const first = articles[0];
  const second = articles[1];
  assert.ok(first && second);
  const firstButton = first.querySelector<HTMLButtonElement>("button");
  const secondButton = second.querySelector<HTMLButtonElement>("button");
  assert.ok(firstButton && secondButton);
  const secondKey = second.getAttribute("data-key");
  await act(async () => {
    firstButton.click();
    await new Promise((done) => setTimeout(done, 5));
  });
  assert.equal(calls.length, 1, "First save is deliberately still pending");
  assert.equal(
    secondButton.disabled,
    false,
    "A pending dismissal must not disable another listing",
  );
  assert.equal(
    container.contains(first),
    false,
    "A dismissed card disappears before its save finishes",
  );
  await act(async () => secondButton.click());
  assert.equal(
    container.querySelector(`[data-key="${secondKey}"]`),
    null,
    "A second dismissal is optimistic too",
  );
  await act(async () => listener?.(initial));
  assert.equal(
    container.contains(first),
    false,
    "A stale host snapshot must not resurrect queued dismissals",
  );
} finally {
  await act(async () => root.unmount());
  container.remove();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
