import { z } from "zod";
import { dispatcherArgs } from "./helpers/dispatcher.ts";
import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
import { stateToolResult } from "./helpers/native-mcp.ts";
import { createNativeServer } from "./helpers/native-mcp.ts";
import { nativeOptions } from "./helpers/native-mcp.ts";
import { stateSchema, stateFromToolResult } from "@goodfinds/contracts/state";
import { monitoringSummary, monitoringRequest } from "@goodfinds/contracts/monitoring";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Monitoring } from "../apps/ui/src/features/searches/monitoring.tsx";
import { SearchListRow } from "../apps/ui/src/features/searches/search-list-row.tsx";
import { randomUUID } from "node:crypto";

const thread = "00000000-0000-4000-8000-000000000001";
const otherThread = "00000000-0000-4000-8000-000000000002";
function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-monitoring-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(dir));
  const read = () => stateSchema.parse(Effect.runSync(store.request("get_workspace", {})).state);
  Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(read(), "save_settings"),
      settings: { quiet_hours: { ...read().config.schedule.quiet_hours, enabled: false } },
    }),
  );
  const mutate = (action: string, args: Record<string, unknown>) =>
    stateSchema.parse(
      Effect.runSync(
        store.request(action, {
          ...args,
          expected_entity_revision: revisionFor(read(), action, args),
        }),
      ).state,
    );
  const initialWatch = read().searches[0];
  assert.ok(initialWatch);
  const searchId = initialWatch.id;
  const choose = (preference: "once" | "recurring", interval_minutes = 60) =>
    mutate("set_monitoring", { monitoring: { search_id: searchId, preference, interval_minutes } });
  const report = (
    status: "active" | "paused" | "removed" | "blocked",
    extra: Record<string, unknown> = {},
  ) =>
    mutate(
      "report_dispatcher_schedule",
      dispatcherArgs(read(), [searchId], {
        automation_id: "fixture-coffee-search",
        thread_id: thread,
        status,
        interval_minutes: 60,
        evidence: "Fictional host receipt for this isolated test",
        ...extra,
      }),
    );
  const summary = () => {
    const item = read().monitoring.find((entry) => entry.search_id === searchId);
    assert.ok(item);
    return item;
  };
  return { dir, store, read, mutate, searchId, choose, report, summary };
}

void test("search rows separate monitoring from the result of a completed or interrupted run", (t) => {
  const f = fixture(t);
  assert.equal(f.summary().label, "Monitoring off");
  const search = f.read().searches.find((item) => item.id === f.searchId);
  assert.ok(search);
  const run = f.mutate("request_search_run", {
    request: { search_id: f.searchId, request_id: randomUUID() },
  }).search_runs[0];
  assert.ok(run);
  const render = (phase: "completed" | "partial") =>
    renderToStaticMarkup(
      createElement(SearchListRow, {
        search,
        origin: "Test area",
        sample: false,
        revision: f.read().revision,
        busy: false,
        action: async () => undefined,
        edit: () => undefined,
        onSearch: () => undefined,
        monitoring: f.summary(),
        run: { ...run, phase, interruption: phase === "partial" ? "Connection lost" : null },
      }),
    );
  assert.doesNotMatch(render("completed"), />Updated</);
  assert.match(render("partial"), /Retry search/);
  assert.doesNotMatch(render("partial"), />Interrupted</);
});

void test("saving criteria and a recurring preference never imply an active schedule", (t) => {
  const f = fixture(t);
  const first = f.read().config.searches[0];
  assert.ok(first);
  f.mutate("save_search", { search: first });
  assert.equal(f.summary().status, "choice_needed");
  assert.equal(f.summary().label, "Monitoring off");
  f.choose("recurring", 120);
  assert.equal(f.summary().status, "setup_needed");
  assert.equal(f.summary().next_action, "start");
  assert.equal(f.read().monitor.scheduler_available, false);
  assert.equal(f.read().config.schedule.enabled, false);
  const restarted = Effect.runSync(
    new NativeWorkspace(seedWorkspace(f.dir)).request("get_workspace", {}),
  ).state;
  assert.equal(
    restarted.monitoring.find((item) => item.search_id === f.searchId)?.interval_minutes,
    120,
  );
  const context = Effect.runSync(f.store.query("get_search_context", { search_id: f.searchId }));
  assert.ok(
    "paths" in context &&
      z.object({ database: z.string() }).parse(context.paths).database === f.store.databasePath,
  );
  assert.ok("monitoring" in context && context.monitoring?.length === 1);
});

