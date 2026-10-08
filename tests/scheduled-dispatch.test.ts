import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { rrulestr } from "rrule";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { operations } from "@goodfinds/contracts/operations";
import { dispatcherPlan } from "@goodfinds/contracts/scheduled-dispatch";
import { revisionFor } from "./helpers/revisions.ts";

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function fixture(t: TestContext, observed = false) {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const automations = resolve(root, "automations");
  const store = new WorkspaceStore(
    seedWorkspace(resolve(root, "data")),
    "live",
    observed ? automations : null,
  );
  let now = Date.parse("2026-10-08T08:00:00Z");
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1000000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const request = (action: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(store.request(action, args).pipe(Effect.provideService(Clock.Clock, clock)));
  const state = () => request("get_workspace").state;
  const change = (action: string, args: Record<string, unknown>) =>
    request(action, { ...args, expected_entity_revision: revisionFor(state(), action, args) });
  change("save_settings", {
    settings: { quiet_hours: { enabled: true, start: "22:00", end: "08:00", timezone: "UTC" } },
  });
  const source = required(state().config.searches[0]);
  for (const id of ["third-search", "unscheduled-search"])
    change("save_search", { search: { ...source, id, name: id } });
  const ids = state()
    .searches.slice(0, 3)
    .map((s) => s.id);
  assert.equal(ids.length, 3);
  ids.forEach((search_id, i) =>
    change("set_monitoring", {
      monitoring: { search_id, preference: "recurring", interval_minutes: i ? 120 : 60 },
    }),
  );
  const thread = randomUUID(),
    id = randomUUID(),
    automation = "shared-searches";
  const context = (search_ids = ids, dispatcher_id?: string) =>
    operations.get_dispatcher_context.output.parse(
      Effect.runSync(
        store
          .query("get_dispatcher_context", {
            thread_id: thread,
            search_ids,
            ...(dispatcher_id ? { dispatcher_id } : {}),
          })
          .pipe(Effect.provideService(Clock.Clock, clock)),
      ),
    );
  const writeHost = (status = "ACTIVE", rule = required(context().plan.rrule), target = thread) => {
    const dir = resolve(automations, automation);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "automation.toml"),
      Object.entries({
        id: automation,
        kind: "heartbeat",
        status,
        rrule: rule,
        timezone: "UTC",
        target_thread_id: target,
      })
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n"),
    );
  };
  const report = (
    status = "active",
    search_ids = ids,
    dispatcher_id = id,
    extra: Record<string, unknown> = {},
  ) => {
    const c = context(search_ids);
    return change("report_dispatcher_schedule", {
      report: {
        dispatcher_id,
        thread_id: thread,
        search_ids,
        plan_revision: c.plan.revision,
        schedule: {
          automation_id: automation,
          thread_id: thread,
          status,
          interval_minutes: c.plan.interval_minutes,
          ...(c.plan.rrule ? { rrule: c.plan.rrule } : {}),
          timezone: c.plan.timezone,
          evidence: "Fixture host registration verified",
        },
        ...extra,
      },
    });
  };
  const batch = (request_id = randomUUID()) => {
    const result = request("request_scheduled_batch", {
      dispatcher_id: id,
      thread_id: thread,
      request_id,
    });
    assert.ok("batch" in result);
    return operations.request_scheduled_batch.output.shape.batch.parse(result["batch"]);
  };
  return {
    store,
    request,
    state,
    change,
    ids,
    thread,
    id,
    context,
    report,
    batch,
    writeHost,
    at: (value: string) => {
      now = Date.parse(value);
    },
  };
}

void test("shared wake-ups preserve hourly and two-hour searches and reserve only due work", (t) => {
  const f = fixture(t);
  const plan = f.context().plan;
  assert.equal(plan.times.length, 14);
  f.report();
  assert.ok(
    f
      .state()
      .monitoring.filter((m) => f.ids.includes(m.search_id))
      .every((m) => m.status === "active"),
  );
  const first = f.batch();
  assert.equal(first.runs.length, 3);
  first.runs.forEach((run) => f.request("cancel_search_run", { request: { run_id: run.run_id } }));
  f.at("2026-10-08T09:00:00Z");
  assert.deepEqual(
    f.batch().runs.map((r) => r.search_id),
    [f.ids[0]],
  );
  f.at("2026-10-08T10:00:00Z");
  assert.equal(f.batch().runs.length, 3);
  f.at("2026-10-08T22:00:00Z");
  assert.equal(f.batch().runs.length, 0);
  assert.equal(f.state().config.monitoring[1]?.interval_minutes, 120);
});

