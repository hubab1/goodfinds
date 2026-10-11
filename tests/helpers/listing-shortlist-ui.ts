import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { NativeWorkspace } from "./native-workspace.ts";
import { operationForTool } from "@goodfinds/contracts/tool-names";
import { entityRevision, entityTarget } from "@goodfinds/contracts/revisions";
import type { Action } from "../../apps/ui/src/lib/actions.ts";
import type { GoodfindsState } from "@goodfinds/contracts/state";

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
const requests: string[] = [];
await mock.module(clientPath, () => ({
  ...client,
  getSavedImage: () =>
    Promise.resolve("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="),
  requestHostAction: (request: string) => {
    requests.push(request);
    return Promise.resolve({});
  },
}));
const { createElement: el, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Deals } = await import("../../apps/ui/src/features/listings/listings-page.tsx");
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-shortlist-"));
const store = new NativeWorkspace(folder, "sample");
const fixture = {
  current: Effect.runSync(store.request("load_sample_workspace")).state,
  extraSearch: false,
};
const initialSearch = fixture.current.searches[0];
assert.ok(initialSearch);
const search = initialSearch;
const invokeAction: Action = (name, args) => {
  const operation = operationForTool(name);
  assert.ok(operation);
  const target = entityTarget(operation, args);
  assert.ok(target);
  fixture.current = Effect.runSync(
    store.request(operation, {
      ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== "snapshot_revision")),
      request_id: crypto.randomUUID(),
      expected_entity_revision: entityRevision(fixture.current.revisions, target),
    }),
  ).state;
  return Promise.resolve(fixture.current);
};
function Panel({ scoped }: { scoped: boolean }) {
  const [state, setState] = useState(fixture.current);
  const action: Action = async (name, args) => {
    const next = await invokeAction(name, args);
    if (next) setState(next);
    return next;
  };
  const shown: GoodfindsState = fixture.extraSearch
    ? {
        ...state,
        searches: [...state.searches, { ...search, id: "second-search", name: "Another laptop" }],
      }
    : state;
  return el(Deals, {
    state: shown,
    busy: false,
    action,
    recordSeen: () => Promise.resolve(true),
    ...(scoped ? { selection: { searchId: search.id, unseen: false } } : {}),
  });
}
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
};
try {
  await act(async () => root.render(el(Panel, { key: "scoped", scoped: true })));
  const cards = [...container.querySelectorAll<HTMLElement>("article.listing-card")];
  assert.ok(cards.length >= 2);
  const firstCard = cards[0];
  assert.ok(firstCard);
  const title = firstCard.getAttribute("aria-label");
  assert.ok(title);
  assert.ok(firstCard.contains(button(`Shortlist ${title}`)), "Bookmark belongs inside its card");
  assert.equal(container.textContent?.includes("Show more like this"), false);
  assert.equal(
    container.textContent?.includes("Find similar"),
    false,
    "Similar action is tucked in the menu",
  );
  assert.equal(
    firstCard.querySelector(".listing-card-actions")?.querySelectorAll("button").length,
    4,
  );
  assert.equal(
    [...firstCard.querySelectorAll("button")].some((entry) =>
      /^(Review|Prepare) message$/.test(entry.textContent?.trim() ?? ""),
    ),
    false,
    "Message actions must not occupy another footer button",
  );
  await click(`Shortlist ${title}`);
  assert.equal(button(`Remove ${title} from shortlist`).getAttribute("aria-pressed"), "true");
  await click(`More options for ${title}`);
  assert.ok(
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some((entry) =>
      /^(Review|Prepare) message$/.test(entry.textContent?.trim() ?? ""),
    ),
    "The conversation action is available inside the menu",
  );
  let item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent?.trim() === "Find similar",
  );
  assert.ok(item);
  await act(async () => item.click());
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes(search.id));
  assert.equal(
    button(`Remove ${title} from shortlist`).getAttribute("aria-pressed"),
    "true",
    "Find similar keeps the bookmark",
  );
  const native = Effect.runSync(
    store.query("list_listings", { search_id: search.id, shortlisted: true }),
  );
  assert.equal(native.total, 1, "MCP query exposes the same shortlist");
  await click("Shortlisted 1");
  assert.equal(container.querySelectorAll("article.listing-card").length, 1);

  // Reload in All searches: saved bookmarks remain visible and removable without changing scope.
  await act(async () => root.render(el(Panel, { key: "all", scoped: false })));
  await click("Shortlisted 1");
  assert.equal(container.querySelectorAll("article.listing-card").length, 1);
  await click(`Remove ${title} from shortlist`);
  assert.equal(container.querySelectorAll("article.listing-card").length, 0);
  assert.ok(container.textContent?.includes("No shortlisted listings"));
  assert.equal(Effect.runSync(store.query("list_listings", { shortlisted: true })).total, 0);
  await click("Shortlisted 0");
  assert.equal(button(`Shortlist ${title}`).getAttribute("aria-pressed"), "false");

  // With multiple related searches, ask for scope and allow Escape without saving anything.
  fixture.extraSearch = true;
  await act(async () => root.render(el(Panel, { key: "ambiguous", scoped: false })));
  const feedbackCount = fixture.current.config.feedback.length;
  await click(`Shortlist ${title}`);
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.ok(document.body.textContent?.includes("Choose the search this applies to."));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  assert.equal(fixture.current.config.feedback.length, feedbackCount);
  assert.equal(document.querySelector('[role="dialog"]'), null);
} finally {
  await act(async () => root.unmount());
  container.remove();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
