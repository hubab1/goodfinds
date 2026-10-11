import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { operations } from "@goodfinds/contracts/operations";
import { nativeCall } from "./helpers/native-driver.ts";
import { seedWorkspace } from "./helpers/workspace.ts";

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

void test("missed completion notifications are recovered by cursor without replaying mutations", () => {
  const root = seedWorkspace(mkdtempSync(resolve(tmpdir(), "goodfinds-events-")));
  const now = Date.parse("2026-10-11T12:00:00Z");
  const call = (action: string, args: unknown, mode = "live") =>
    nativeCall({ op: "operation", root, action, args, now, mode });
  const feed = (args: Record<string, unknown> = {}, mode = "live") =>
    operations.list_coordination_events.output.parse(call("list_coordination_events", args, mode));
  try {
    const initial = feed();
    assert.equal(initial.events.length, 0);
    const setup = operations.get_setup_context.output.parse(call("get_setup_context", {}));
    const run_id = randomUUID();
    call("request_search_run", {
      request: { search_id: required(setup.search_index[0]).id, request_id: run_id },
    });
    call("cancel_search_run", { request: { run_id } });
    const page = feed({ after: initial.cursor, limit: 1 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.kind, "search_run.interrupted");
    assert.equal(page.events[0]?.resource.run_id, run_id);
    assert.deepEqual(
      feed({ after: initial.cursor }).events,
      page.events,
      "a lost response is safe to reread",
    );
    assert.equal(feed({ after: page.cursor }).events.length, 0);
    const recovery = operations.get_search_recovery.output.parse(
      call("get_search_recovery", { run_id }),
    );
    assert.equal(recovery.run.phase, "cancelled");
    assert.throws(
      () => feed({ after: { ...page.cursor, stream_id: randomUUID() } }),
      /resynchronize/u,
    );
    assert.throws(() => feed({ after: page.cursor }, "sample"), /resynchronize/u);
    call("load_sample_workspace", {}, "sample");
    const alerts = feed({}, "sample");
    assert.ok(alerts.events.some((e) => e.kind === "alert.created" && e.resource.alert_id));
    assert.ok(alerts.events.every((e) => !JSON.stringify(e).includes("send_permitted")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