void test("replayed wake-ups and competing wake-ups reuse reservations and claimed workers", (t) => {
  const f = fixture(t);
  f.report();
  const wake = randomUUID(),
    first = f.batch(wake);
  const run = required(first.runs[0]);
  const worker = randomUUID();
  f.request("claim_search_run", {
    request: {
      run_id: run.run_id,
      expected_version: run.version,
      worker_id: worker,
      agent_id: "native-worker",
    },
  });
  assert.deepEqual(f.batch(wake), first);
  const next = f.batch();
  assert.equal(next.runs[0]?.worker_id, worker);
  assert.deepEqual(
    next.runs.map((r) => r.run_id),
    first.runs.map((r) => r.run_id),
  );
  assert.equal(f.state().search_runs.length, 3);
  f.at("2026-10-08T08:06:00Z");
  assert.equal(f.batch().runs.length, 0, "Expired reservations cannot restart the same occurrence");
  f.at("2026-10-08T09:00:00Z");
  assert.equal(f.batch().runs[0]?.run_id, run.run_id, "Next due check resumes unfinished coverage");
});

void test("pausing and removing one member preserves peers; the final member requires a stopped host", (t) => {
  const f = fixture(t);
  f.report();
  f.change("set_monitoring", { monitoring: { search_id: f.ids[1], preference: "once" } });
  assert.equal(f.state().monitoring.find((m) => m.search_id === f.ids[1])?.status, "saved");
  assert.equal(f.batch().runs.length, 2);
  f.change("remove_search", { search_id: f.ids[1] });
  f.change("remove_search", { search_id: f.ids[2] });
  assert.throws(() => f.change("remove_search", { search_id: f.ids[0] }), /pause/i);
  assert.equal(f.state().config.dispatchers[0]?.search_ids.length, 1);
});

void test("observed shared pause stops the entire group and fences already claimed work", (t) => {
  const f = fixture(t, true);
  f.writeHost();
  f.report();
  const first = f.batch(),
    run = required(first.runs[0]),
    worker = randomUUID();
  f.request("claim_search_run", {
    request: {
      run_id: run.run_id,
      expected_version: run.version,
      worker_id: worker,
      agent_id: "native-worker",
    },
  });
  f.writeHost("PAUSED");
  assert.equal(f.batch().reason, "paused");
  assert.ok(
    f
      .state()
      .monitoring.filter((m) => f.ids.includes(m.search_id))
      .every((m) => m.status === "paused"),
  );
  const stopped = f.request("renew_search_lease", {
    request: { run_id: run.run_id, worker_id: worker },
  });
  assert.equal(stopped.state.search_runs.find((r) => r.id === run.run_id)?.phase, "cancelled");
  assert.equal(
    f.state().config.dispatchers[0]?.schedule?.status,
    "active",
    "Reading a pause never resumes it",
  );
});

void test("timing edits invalidate shared registration and stale plans cannot overwrite membership", (t) => {
  const f = fixture(t);
  f.report();
  const stale = f.context().plan.revision;
  f.change("set_monitoring", {
    monitoring: { search_id: f.ids[0], preference: "recurring", interval_minutes: 120 },
  });
  assert.equal(f.state().monitoring[0]?.label, "Schedule update needed");
  assert.equal(f.batch().reason, "schedule_update_needed");
  assert.throws(() => f.report("active", f.ids, f.id, { plan_revision: stale }), /plan changed/i);
  f.report();
  assert.equal(f.batch().runs.length, 3);
});

void test("exact daily unions avoid cross-products; incompatible continuous groups stay separate", (t) => {
  const f = fixture(t);
  f.ids.forEach((search_id, i) =>
    f.change("set_monitoring", {
      monitoring: {
        search_id,
        preference: "recurring",
        timing: { mode: "daily", times: i ? ["18:30"] : ["08:15"] },
      },
    }),
  );
  const plan = f.context().plan;
  assert.ok(plan.rrule);
  const day = new Date("2026-10-08T00:00:00Z");
  assert.deepEqual(
    rrulestr(plan.rrule, { dtstart: day })
      .between(day, new Date("2026-10-09T00:00:00Z"), true)
      .map((d) => d.toISOString().slice(11, 16)),
    ["08:15", "18:30"],
  );
  f.change("save_settings", {
    settings: { quiet_hours: { enabled: false, start: "22:00", end: "08:00", timezone: "UTC" } },
  });
  f.ids.forEach((search_id, i) =>
    f.change("set_monitoring", {
      monitoring: { search_id, preference: "recurring", interval_minutes: i ? 120 : 60 },
    }),
  );
  assert.equal(f.context().plan.supported, false);
  assert.throws(() => f.report(), /recurrence/i);
});