void test("pause and resume leaves an unscheduled search with a visible scheduling action", (t) => {
  const f = fixture(t);
  const render = () => {
    const state = f.read();
    const search = state.searches.find((item) => item.id === f.searchId);
    assert.ok(search);
    return renderToStaticMarkup(
      createElement(SearchListRow, {
        search,
        origin: state.config.origin,
        sample: false,
        revision: state.revision,
        busy: false,
        action: async () => undefined,
        edit: () => undefined,
        onSearch: () => undefined,
        monitoring: f.summary(),
      }),
    );
  };
  f.mutate("set_search_enabled", { search_id: f.searchId, enabled: false });
  assert.equal(f.summary().status, "paused");
  f.mutate("set_search_enabled", { search_id: f.searchId, enabled: true });
  assert.equal(f.summary().status, "choice_needed");
  assert.equal(f.summary().schedule, null);
  // Portalled menu actions and keyboard behavior are exercised in helpers/dialog-ux.ts.
  const markup = render();
  assert.match(markup, /aria-haspopup="menu"/);
  assert.equal(f.summary().label, "Monitoring off");
  assert.match(markup, /Schedule<\/dt><dd[^>]*>Off<\/dd>/);
  assert.match(monitoringRequest(f.searchId, "search"), /Save preference recurring/);

  f.choose("recurring");
  f.report("paused");
  assert.equal(f.summary().status, "paused");
  assert.equal(f.summary().next_action, "resume");
});

void test("active receipts require the search choice, host identity and requested interval", (t) => {
  const f = fixture(t);
  assert.throws(() => f.report("active"));
  f.choose("once");
  assert.throws(() => f.report("active"));
  f.choose("recurring");
  assert.throws(() => f.report("active", { automation_id: null }));
  assert.throws(() => f.report("active", { evidence: "" }));
  assert.throws(() =>
    f.report("active", { interval_minutes: 120, rrule: "FREQ=HOURLY;INTERVAL=2" }),
  );
  f.report("active");
  assert.equal(f.summary().status, "active");
  assert.equal(f.read().monitor.scheduler_available, true);
  assert.equal(f.summary().schedule?.last_run_at, null);
  assert.equal(f.read().monitor.next_run_at, null);
  assert.throws(() => f.report("active", { thread_id: otherThread }));
  assert.throws(() => f.report("active", { automation_id: "unrequested-duplicate" }));
  assert.equal(f.summary().schedule?.automation_id, "fixture-coffee-search");
  const otherWatch = f.read().searches.find((item) => item.id !== f.searchId);
  assert.ok(otherWatch);
  f.mutate("set_monitoring", { monitoring: { search_id: otherWatch.id, preference: "recurring" } });
  const state = f.read();
  assert.throws(() =>
    f.mutate(
      "report_dispatcher_schedule",
      dispatcherArgs(state, [otherWatch.id], {
        automation_id: "fixture-coffee-search",
        thread_id: thread,
        status: "active",
        evidence: "Duplicate host identity",
      }),
    ),
  );
});

void test("frequency changes reconcile the shared automation without inventing a successful search", (t) => {
  const f = fixture(t);
  f.choose("recurring");
  f.report("active", { last_run_at: "2026-10-04T17:00:00Z" });
  f.choose("recurring", 120);
  assert.equal(f.summary().next_action, "update");
  assert.equal(f.summary().status, "setup_needed");
  f.report("active", { interval_minutes: 120, next_run_at: "2026-10-04T20:00:00Z" });
  assert.equal(f.summary().status, "active");
  assert.equal(f.summary().schedule?.last_run_at, null);
  assert.equal(f.read().monitor.next_run_at, "2026-10-04T20:00:00Z");
});

