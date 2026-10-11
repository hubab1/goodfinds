import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import { searchRunSchema } from "@goodfinds/contracts/search-workflow";
import { nativeCall } from "./helpers/native-driver.ts";
import { seedWorkspace } from "./helpers/workspace.ts";

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

void test("recovery returns only missing coverage, pins pages and leaves expired ownership fenced", () => {
  const root = seedWorkspace(mkdtempSync(resolve(tmpdir(), "goodfinds-recovery-")));
  const now = Date.parse("2026-10-11T12:00:00Z");
  const call = (action: string, args: unknown, at = now) =>
    nativeCall({ op: "operation", root, action, args, now: at });
  const recover = (args: Record<string, unknown>, at = now) =>
    operations.get_search_recovery.output.parse(call("get_search_recovery", args, at));
  try {
    const setup = operations.get_setup_context.output.parse(call("get_setup_context", {}));
    const run_id = randomUUID();
    call("request_search_run", {
      request: { search_id: required(setup.search_index[0]).id, request_id: run_id },
    });
    const worker_id = randomUUID();
    call("claim_search_run", {
      request: { run_id, worker_id, agent_id: "recovery", expected_version: 0 },
    });
    const db = new Database(resolve(root, "workspace.sqlite"));
    try {
      const stored = z
        .object({ document_json: z.string() })
        .parse(db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id));
      const run = searchRunSchema.parse(JSON.parse(stored.document_json));
      required(run.queries[0]).status = "completed";
      run.listing_keys = ["manual:verified", "manual:missing-a", "manual:missing-b"];
      run.verified_keys = ["manual:verified"];
      db.query("UPDATE search_runs SET document_json=? WHERE id=?").run(
        JSON.stringify(run),
        run_id,
      );
      const before = db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id);
      const first = recover({ run_id, limit: 1 });
      assert.equal(first.run.worker?.id, worker_id);
      assert.equal(first.coverage.completed, 1);
      assert.equal(first.coverage.pending_verification, 2);
      assert.deepEqual(first.pending_verification, ["manual:missing-a"]);
      assert.ok(first.unfinished_queries.every((q) => q.status !== "completed"));
      assert.equal(first.search_current, true);
      assert.equal(first.brief_included, true);
      assert.equal("queries" in first.run, false);
      assert.throws(() => recover({ run_id, listing_offset: 1 }), /expected_version/u);
      const next = recover({
        run_id,
        listing_offset: first.next_listing_offset,
        expected_version: first.run.version,
        expected_context_revision: first.context_revision,
        include_brief: false,
        limit: 1,
      });
      assert.equal(next.brief, null);
      assert.equal(next.brief_included, false);
      assert.deepEqual(next.pending_verification, ["manual:missing-b"]);
      call("renew_search_lease", { request: { run_id, worker_id } }, now + 1000);
      assert.throws(
        () => recover({ run_id, expected_version: first.run.version }),
        /recovery changed/u,
      );
      const afterRenewal = db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id);
      assert.notDeepEqual(afterRenewal, before);
      const expired = recover({ run_id }, now + 10 * 60_000);
      assert.equal(expired.run.phase, "partial");
      assert.equal(expired.coverage.completed, 1);
      assert.deepEqual(
        db.query("SELECT document_json FROM search_runs WHERE id=?").get(run_id),
        afterRenewal,
        "recovery is read only",
      );
      assert.throws(
        () => call("renew_search_lease", { request: { run_id, worker_id } }, now + 10 * 60_000),
        /expired|stopped/u,
      );
      const measured = z
        .object({ measurements: z.object({ counts: z.record(z.string(), z.number()) }) })
        .parse(
          nativeCall({
            op: "measure_operation",
            root,
            action: "get_search_recovery",
            args: { run_id },
            now,
          }),
        );
      assert.equal(measured.measurements.counts["listing_loads"] ?? 0, 0);
      assert.equal(measured.measurements.counts["snapshots"] ?? 0, 0);
      db.query(
        "UPDATE saved_searches SET document_json=json_set(document_json,'$.name','Changed brief'),entity_version=entity_version+1 WHERE id=?",
      ).run(run.search_id);
      assert.throws(
        () => recover({ run_id, expected_context_revision: first.context_revision }),
        /context changed/u,
      );
      assert.equal(
        recover({ run_id }).search_current,
        false,
        "recovery exposes a changed brief without reviving ownership",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("capabilities retain advertised versus observed evidence, expire, and belong to their connection", () => {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-capabilities-"));
  const now = Date.parse("2026-10-11T12:00:00Z");
  const context = (at = now, access_context = "native-tests") =>
    operations.get_runtime_context.output.parse(
      nativeCall({
        op: "operation",
        root,
        action: "get_runtime_context",
        args: {},
        now: at,
        context: access_context,
      }),
    );
  try {
    const initial = context();
    assert.ok(initial.capabilities.every((c) => c.status === "unknown"));
    const args = {
      request_id: randomUUID(),
      expected_entity_revision: initial.revisions.evidence,
      context_id: initial.access_context,
      report: {
        host: "Fixture host",
        capabilities: {
          browser: { status: "advertised", evidence: "Tool listed" },
          panel: { status: "observed", evidence: "Panel rendered" },
          delegation: { status: "unavailable", evidence: "No delegation tools" },
        },
      },
    };
    nativeCall({ op: "operation", root, action: "report_host_capabilities", args, now });
    const saved = context();
    assert.equal(saved.capabilities.find((c) => c.name === "browser")?.status, "advertised");
    assert.equal(saved.capabilities.find((c) => c.name === "panel")?.status, "observed");
    assert.equal(saved.capabilities.find((c) => c.name === "delegation")?.status, "unavailable");
    assert.ok(context(now, "other-connection").capabilities.every((c) => c.status === "unknown"));
    assert.ok(
      context(now + 31 * 60_000).capabilities.every(
        (c) => c.status === "unknown" && c.evidence === null,
      ),
    );
    assert.throws(
      () =>
        nativeCall({
          op: "operation",
          root,
          action: "report_host_capabilities",
          args: {
            ...args,
            request_id: randomUUID(),
            context_id: "wrong",
            expected_entity_revision: saved.revisions.evidence,
          },
          now,
        }),
      /observed access context/u,
    );
    const replay = z
      .object({
        operation_result: operations.report_host_capabilities.output,
        receipt: z.object({ replayed: z.boolean() }),
        state: z.unknown().optional(),
      })
      .parse(nativeCall({ op: "operation", root, action: "report_host_capabilities", args, now }));
    assert.equal(replay.receipt.replayed, true);
    assert.equal(replay.state, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