void test("legacy migration verifies redundant pauses, original chat and per-search history", (t) => {
  const f = fixture(t);
  const legacy = (search_id: string, status: string, automation_id: string, thread_id = f.thread) =>
    f.change("report_host_schedule", {
      report: {
        search_id,
        status,
        automation_id,
        thread_id,
        interval_minutes: 120,
        evidence: "Verified legacy host",
        last_run_at: "2026-10-07T20:00:00Z",
      },
    });
  legacy(required(f.ids[1]), "active", "old-mac");
  assert.throws(() => f.report(), /redundant automation/i);
  legacy(required(f.ids[1]), "paused", "old-mac");
  f.report();
  assert.ok(f.state().config.monitoring.every((m) => m.schedule === null));
  assert.equal(
    f.state().monitoring.find((m) => m.search_id === f.ids[1])?.schedule?.last_run_at,
    "2026-10-07T20:00:00Z",
  );
  assert.equal(
    f.state().monitoring.find((m) => m.search_id === f.ids[0])?.schedule?.last_run_at,
    null,
  );
  assert.throws(() => f.report("active", f.ids, f.id, { thread_id: randomUUID() }), /original/i);
  assert.throws(
    () => f.report("active", f.ids, f.id, { notification_policy: "failed_runs_only" }),
    /notification/i,
  );
  assert.throws(
    () => f.report("active", [required(f.ids[0])], randomUUID()),
    /another dispatcher/i,
  );
});

void test("blocked reconciliation preserves the verified shared receipt and membership", (t) => {
  const f = fixture(t);
  f.report();
  const previous = f.state().config.dispatchers[0];
  f.report("blocked");
  assert.deepEqual(f.state().config.dispatchers[0], previous);
  assert.ok(f.state().config.monitoring.every((m) => m.interruption));
});

void test("eligibility excludes undecided, disabled and fulfilled goals from shared wake-up plans", (t) => {
  const f = fixture(t),
    config = f.state().config;
  required(config.searches[0]).enabled = false;
  required(config.monitoring.find((m) => m.search_id === f.ids[1])).preference = "undecided";
  assert.deepEqual(
    dispatcherPlan(config, f.ids, new Set([required(f.ids[2])]), Date.now(), "revision").search_ids,
    [],
  );
});

void test("MCP forwards dispatcher selectors and advertises the batch protocol", async (t) => {
  const f = fixture(t);
  const app = createGoodfindsServer(seedWorkspace(f.store.base));
  t.after(() => app.server.close());
  const tool = app.calls.get("get_goodfinds_dispatcher_context");
  assert.ok(
    tool &&
      app.calls.has("request_goodfinds_scheduled_batch") &&
      app.calls.has("report_goodfinds_dispatcher_schedule"),
  );
  const result = await tool({ mode: "live", thread_id: f.thread, search_ids: f.ids });
  assert.equal(result.isError, undefined);
  assert.equal(
    operations.get_dispatcher_context.output.parse(result.structuredContent).plan.times.length,
    14,
  );
});

void test("scheduled occurrence deduplication survives more than fifty newer manual runs", (t) => {
  const f = fixture(t);
  f.report();
  f.batch();
  f.at("2026-10-08T08:06:00Z");
  for (let index = 0; index < 51; index++) {
    const result = f.request("request_search_run", {
      request: { search_id: f.ids[0], request_id: randomUUID(), trigger: "manual" },
    });
    const run = result.state.search_runs.find(
      (r) => r.search_id === f.ids[0] && r.phase === "requested",
    );
    assert.ok(run);
    f.request("cancel_search_run", { request: { run_id: run.id } });
  }
  const batch = f.batch();
  assert.equal(batch.runs.length, 0);
  assert.equal(batch.skipped.find((s) => s.search_id === f.ids[0])?.reason, "already_started");
});

void test("only the member that completes a real scheduled search records successful execution", (t) => {
  const f = fixture(t);
  f.report();
  const selected = required(f.batch().runs[0]);
  let run = required(f.state().search_runs.find((r) => r.id === selected.run_id));
  for (const query of run.queries) {
    const result = f.request("update_search_run", {
      request: {
        run_id: run.id,
        expected_version: run.version,
        query: { ...query, status: "completed", result_count: 0, unique_relevant_count: 0 },
      },
    });
    run = required(result.state.search_runs.find((r) => r.id === selected.run_id));
  }
  f.request("update_search_run", {
    request: { run_id: run.id, expected_version: run.version, phase: "completed" },
  });
  const summaries = f.state().monitoring;
  assert.equal(
    summaries.find((m) => m.search_id === selected.search_id)?.schedule?.last_run_at,
    "2026-10-08T08:00:00.000Z",
  );
  assert.equal(summaries.find((m) => m.search_id === f.ids[1])?.schedule?.last_run_at, null);
});
