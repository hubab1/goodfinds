import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { backendLayer } from "../apps/server/src/entrypoints/backend.ts";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Monitoring } from "../apps/ui/src/features/searches/monitoring.tsx";

function fixture(t: TestContext, linked = true) {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-host-monitoring-"));
  const data = resolve(root, "data");
  const automations = resolve(root, "codex/automations");
  const store = new WorkspaceStore(seedWorkspace(data));
  const read = () => Effect.runSync(store.request("get_workspace", {})).state;
  Effect.runSync(
    store.request("save_settings", {
      expected_entity_revision: revisionFor(read(), "save_settings"),
      settings: { quiet_hours: { ...read().config.schedule.quiet_hours, enabled: false } },
    }),
  );
  const search = read().searches[0];
  assert.ok(search);
  const thread = "00000000-0000-4000-8000-000000000003";
  const automationId = "isolated-search";
  if (linked) {
    Effect.runSync(
      store.request("set_monitoring", {
        expected_entity_revision: revisionFor(read(), "set_monitoring", {
          monitoring: { search_id: search.id },
        }),
        monitoring: { search_id: search.id, preference: "recurring" },
      }),
    );
    Effect.runSync(
      store.request("report_host_schedule", {
        expected_entity_revision: revisionFor(read(), "report_host_schedule", {
          report: { search_id: search.id },
        }),
        report: {
          search_id: search.id,
          automation_id: automationId,
          thread_id: thread,
          interval_minutes: 60,
          status: "active",
          evidence: "Isolated fixture registration",
          next_run_at: "2026-10-05T20:00:00Z",
        },
      }),
    );
  }
  const directory = resolve(automations, automationId);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "automation.toml");
  const write = (fields: Record<string, string> = {}) =>
    writeFileSync(
      path,
      Object.entries({
        id: automationId,
        kind: "heartbeat",
        status: "ACTIVE",
        rrule: "FREQ=HOURLY;INTERVAL=1",
        target_thread_id: thread,
        ...fields,
      })
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n"),
    );
  write();
  const app = createGoodfindsServer(seedWorkspace(data), backendLayer(data, automations));
  t.after(async () => {
    await app.server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = app.calls.get("open_goodfinds_panel");
  const context = app.calls.get("get_goodfinds_search_context");
  const monitoring = app.calls.get("get_goodfinds_monitoring");
  assert.ok(open && context && monitoring);
  const panel = async (mode: "live" | "sample" = "live") =>
    stateFromToolResult(await open({ mode }));
  const summary = async () => {
    const result = (await panel()).monitoring.find((item) => item.search_id === search.id);
    assert.ok(result);
    return result;
  };
  const render = async () =>
    renderToStaticMarkup(
      createElement(Monitoring, {
        summary: await summary(),
        revision: read().revision,
        busy: false,
        action: async () => undefined,
      }),
    );
  return {
    root,
    store,
    read,
    search,
    directory,
    path,
    write,
    panel,
    summary,
    context,
    monitoring,
    render,
  };
}

void test("compiled search hours are checked against actual host metadata without rewriting it", async (t) => {
  const f = fixture(t);
  Effect.runSync(
    f.store.request("save_settings", {
      expected_entity_revision: revisionFor(f.read(), "save_settings"),
      settings: {
        quiet_hours: { enabled: true, start: "22:00", end: "08:00", timezone: "Europe/London" },
      },
    }),
  );
  assert.equal((await f.summary()).label, "Schedule update needed");
  const plan = (await f.summary()).plan;
  assert.ok(plan.rrule);
  f.write({ rrule: plan.rrule, timezone: plan.timezone });
  const bytes = readFileSync(f.path, "utf8");
  assert.ok(["active", "quiet"].includes((await f.summary()).status));
  assert.equal((await f.summary()).host_schedule?.interval_minutes, null);
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  f.write({ rrule: plan.rrule, timezone: "UTC" });
  assert.equal((await f.summary()).label, "Schedule update needed");
  f.write({ rrule: plan.rrule, timezone: plan.timezone, status: "PAUSED" });
  assert.equal((await f.summary()).status, "paused");
});

void test("panel and chat reflect external pause and resume without altering search criteria or receipts", async (t) => {
  const f = fixture(t);
  const before = await f.panel();
  assert.equal((await f.summary()).status, "active");
  f.write({ status: "PAUSED" });
  const bytes = readFileSync(f.path, "utf8");
  const after = await f.panel();
  const summary = await f.summary();
  assert.equal(summary.status, "paused");
  assert.equal(summary.label, "Monitoring paused");
  assert.equal(summary.next_action, "resume");
  assert.equal(summary.host_schedule?.status, "paused");
  assert.equal(summary.schedule?.next_run_at, null);
  assert.equal(after.searches.find((item) => item.id === f.search.id)?.enabled, true);
  assert.equal(after.monitor.scheduler_available, false);
  assert.equal(after.revision, before.revision);
  assert.equal(f.read().config.monitoring[0]?.schedule?.status, "active");
  assert.equal(readFileSync(f.path, "utf8"), bytes);
  const result = await f.context({ mode: "live", search_id: f.search.id });
  assert.match(JSON.stringify(result.structuredContent), /"status":"paused"/);
  assert.match(await f.render(), /Monitoring paused/);
  assert.match(await f.render(), /Resume monitoring/);
  assert.doesNotMatch(await f.render(), /Stop monitoring/);
  f.write({ status: "ACTIVE" });
  assert.equal((await f.summary()).status, "active");
  assert.equal((await f.summary()).schedule?.last_run_at, null);
});

void test("removing a linked schedule is different from an unavailable host directory", async (t) => {
  const f = fixture(t);
  rmSync(f.path);
  assert.equal((await f.summary()).label, "Schedule removed");
  assert.equal((await f.summary()).next_action, "start");
  assert.equal((await f.summary()).host_schedule?.status, "removed");
  rmSync(resolve(f.root, "codex"), { recursive: true });
  assert.equal((await f.summary()).status, "unverified");
  assert.equal((await f.summary()).next_action, "check");
  assert.doesNotMatch(await f.render(), /Monitoring active/);
  assert.doesNotMatch(await f.render(), /Keep watching/);
});

void test("malformed automation metadata and changed identity never retain an active badge", async (t) => {
  const f = fixture(t);
  writeFileSync(f.path, "not valid = [ TOML");
  assert.equal((await f.summary()).status, "unverified");
  f.write({ target_thread_id: "00000000-0000-4000-8000-000000000002" });
  assert.equal((await f.summary()).status, "unverified");
  f.write({ id: "another-automation" });
  assert.equal((await f.summary()).status, "unverified");
  f.write({ status: "UNRECOGNIZED" });
  assert.equal((await f.summary()).status, "unverified");
});

void test("host frequency changes require updating the existing schedule and invalidate old next-run estimates", async (t) => {
  const f = fixture(t);
  f.write({ rrule: "FREQ=HOURLY;INTERVAL=2" });
  const changed = await f.summary();
  assert.equal(changed.status, "setup_needed");
  assert.equal(changed.next_action, "update");
  assert.equal(changed.schedule?.interval_minutes, 120);
  assert.equal(changed.schedule?.next_run_at, null);
  assert.equal((await f.panel()).monitor.scheduler_available, true);
  f.write({ rrule: "FREQ=HOURLY;INTERVAL=1;BYDAY=MO" });
  assert.equal((await f.summary()).label, "Schedule update needed");
  assert.equal((await f.summary()).next_action, "update");
  f.write({ rrule: "RRULE:FREQ=MINUTELY;INTERVAL=60" });
  assert.equal((await f.summary()).status, "active");
});

void test("lightweight monitoring reads have current host evidence and exclude listing data", async (t) => {
  const f = fixture(t);
  f.write({ status: "PAUSED" });
  const result = await f.monitoring({ mode: "live" });
  const data = result.structuredContent;
  assert.ok(data && "monitoring" in data);
  assert.match(JSON.stringify(data), /"status":"paused"/);
  assert.match(JSON.stringify(data), /checked_at/);
  assert.doesNotMatch(JSON.stringify(data), /listings|decisions|query_plans/);
  assert.equal(data["revision"], f.read().revision);
});

void test("unlinked searches and sample data never adopt or activate a host automation", async (t) => {
  const f = fixture(t, false);
  const bytes = readFileSync(f.path, "utf8");
  assert.equal((await f.summary()).status, "choice_needed");
  assert.equal((await f.summary()).label, "Monitoring off");
  assert.equal((await f.summary()).host_schedule, null);
  const sample = await f.panel("sample");
  assert.ok(
    sample.monitoring.every((item) => item.host_schedule === null && item.schedule === null),
  );
  assert.equal(readFileSync(f.path, "utf8"), bytes);
});
