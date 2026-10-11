import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { NativeWorkspace } from "./native-workspace.ts";
import { seedWorkspace } from "./workspace.ts";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import type { PanelPresentation } from "@goodfinds/contracts/panel-presentation";

const dom = new Window({ url: "https://panel.example" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"])
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? dom : Reflect.get(dom, key),
    configurable: true,
  });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-panel-init-"));
const store = new NativeWorkspace(seedWorkspace(folder));
const saved = Effect.runSync(store.request("get_workspace")).state;
const live = {
  ...saved,
  searches: [],
  search_runs: [],
};
const sample: GoodfindsState = { ...live, mode: "sample", searches: saved.searches };
const searchId = saved.searches[0]?.id;
assert.ok(searchId);
let opened: string[] = [];
let listener: ((state: GoodfindsState, presentation?: PanelPresentation) => void) | undefined;
let finishRead: (state: GoodfindsState) => void = () => {};
let failRead: (error: Error) => void = () => {};
await mock.module(resolve(import.meta.dir, "../../apps/ui/src/lib/client.ts"), () => ({
  invokeFeedback: () => {
    throw new Error("Unexpected feedback during startup");
  },
  invoke: () =>
    new Promise<GoodfindsState>((accept, reject) => {
      finishRead = accept;
      failRead = reject;
    }),
  subscribeToState: (next: (state: GoodfindsState, presentation?: PanelPresentation) => void) => {
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
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useWorkspace } = await import("../../apps/ui/src/app/use-workspace.ts");
function Panel() {
  const { state, error } = useWorkspace(
    () => {},
    (id) => opened.push(id),
  );
  return createElement("div", null, `${state?.mode ?? "loading"}:${error}`);
}
try {
  for (const order of ["host-first", "read-first", "read-error"] as const) {
    opened = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise each event ordering in isolation.
    await act(async () => {
      root.render(createElement(Panel));
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- React must flush each ordered notification.
    await act(async () => {
      if (order === "read-first") {
        finishRead(live);
        await Promise.resolve();
        listener?.(sample, { search_id: searchId });
      } else {
        listener?.(sample, { search_id: searchId });
        if (order === "read-error") failRead(new Error("Stale startup read"));
        else finishRead(live);
      }
    });
    assert.equal(
      container.textContent,
      "sample:",
      `${order}: the host's sample workspace must win over the startup read`,
    );
    assert.deepEqual(opened, [searchId], `${order}: the opening result selects its search once`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- A refresh follows each opening ordering.
    await act(async () => {
      listener?.(sample);
    });
    assert.deepEqual(opened, [searchId], "Data refreshes never repeat the opening navigation");
    // oxlint-disable-next-line eslint/no-await-in-loop -- Unmount before the next fixture uses the subscription.
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
  await dom.happyDOM.close();
}
