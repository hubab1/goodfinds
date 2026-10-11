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

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

void test("pending alerts survive reads and reopen, page stably while acknowledgements are retried", () => {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-alerts-"));
  const call = (name: string, args: Record<string, unknown>) =>
    z
      .object({ structuredContent: z.unknown() })
      .parse(nativeCall({ op: "tool", root, name, args: { mode: "sample", ...args } }))
      .structuredContent;
  const pending = (args: Record<string, unknown> = {}) =>
    operations.list_pending_alerts.output.parse(call("list_goodfinds_pending_alerts", args));
  const ack = (ids: string[], request_id = randomUUID()) =>
    operations.acknowledge_alerts.output.parse(
      call("acknowledge_goodfinds_alerts", { alert_ids: ids, request_id }),
    );
  try {
    call("load_goodfinds_sample_workspace", {});
    const all = pending();
    assert.ok(all.alerts.length > 1);
    assert.deepEqual(pending().alerts, all.alerts, "a read must not acknowledge presentation");
    const first = pending({ limit: 1 });
    assert.equal(first.alerts.length, 1);
    assert.ok(first.next_cursor);
    const id = required(first.alerts[0]).id;
    const request_id = randomUUID();
    const committed = ack([id], request_id);
    assert.equal(committed.receipt?.replayed, false);
    const replay = ack([id], request_id);
    assert.equal(replay.receipt?.replayed, true);
    assert.deepEqual(replay.alert_ids, [id]);
    assert.deepEqual(
      ack([id]).alert_ids,
      [id],
      "a new acknowledgement of the same presentation is also harmless",
    );
    const rest = pending({ after: first.next_cursor });
    assert.deepEqual(
      rest.alerts.map((a) => a.id),
      all.alerts.slice(1).map((a) => a.id),
    );
    assert.throws(() => ack([required(rest.alerts[0]).id], request_id), /different arguments/u);
    assert.throws(
      () => ack([required(rest.alerts[0]).id, randomUUID()]),
      /pending or already delivered/u,
    );
    assert.equal(
      pending().alerts.length,
      rest.alerts.length,
      "an invalid batch cannot partially acknowledge",
    );
    const db = new Database(resolve(root, "sample/workspace.sqlite"));
    try {
      db.query("UPDATE deal_alerts SET status='withdrawn' WHERE id=?").run(
        required(rest.alerts[0]).id,
      );
      assert.throws(() => ack([required(rest.alerts[0]).id]), /pending or already delivered/u);
    } finally {
      db.close();
    }
    const live = operations.list_pending_alerts.output.parse(
      z.object({ structuredContent: z.unknown() }).parse(
        nativeCall({
          op: "tool",
          root,
          name: "list_goodfinds_pending_alerts",
          args: { mode: "live" },
        }),
      ).structuredContent,
    );
    assert.equal(live.alerts.length, 0, "sample outbox is isolated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("expired listing evidence stays pending for reconciliation but is not offered for delivery", () => {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-alert-expiry-"));
  const now = Date.parse("2026-10-11T12:00:00Z");
  try {
    nativeCall({
      op: "operation",
      root,
      mode: "sample",
      action: "load_sample_workspace",
      args: {},
      now,
    });
    const list = (at: number) =>
      operations.list_pending_alerts.output.parse(
        nativeCall({
          op: "operation",
          root,
          mode: "sample",
          action: "list_pending_alerts",
          args: {},
          now: at,
        }),
      );
    assert.ok(list(now).alerts.length);
    assert.equal(list(now + 365 * 86_400_000).alerts.length, 0);
    assert.ok(list(now).alerts.length, "read-only expiry projection preserves pending records");
    const db = new Database(resolve(root, "sample/workspace.sqlite"));
    try {
      const queued = z
        .object({ id: z.string(), listing_key: z.string() })
        .parse(
          db.query("SELECT id,listing_key FROM deal_alerts WHERE status='pending' LIMIT 1").get(),
        );
      db.query(
        "UPDATE listings SET document_json=json_set(document_json,'$.availability','unavailable') WHERE listing_key=?",
      ).run(queued.listing_key);
      assert.ok(
        !list(now).alerts.some((alert) => alert.id === queued.id),
        "fresh timestamps alone cannot make an unavailable listing deliverable",
      );
      assert.equal(
        z
          .object({ status: z.string() })
          .parse(db.query("SELECT status FROM deal_alerts WHERE id=?").get(queued.id)).status,
        "pending",
        "eligibility projection does not acknowledge or mutate queued intent",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
