import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { rrulestr } from "rrule";
import { z } from "zod";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { backendLayer } from "../apps/server/src/entrypoints/backend.ts";
import {
  schedulePlan,
  inQuietHours,
  nextLocalTime,
  canonicalRule,
  searchTimingSchema,
} from "@goodfinds/contracts/search-timing";
import { monitoringSummary } from "@goodfinds/contracts/monitoring";
import { SearchHours } from "../apps/ui/src/features/settings/search-hours.tsx";

const quiet = { enabled: true, start: "22:00", end: "08:00", timezone: "Europe/London" };
function timeOfDay(value: number): string {
  return `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-search-timing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(dir));
  let now = Date.parse("2026-10-06T12:00:00Z");
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
  change("save_settings", { settings: { quiet_hours: { ...quiet, timezone: "UTC" } } });
  const search = state().searches[0];
  assert.ok(search);
  const choose = (extra: Record<string, unknown> = {}, searchId = search.id) =>
    change("set_monitoring", {
      monitoring: { search_id: searchId, preference: "recurring", ...extra },
    });
  const start = (trigger: "manual" | "scheduled", searchId = search.id) =>
    request("request_search_run", {
      request: { search_id: searchId, request_id: randomUUID(), trigger },
    });
  const check = () =>
    z
      .object({ allowed: z.boolean(), reason: z.string() })
      .parse(
        Effect.runSync(
          store
            .query("check_scheduled_search", { search_id: search.id })
            .pipe(Effect.provideService(Clock.Clock, clock)),
        ),
      );
  return {
    dir,
    store,
    state,
    change,
    choose,
    start,
    check,
    request,
    at: (value: string) => {
      now = Date.parse(value);
    },
    search,
  };
}

void test("hourly rules generate only daytime starts and selected daily times do not cross multiply", () => {
  const day = new Date("2026-10-06T00:00:00Z"),
    end = new Date("2026-10-07T00:00:00Z");
  for (const minutes of [15, 30, 60, 120, 180, 360, 720, 1440, 17, 47]) {
    const plan = schedulePlan(
      { mode: "interval", interval_minutes: minutes },
      { ...quiet, timezone: "UTC" },
    );
    assert.ok(plan.rrule);
    const actual = rrulestr(plan.rrule, { dtstart: day })
      .between(day, end, true)
      .map((date) => date.toISOString().slice(11, 16));
    assert.deepEqual(actual, plan.times);
    assert.ok(actual.every((time) => time >= "08:00" && time < "22:00"));
  }
  const plan = schedulePlan({ mode: "daily", times: ["08:15", "18:30", "23:00"] }, quiet);
  assert.ok(plan.rrule);
  assert.deepEqual(
    rrulestr(plan.rrule, { dtstart: day })
      .between(day, end, true)
      .map((date) => date.toISOString().slice(11, 16)),
    ["08:15", "18:30"],
  );
  assert.deepEqual(plan.excluded_times, ["23:00"]);
  assert.equal(schedulePlan({ mode: "daily", times: ["23:00"] }, quiet).rrule, null);
});

void test("quiet-hour boundaries use local time through both daylight-saving transitions", () => {
  for (const [at, expected] of [
    ["2026-10-06T20:59:00Z", false],
    ["2026-10-06T21:00:00Z", true],
    ["2026-10-07T06:59:00Z", true],
    ["2026-10-07T07:00:00Z", false],
    ["2026-10-25T07:59:00Z", true],
    ["2026-10-25T08:00:00Z", false],
    ["2026-03-29T06:59:00Z", true],
    ["2026-03-29T07:00:00Z", false],
  ] as const)
    assert.equal(inQuietHours(Date.parse(at), quiet), expected);
  assert.equal(
    nextLocalTime(["08:00"], quiet.timezone, Date.parse("2026-10-24T22:00:00Z")),
    "2026-10-25T08:00:00.000Z",
  );
  assert.equal(
    nextLocalTime(["08:00"], quiet.timezone, Date.parse("2026-03-28T22:00:00Z")),
    "2026-03-29T07:00:00.000Z",
  );
  const daytime = { ...quiet, start: "12:00", end: "14:00", timezone: "UTC" };
  assert.equal(inQuietHours(Date.parse("2026-10-06T12:00:00Z"), daytime), true);
  assert.equal(inQuietHours(Date.parse("2026-10-06T14:00:00Z"), daytime), false);
});

void test("scheduled starts skip overnight without creating work while manual searches remain available", (t) => {
  const f = fixture(t);
  f.choose();
  f.at("2026-10-06T22:00:00Z");
  assert.equal(f.check()["reason"], "quiet_hours");
  const skipped = f.start("scheduled");
  assert.ok("scheduled_check" in skipped && skipped.scheduled_check?.reason === "quiet_hours");
  assert.equal(skipped.state.search_runs.length, 0);
  const manual = f.start("manual").state.search_runs[0];
  assert.ok(manual);
  assert.equal(manual.trigger, "manual");
  assert.equal(manual.phase, "requested");
  assert.equal(f.state().config.monitoring[0]?.allow_quiet_hours, false);
});

void test("a failed scheduled run keeps monitoring enabled and resumes at the next permitted check", (t) => {
  const f = fixture(t);
  f.choose();
  const first = f.start("scheduled").state.search_runs[0];
  assert.ok(first);
  f.at("2026-10-06T12:06:00Z");
  assert.equal(f.state().search_runs[0]?.phase, "blocked");
  assert.equal(f.state().searches[0]?.enabled, true);
  assert.equal(f.state().config.monitoring[0]?.preference, "recurring");
  assert.equal(f.check().allowed, false, "Recovery respects the existing cadence");
  f.at("2026-10-06T13:00:00Z");
  assert.equal(f.check().allowed, true);
  const resumed = f.start("scheduled").state.search_runs[0];
  assert.equal(resumed?.id, first.id, "Recovery keeps saved coverage");
  assert.equal(resumed?.phase, "requested");
  assert.equal(resumed?.worker, null);
  f.request("cancel_search_run", { request: { run_id: first.id } });
  f.change("set_search_enabled", { search_id: f.search.id, enabled: false });
  f.at("2026-10-06T14:00:00Z");
  assert.equal(f.check().allowed, false, "An explicit pause stops automatic recovery");
  assert.equal(f.state().search_runs[0]?.phase, "cancelled");
});

void test("explicit per-search and global overrides are durable and preserve other search choices", (t) => {
  const f = fixture(t);
  f.choose({ allow_quiet_hours: true });
  f.at("2026-10-06T23:00:00Z");
  assert.equal(f.check()["allowed"], true);
  assert.equal(f.start("scheduled").state.search_runs[0]?.trigger, "scheduled");
  const other = f.state().searches.find((search) => search.id !== f.search.id);
  assert.ok(other);
  f.choose({}, other.id);
  assert.equal(
    f
      .start("scheduled", other.id)
      .state.search_runs.filter((searchRun) => searchRun.search_id === other.id).length,
    0,
  );
  f.change("save_settings", {
    settings: { quiet_hours: { ...quiet, timezone: "UTC", enabled: false } },
  });
  assert.ok(
    f
      .start("scheduled", other.id)
      .state.search_runs.some((searchRun) => searchRun.search_id === other.id),
  );
  f.change("save_settings", { settings: { baseline_days: 45 } });
  assert.equal(f.state().config.schedule.quiet_hours.enabled, false);
  assert.equal(f.state().config.monitoring[0]?.allow_quiet_hours, true);
});

void test("running scheduled workers defer at quiet hours and manual resume preserves progress", (t) => {
  const f = fixture(t);
  f.change("save_settings", {
    settings: { quiet_hours: { ...quiet, start: "21:02", timezone: "UTC" } },
  });
  f.choose();
  f.at("2026-10-06T21:00:00Z");
  const searchRun = f.start("scheduled").state.search_runs[0];
  assert.ok(searchRun);
  const worker = randomUUID();
  f.request("claim_search_run", {
    request: {
      run_id: searchRun.id,
      expected_version: searchRun.version,
      worker_id: worker,
      agent_id: "fixture-agent",
    },
  });
  f.at("2026-10-06T21:02:00Z");
  const stopped = f.request("renew_search_lease", {
    request: { run_id: searchRun.id, worker_id: worker },
  }).state.search_runs[0];
  assert.equal(stopped?.phase, "deferred");
  const resumed = f.start("manual").state.search_runs[0];
  assert.equal(resumed?.id, searchRun.id);
  assert.equal(resumed?.trigger, "manual");
  assert.equal(resumed?.worker, null);
});

void test("daily slots skip missed times, deduplicate retries and hourly start latency does not lose the next slot", (t) => {
  const f = fixture(t);
  f.choose({ timing: { mode: "daily", times: ["08:15", "18:30"] } });
  f.at("2026-10-06T09:00:00Z");
  assert.equal(f.check()["allowed"], false);
  f.at("2026-10-06T18:31:00Z");
  const searchRun = f.start("scheduled").state.search_runs[0];
  assert.ok(searchRun);
  f.request("cancel_search_run", { request: { run_id: searchRun.id } });
  assert.equal(f.check()["reason"], "already_started");
  f.choose({ interval_minutes: 60 });
  f.at("2026-10-07T08:00:10Z");
  const hourly = f.start("scheduled").state.search_runs[0];
  assert.ok(hourly);
  f.request("cancel_search_run", { request: { run_id: hourly.id } });
  f.at("2026-10-07T09:00:00Z");
  assert.equal(f.check()["allowed"], true);
});

void test("saved hour changes immediately guard claims and imports without losing prior progress", (t) => {
  const f = fixture(t);
  f.choose();
  f.at("2026-10-06T21:00:00Z");
  const searchRun = f.start("scheduled").state.search_runs[0];
  assert.ok(searchRun);
  f.change("save_settings", {
    settings: { quiet_hours: { ...quiet, start: "20:00", timezone: "UTC" } },
  });
  const claim = f.request("claim_search_run", {
    request: {
      run_id: searchRun.id,
      expected_version: searchRun.version,
      worker_id: randomUUID(),
      agent_id: "fixture-agent",
    },
  });
  assert.ok("scheduled_check" in claim && claim.scheduled_check?.reason === "quiet_hours");
  assert.equal(claim.state.search_runs[0]?.phase, "deferred");
  const before = f.state();
  const imported = f.request("import_listing_observations", {
    run_id: searchRun.id,
    worker_id: randomUUID(),
    observations: [{ invalid: "must not be imported" }],
  });
  assert.ok("scheduled_check" in imported);
  assert.deepEqual(imported.state.listings, before.listings);
  assert.deepEqual(imported.state.search_runs[0]?.queries, before.search_runs[0]?.queries);
});

void test("daily timing with no permitted times requires an explicit override and rejects invalid inputs", (t) => {
  const f = fixture(t);
  f.choose({ timing: { mode: "daily", times: ["23:00"] } });
  assert.equal(f.check()["reason"], "no_active_times");
  assert.equal(f.start("scheduled").state.search_runs.length, 0);
  f.choose({ allow_quiet_hours: true });
  f.at("2026-10-06T23:00:00Z");
  assert.equal(f.check()["allowed"], true);
  for (const times of [[], ["08:00", "08:00"], ["24:00"], Array(13).fill("08:00")])
    assert.equal(searchTimingSchema.safeParse({ mode: "daily", times }).success, false);
  assert.throws(() =>
    f.choose({ timing: { mode: "daily", times: ["08:00"] }, interval_minutes: 60 }),
  );
});

void test("clock changes skip nonexistent daily slots and deduplicate repeated local slots", (t) => {
  const f = fixture(t);
  f.change("save_settings", { settings: { quiet_hours: { ...quiet, enabled: false } } });
  f.choose({ timing: { mode: "daily", times: ["01:30"] } });
  assert.equal(
    nextLocalTime(["01:30"], quiet.timezone, Date.parse("2026-03-29T00:00:00Z")),
    "2026-03-30T00:30:00.000Z",
  );
  f.at("2026-10-25T00:30:00Z");
  const searchRun = f.start("scheduled").state.search_runs[0];
  assert.ok(searchRun);
  f.request("cancel_search_run", { request: { run_id: searchRun.id } });
  f.at("2026-10-25T01:30:00Z");
  assert.equal(f.check()["reason"], "already_started");
  const plan = schedulePlan({ mode: "interval", interval_minutes: 60 }, { ...quiet, end: "01:30" });
  assert.equal(
    nextLocalTime(plan.times, plan.timezone, Date.parse("2026-03-29T00:00:00Z")),
    "2026-03-29T01:30:00.000Z",
  );
});

void test("old host recurrences need updating and matching rules preserve pauses and report quiet hours", (t) => {
  const f = fixture(t);
  f.choose();
  const report = (rrule?: string, status: "active" | "paused" = "active") =>
    f.change("report_host_schedule", {
      report: {
        search_id: f.search.id,
        automation_id: "fixture-timed-search",
        thread_id: "00000000-0000-4000-8000-000000000001",
        interval_minutes: 60,
        status,
        evidence: "Isolated host receipt",
        ...(rrule ? { rrule, timezone: "UTC" } : {}),
      },
    });
  report();
  assert.equal(f.state().monitoring[0]?.label, "Schedule update needed");
  const plan = f.state().monitoring[0]?.plan;
  assert.ok(plan?.rrule);
  assert.throws(() => report("FREQ=HOURLY;INTERVAL=1"));
  report(plan.rrule);
  assert.equal(f.state().monitoring[0]?.status, "active");
  f.at("2026-10-06T22:00:00Z");
  assert.equal(f.state().monitoring[0]?.status, "quiet");
  assert.equal(f.state().monitor.scheduler_available, true);
  report(plan.rrule, "paused");
  f.change("save_settings", {
    settings: { quiet_hours: { ...quiet, timezone: "UTC", end: "09:00" } },
  });
  assert.equal(f.state().monitoring[0]?.status, "paused");
  const observed = monitoringSummary(
    f.search,
    f.state().config.monitoring,
    60,
    false,
    false,
    {
      status: "active",
      checked_at: "2026-10-06T22:00:00Z",
      interval_minutes: null,
      evidence: "Host recurrence observed independently",
      rrule: plan.rrule,
      timezone: "UTC",
    },
    f.state().config.schedule.quiet_hours,
    Date.parse("2026-10-06T22:00:00Z"),
  );
  assert.equal(observed.label, "Schedule update needed");
  assert.notEqual(canonicalRule(`FREQ=HOURLY;${plan.rrule}`), canonicalRule(plan.rrule));
  assert.notEqual(canonicalRule(`${plan.rrule};BYSECOND=0=ignored`), canonicalRule(plan.rrule));
});

void test("MCP exposes quiet hours, compiled daily timing and a lightweight preflight", async (t) => {
  const f = fixture(t);
  f.choose({ timing: { mode: "daily", times: ["08:15", "18:30"] } });
  const app = createGoodfindsServer(
    f.dir,
    backendLayer(f.dir, null, () => Promise.resolve(null)),
  );
  t.after(() => app.server.close());
  const check = app.calls.get("check_goodfinds_scheduled_search"),
    settings = app.calls.get("get_goodfinds_settings");
  assert.ok(check && settings);
  const result = await check({ mode: "live", search_id: f.search.id });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /listing_keys|photos|seller/);
  assert.match(JSON.stringify((await settings({ mode: "live" })).structuredContent), /quiet_hours/);
  const checked = z.object({ checked_at: z.string() }).parse(result.structuredContent);
  const minute =
    new Date(checked.checked_at).getUTCHours() * 60 + new Date(checked.checked_at).getUTCMinutes();
  f.change("save_settings", {
    settings: {
      quiet_hours: {
        enabled: true,
        start: timeOfDay(minute),
        end: timeOfDay(minute + 60),
        timezone: "UTC",
      },
    },
  });
  const start = app.calls.get("request_goodfinds_search_run");
  assert.ok(start);
  const skipped = await start({
    mode: "live",
    request: { search_id: f.search.id, request_id: randomUUID(), trigger: "scheduled" },
  });
  assert.equal(skipped.isError, undefined);
  assert.ok(skipped.structuredContent);
  assert.equal(
    z
      .object({ scheduled_check: z.object({ allowed: z.literal(false) }) })
      .safeParse(skipped.structuredContent).success,
    true,
  );
  assert.equal(f.state().search_runs.length, 0);
  const markup = renderToStaticMarkup(
    createElement(SearchHours, {
      hours: quiet,
      interval: 60,
      busy: false,
      save: async () => undefined,
    }),
  );
  assert.match(markup, /role="switch"[^>]*checked/u);
  assert.match(markup, /type="time"[^>]*value="22:00"/u);
  assert.match(markup, /type="time"[^>]*value="08:00"/u);
});
