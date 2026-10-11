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
import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";

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
const client = await import("../../apps/ui/src/lib/client.ts");
const requests: string[] = [];
const fixture = { hosted: false, fail: false, rejectHost: false };
await mock.module(resolve(import.meta.dir, "../../apps/ui/src/lib/client.ts"), () => ({
  ...client,
  getSavedImage: () => Promise.resolve(""),
  requestHostAction: (request: string) => {
    if (fixture.rejectHost) return Promise.reject(new Error("Host unavailable"));
    requests.push(request);
    return Promise.resolve({});
  },
}));
const { createElement: el, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Searches } = await import("../../apps/ui/src/features/searches/searches-page.tsx");
const { SearchDeleteDialog } =
  await import("../../apps/ui/src/features/searches/search-delete-dialog.tsx");
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-search-delete-"));
const store = new NativeWorkspace(folder, "sample");
const saved = { state: Effect.runSync(store.request("load_sample_workspace")).state };
const writes: string[] = [];
const invokeAction: Action = (name, args) => {
  if (fixture.fail) return Promise.resolve(undefined);
  writes.push(name);
  const operation = operationForTool(name);
  assert.ok(operation);
  const target = entityTarget(operation, args);
  saved.state = Effect.runSync(
    store.request(operation, {
      ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== "snapshot_revision")),
      request_id: crypto.randomUUID(),
      ...(target
        ? { expected_entity_revision: entityRevision(saved.state.revisions, target) }
        : {}),
    }),
  ).state;
  return Promise.resolve(saved.state);
};
function Panel() {
  const [state, setState] = useState(saved.state);
  const [deleting, setDeleting] = useState<string>();
  const [focus, setFocus] = useState<HTMLElement | null>(null);
  const returnFocus = { current: focus };
  const action: Action = async (name, args, message) => {
    const next = await invokeAction(name, args, message);
    if (next) setState(next);
    return next;
  };
  const shown: GoodfindsState = fixture.hosted
    ? {
        ...state,
        mode: "live",
        config: {
          ...state.config,
          dispatchers: [
            {
              id: "00000000-0000-4000-8000-000000000010",
              thread_id: "00000000-0000-4000-8000-000000000011",
              host_id: "local",
              notification_policy: null,
              search_ids: state.searches.map((search) => search.id),
              schedule: {
                automation_id: "shared-schedule",
                thread_id: "00000000-0000-4000-8000-000000000011",
                status: "paused",
                interval_minutes: 120,
                evidence: "Fixture",
                verified_at: "2026-10-11T12:00:00Z",
                next_run_at: null,
                last_run_at: null,
              },
            },
          ],
        },
      }
    : state;
  const search = shown.searches.find((item) => item.id === deleting);
  function deleteSearch(selected: SavedSearch, button: HTMLElement) {
    setFocus(button);
    setDeleting(selected.id);
  }
  return el(
    "div",
    null,
    el(Searches, {
      state: shown,
      busy: false,
      action,
      edit: () => {},
      resume: () => {},
      onSearch: () => {},
      onListings: () => {},
      onDelete: deleteSearch,
    }),
    search
      ? el(SearchDeleteDialog, {
          state: shown,
          search,
          action,
          busy: false,
          returnFocus,
          close: () => setDeleting(undefined),
        })
      : null,
  );
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
const openDelete = async (name: string) => {
  await click(`More options for ${name}`);
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent?.trim() === "Delete search",
  );
  assert.ok(item, "Delete search is exposed in the search menu");
  await act(async () => item.click());
  assert.ok(document.querySelector('[role="dialog"]'));
};
const confirm = async () => {
  const form = button("Delete search").form;
  assert.ok(form);
  await act(async () => form.requestSubmit());
};
try {
  await act(async () => root.render(el(Panel)));
  const first = saved.state.searches[0];
  assert.ok(first);
  const searchCount = saved.state.searches.length;
  const listingKeys = saved.state.listings.map((listing) => listing.key);
  await openDelete(first.name);
  assert.equal(writes.length, 0, "Opening confirmation makes no mutation");
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(saved.state.searches.length, searchCount);
  assert.equal(
    document.activeElement?.getAttribute("aria-label"),
    `More options for ${first.name}`,
  );

  fixture.hosted = true;
  await act(async () => root.render(el(Panel, { key: "hosted" })));
  await openDelete(first.name);
  fixture.rejectHost = true;
  await confirm();
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "Host unavailable");
  assert.equal(writes.length, 0, "Failed host dispatch leaves the search intact");
  fixture.rejectHost = false;
  await confirm();
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes(first.id));
  assert.ok(requests[0]?.includes("never resume a paused host schedule"));
  assert.ok(requests[0]?.includes("preserve every other search"));
  assert.equal(writes.length, 0, "The host reconciles the linked schedule before deletion");

  fixture.hosted = false;
  await act(async () => root.render(el(Panel, { key: "local" })));
  await openDelete(first.name);
  fixture.fail = true;
  await confirm();
  assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes("Couldn’t delete"));
  fixture.fail = false;
  await confirm();
  assert.equal(saved.state.searches.length, searchCount - 1);
  assert.equal(container.querySelector(`li[aria-label="${first.name}"]`), null);
  assert.deepEqual(
    saved.state.listings.map((listing) => listing.key),
    listingKeys,
  );
  const remaining = saved.state.searches[0];
  assert.ok(remaining);
  saved.state = Effect.runSync(
    store.request("request_search_run", {
      request: {
        search_id: remaining.id,
        request_id: crypto.randomUUID(),
        trigger: "manual",
        resume: true,
      },
    }),
  ).state;
  await act(async () => root.render(el(Panel, { key: "running" })));
  while (saved.state.searches.length) {
    const next = saved.state.searches[0];
    assert.ok(next);
    // Exercise the UI for every remaining search, including the final search.
    // oxlint-disable-next-line no-await-in-loop
    await openDelete(next.name);
    assert.equal(button("Delete search").disabled, false);
    // oxlint-disable-next-line no-await-in-loop
    await confirm();
  }
  assert.ok(container.textContent?.includes("Start your first search"));
  const cancellation = writes.indexOf("cancel_goodfinds_search_run");
  assert.ok(cancellation >= 0);
  assert.equal(
    writes[cancellation + 1],
    "remove_goodfinds_search",
    "Deletion stops the unfinished run first",
  );
  assert.deepEqual(
    saved.state.listings.map((listing) => listing.key),
    listingKeys,
  );
} finally {
  await act(async () => root.unmount());
  container.remove();
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