void test("one-off choice and pause require verified host stop, including failed stop attempts", (t) => {
  const f = fixture(t);
  f.choose("recurring");
  f.report("active");
  f.choose("once");
  assert.equal(f.summary().status, "stop_needed");
  f.report("blocked", { evidence: "Host could not verify the pause" });
  assert.equal(f.summary().status, "stop_needed");
  assert.equal(f.summary().schedule?.status, "active");
  f.report("paused");
  assert.equal(f.summary().status, "saved");
  assert.equal(f.summary().interruption, null);
  f.choose("recurring");
  assert.equal(f.summary().next_action, "resume");
  f.report("active");
  f.mutate("set_search_enabled", { search_id: f.searchId, enabled: false });
  assert.equal(f.summary().next_action, "pause");
  f.report("paused");
  assert.equal(f.summary().status, "paused");
  f.mutate("set_search_enabled", { search_id: f.searchId, enabled: true });
  assert.equal(f.summary().next_action, "resume");
});

void test("a failed host setup remains visible and a verified schedule binds its buying thread", (t) => {
  const f = fixture(t);
  f.choose("recurring");
  f.report("blocked", { automation_id: null, evidence: "Host scheduler unavailable" });
  assert.equal(f.summary().status, "blocked");
  assert.equal(f.summary().next_action, "start");
  assert.equal(f.summary().interruption, "Host scheduler unavailable");
  f.report("active");
  assert.throws(() => f.report("active", { thread_id: otherThread }));
  assert.equal(f.summary().interruption, null);
});

void test("removal cannot orphan an active host schedule", (t) => {
  const f = fixture(t);
  f.choose("recurring");
  f.report("active");
  assert.throws(() => f.mutate("remove_search", { search_id: f.searchId }));
  assert.ok(f.read().searches.some((item) => item.id === f.searchId));
  f.report("paused");
  f.mutate("remove_search", { search_id: f.searchId });
  assert.ok(!f.read().searches.some((item) => item.id === f.searchId));
  assert.ok(!f.read().config.monitoring.some((item) => item.search_id === f.searchId));
});

void test("fulfilled goals request host pause and sample workspaces inherit no real schedules", (t) => {
  const f = fixture(t);
  f.choose("recurring");
  f.report("active");
  const state = f.read();
  const search = state.searches[0];
  assert.ok(search);
  assert.equal(
    monitoringSummary(
      search,
      state.config.monitoring,
      60,
      true,
      false,
      null,
      state.config.schedule.quiet_hours,
      Date.parse(state.generated_at),
      state.dispatchers[0]
        ? { ...state.dispatchers[0], plan: { ...state.dispatchers[0].plan, search_ids: [] } }
        : undefined,
    ).next_action,
    "pause",
  );
  const sampleStore = new NativeWorkspace(f.dir, "sample");
  const sample = Effect.runSync(sampleStore.request("get_workspace", {})).state;
  assert.deepEqual(sample.config.monitoring, []);
  assert.ok(sample.monitoring.every((item) => item.status === "saved" && item.schedule === null));
  assert.throws(() =>
    Effect.runSync(
      sampleStore.request("set_monitoring", {
        expected_entity_revision: revisionFor(sample, "set_monitoring", {
          monitoring: { search_id: search.id },
        }),
        monitoring: { search_id: search.id, preference: "recurring" },
      }),
    ),
  );
});

