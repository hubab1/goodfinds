import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import { nativeCall } from "./helpers/native-driver.ts";
import { seedWorkspace } from "./helpers/workspace.ts";

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

void test("heartbeats return current guarded ownership without loading listing evidence or panel state", () => {
  const root = seedWorkspace(mkdtempSync(resolve(tmpdir(), "goodfinds-coordination-")));
  const now = Date.parse("2026-10-11T12:00:00Z");
  try {
    const call = (action: string, args: unknown, at = now) =>
      nativeCall({ op: "operation", root, action, args, now: at });
    const context = operations.get_setup_context.output.parse(call("get_setup_context", {}));
    const run_id = randomUUID();
    call("request_search_run", {
      request: { search_id: context.search_index[0]?.id, request_id: run_id },
    });
    const worker_id = randomUUID();
    call("claim_search_run", {
      request: { run_id, worker_id, agent_id: "coordination-test", expected_version: 0 },
    });
    const progress = () =>
      required(
        operations.list_search_runs.output
          .parse(call("list_search_runs", { progress_only: true }))
          .search_runs.find((r) => r.id === run_id),
      );
    const beforeHeartbeat = progress();
    const input = { request: { run_id, worker_id } };
    const measured = z
      .object({
        result: z.record(z.string(), z.unknown()),
        measurements: z.object({
          counts: z.record(z.string(), z.number()),
          stages_ms: z.record(z.string(), z.number()),
          result_bytes: z.number(),
          outcome: z.string(),
        }),
      })
      .parse(
        nativeCall({
          op: "measure_operation",
          root,
          action: "renew_search_lease",
          args: input,
          now: now + 60_000,
        }),
      );
    const renewed = operations.renew_search_lease.output.parse(measured.result["operation_result"]);
    assert.equal(renewed.search_run?.worker?.id, worker_id);
    assert.equal(renewed.search_run?.version, 2);
    assert.equal(renewed.search_run?.worker?.lease_expires_at, "2026-10-11T12:06:00.000Z");
    assert.equal(measured.result["state"], undefined);
    assert.equal(measured.measurements.counts["snapshots"] ?? 0, 0);
    assert.equal(measured.measurements.counts["listing_loads"] ?? 0, 0);
    assert.ok(measured.measurements.stages_ms["transaction"] !== undefined);
    assert.equal(measured.measurements.outcome, "success");
    const tool = z
      .object({
        structuredContent: operations.renew_search_lease.output,
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(
        nativeCall({
          op: "tool",
          root,
          name: "renew_goodfinds_search_lease",
          args: input,
          now: now + 70_000,
        }),
      );
    assert.equal(tool._meta?.["goodfinds_state"], undefined);
    assert.equal(tool.structuredContent.search_run?.version, 3);
    assert.equal(
      progress()["refresh_key"],
      beforeHeartbeat["refresh_key"],
      "heartbeats preserve the panel content revision",
    );
    const update = z
      .object({
        result: z.record(z.string(), z.unknown()),
        measurements: z.object({ counts: z.record(z.string(), z.number()) }),
      })
      .parse(
        nativeCall({
          op: "measure_operation",
          root,
          action: "update_search_run",
          args: {
            request: {
              run_id,
              worker_id,
              expected_version: 3,
              next_step: "Inspect the next saved query",
            },
          },
          now: now + 80_000,
        }),
      );
    assert.equal(update.result["state"], undefined);
    assert.equal(update.measurements.counts["snapshots"] ?? 0, 0);
    assert.notEqual(
      progress()["refresh_key"],
      beforeHeartbeat["refresh_key"],
      "visible progress requests a fresh panel",
    );
    const db = new Database(resolve(root, "workspace.sqlite"));
    try {
      const before = db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id);
      assert.throws(
        () => call("renew_search_lease", { request: { run_id, worker_id: randomUUID() } }),
        /another agent/u,
      );
      assert.deepEqual(
        db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id),
        before,
      );
      assert.throws(() => call("renew_search_lease", input, now + 10 * 60_000), /expired|stopped/u);
      assert.deepEqual(
        db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id),
        before,
        "failed renewal rolls reconciliation back with the command",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
