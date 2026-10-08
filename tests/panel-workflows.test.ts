import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { operationForTool } from "@goodfinds/contracts/tool-names";
import { requestSearches } from "../apps/ui/src/features/searches/search-actions.ts";
import type { Action } from "../apps/ui/src/lib/actions.ts";

// Compile-time checks exercise the caller's command interface without executing mutations.
function actionTypes(action: Action) {
  void action("get_goodfinds_workspace", {});
  void action("set_goodfinds_search_enabled", { search_id: "search", enabled: false });
  // @ts-expect-error Unknown commands cannot cross the panel interface.
  void action("missing_goodfinds_command", {});
  // @ts-expect-error Command inputs retain their shared contract types.
  void action("set_goodfinds_search_enabled", { search_id: "search", enabled: "yes" });
  // @ts-expect-error Required command inputs cannot be omitted.
  void action("set_goodfinds_search_enabled", {});
  // @ts-expect-error A mutation needs an input payload.
  void action("set_goodfinds_search_enabled");
}
void actionTypes;

function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-panel-workflows-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  const state = Effect.runSync(store.request("get_workspace")).state;
  const search = state.searches[0];
  assert.ok(search);
  const calls: string[] = [];
  const invoke: Parameters<typeof requestSearches>[2]["invoke"] = async (name, args) => {
    calls.push(name);
    const operation = operationForTool(name);
    assert.ok(operation);
    return Effect.runSync(store.request(operation, args)).state;
  };
  return { store, state, search, calls, invoke };
}

void test("panel search requests are saved before one host dispatch", async (t) => {
  const f = fixture(t);
  const updates: string[][] = [];
  const dispatched: string[][] = [];
  await requestSearches(f.state, undefined, {
    invoke: f.invoke,
    requireHostActions: () => Promise.resolve(),
    update: (next) => updates.push(next.search_runs.map((run) => run.id)),
    requestBrowserSearch: async (searchId, runIds) => {
      assert.equal(searchId, undefined);
      assert.ok(runIds?.length);
      assert.deepEqual(updates.at(-1)?.toSorted(), runIds.toSorted());
      dispatched.push(runIds);
    },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(f.calls.length, f.state.searches.filter((search) => search.enabled).length);
  assert.ok(f.calls.every((name) => name === "request_goodfinds_search_run"));
});

void test("unavailable host access never creates a queued search", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    requestSearches(f.state, f.search, {
      invoke: f.invoke,
      requireHostActions: () => Promise.reject(new Error("Host unavailable")),
      update: () => assert.fail("No state should change"),
      requestBrowserSearch: () => assert.fail("No dispatch without host access"),
    }),
    /Host unavailable/,
  );
  assert.deepEqual(f.calls, []);
});

void test("failed host dispatch blocks its saved request without hiding the original error", async (t) => {
  const f = fixture(t);
  const phases: string[] = [];
  await assert.rejects(
    requestSearches(f.state, f.search, {
      invoke: f.invoke,
      requireHostActions: () => Promise.resolve(),
      update: (next) => {
        const run = next.search_runs.find((item) => item.search_id === f.search.id);
        assert.ok(run);
        phases.push(run.phase);
      },
      requestBrowserSearch: () => Promise.reject(new Error("Dispatch failed")),
    }),
    /Dispatch failed/,
  );
  assert.deepEqual(phases, ["requested", "blocked"]);
});

void test("dispatch reconciliation preserves a search changed by another actor", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    requestSearches(f.state, f.search, {
      invoke: f.invoke,
      requireHostActions: () => Promise.resolve(),
      update: () => undefined,
      requestBrowserSearch: async () => {
        const state = Effect.runSync(f.store.request("get_workspace")).state;
        const run = state.search_runs.find((item) => item.search_id === f.search.id);
        assert.ok(run);
        Effect.runSync(
          f.store.request("cancel_search_run", {
            request: { run_id: run.id },
          }),
        );
        throw new Error("Dispatch lost");
      },
    }),
    /Dispatch lost/,
  );
  const state = Effect.runSync(f.store.request("get_workspace")).state;
  assert.equal(
    state.search_runs.find((item) => item.search_id === f.search.id)?.phase,
    "cancelled",
  );
});