void test("monitoring edits respect revisions and compact results expose follow-through", (t) => {
  const f = fixture(t);
  const stale = f.read().revision;
  f.choose("recurring");
  assert.throws(() =>
    Effect.runSync(
      f.store.request("set_monitoring", {
        expected_entity_revision: stale,
        monitoring: { search_id: f.searchId, preference: "once" },
      }),
    ),
  );
  const compact = stateToolResult({ state: f.read() }).structuredContent;
  assert.ok(compact && "state" in compact);
  assert.match(JSON.stringify(compact), /setup_needed/);
  f.report("active");
  const registered = stateToolResult({ state: f.read() }).structuredContent;
  assert.match(JSON.stringify(registered), /fixture-coffee-search/);
  assert.doesNotMatch(JSON.stringify(registered), /Fictional host receipt/);
});

void test("MCP exposes monitoring choice and verified receipts through the real tool contract", async (t) => {
  const f = fixture(t);
  const app = createNativeServer(seedWorkspace(f.dir), nativeOptions(f.dir, null));
  t.after(() => app.server.close());
  const set = app.calls.get("set_goodfinds_monitoring");
  const report = app.calls.get("report_goodfinds_dispatcher_schedule");
  assert.ok(set && report);
  const chosen = stateFromToolResult(
    await set({
      mode: "live",
      expected_entity_revision:
        f.read().revisions.monitoring[f.searchId] ?? f.read().revisions.absent,
      monitoring: { search_id: f.searchId, preference: "recurring" },
    }),
  );
  assert.equal(
    chosen.monitoring.find((item) => item.search_id === f.searchId)?.status,
    "setup_needed",
  );
  const registered = stateFromToolResult(
    await report({
      mode: "live",
      ...dispatcherArgs(chosen, [f.searchId], {
        automation_id: "fixture-coffee-search",
        thread_id: thread,
        status: "active",
        evidence: "Fictional active host receipt",
      }),
    }),
  );
  assert.equal(
    registered.monitoring.find((item) => item.search_id === f.searchId)?.status,
    "active",
  );
  const wrongThread = await report({
    mode: "live",
    expected_entity_revision:
      registered.revisions.monitoring[f.searchId] ?? registered.revisions.absent,
    report: {
      search_id: f.searchId,
      automation_id: "fixture-coffee-search",
      thread_id: otherThread,
      interval_minutes: 60,
      status: "active",
      evidence: "Wrong thread fixture",
    },
  });
  assert.equal(wrongThread.isError, true);
});

void test("panel distinguishes a pending search from registration and verified scheduled execution", (t) => {
  const f = fixture(t);
  const render = () =>
    renderToStaticMarkup(
      createElement(Monitoring, {
        summary: f.summary(),
        revision: f.read().revision,
        busy: false,
        action: async () => undefined,
      }),
    );
  assert.match(render(), /Search once/);
  assert.match(render(), /Start checks/);
  f.choose("recurring");
  assert.match(render(), /Automatic checks/);
  assert.match(render(), /Start checks/);
  assert.doesNotMatch(render(), /Monitoring active/);
  f.report("active");
  assert.match(render(), /Automatic checks/);
  assert.match(render(), /Pause checks/);
  assert.equal(f.summary().schedule?.last_run_at, null);
  assert.match(render(), /Last scheduled check<\/dt><dd><span>Not checked yet<\/span>/);
  f.report("active", { last_run_at: "2026-10-04T17:00:00Z" });
  assert.match(render(), /Not checked yet/, "A shared host wake-up does not prove this search ran");
  let run = f.mutate("request_search_run", {
    request: { search_id: f.searchId, request_id: randomUUID(), trigger: "scheduled" },
  }).search_runs[0];
  assert.ok(run);
  for (const query of run.queries) {
    run = f.mutate("update_search_run", {
      request: {
        run_id: run.id,
        expected_version: run.version,
        query: { ...query, status: "completed", result_count: 0, unique_relevant_count: 0 },
      },
    }).search_runs[0];
    assert.ok(run);
  }
  f.mutate("update_search_run", {
    request: { run_id: run.id, expected_version: run.version, phase: "completed" },
  });
  assert.ok(f.summary().schedule?.last_run_at);
  assert.match(render(), /Last scheduled check<\/dt><dd><time /);
  assert.doesNotMatch(render(), /Not checked yet/);
});
