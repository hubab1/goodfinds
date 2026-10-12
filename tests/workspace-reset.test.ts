import { Database } from "bun:sqlite";
import { dispatcherArgs } from "./helpers/dispatcher.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createNativeServer } from "./helpers/native-mcp.ts";
import { seedWorkspace } from "./helpers/workspace.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { operations } from "@goodfinds/contracts/operations";

void test("reset previews counts, fences stale confirmation, preserves sample data and replays without deleting new work", async (t) => {
  const root = seedWorkspace(mkdtempSync(resolve(tmpdir(), "goodfinds-reset-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { calls } = createNativeServer(root);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const fn = calls.get(name);
    assert.ok(fn);
    return fn(args);
  }
  const state = stateFromToolResult(await call("get_goodfinds_workspace"));
  const before = operations.preview_workspace_reset.output.parse(
    (await call("preview_goodfinds_workspace_reset")).structuredContent,
  );
  assert.ok(before.counts["saved_searches"]);
  assert.equal(before.ready, true);
  mkdirSync(resolve(root, "media"), { recursive: true });
  mkdirSync(resolve(root, "sample/media"), { recursive: true });
  writeFileSync(resolve(root, "media/test-media"), "real cached media");
  writeFileSync(resolve(root, "sample/media/keep"), "sample media");
  const stale = await call("reset_goodfinds_workspace", {
    reset_token: before.reset_token,
    confirmation: "delete_all_goodfinds_data",
    request_id: randomUUID(),
  });
  assert.equal(stale.isError, true);
  assert.ok(existsSync(resolve(root, "media/test-media")));
  const preview = operations.preview_workspace_reset.output.parse(
    (await call("preview_goodfinds_workspace_reset")).structuredContent,
  );
  assert.equal(preview.media_files, 1);
  const input = {
    reset_token: preview.reset_token,
    confirmation: "delete_all_goodfinds_data",
    request_id: randomUUID(),
  };
  const reset = await call("reset_goodfinds_workspace", input);
  assert.equal(reset.isError, undefined, JSON.stringify(reset.content));
  const receipt = operations.reset_workspace.output.parse(reset.structuredContent);
  assert.equal(receipt.reset.media_cleanup_complete, true);
  const empty = stateFromToolResult(reset);
  assert.equal(empty.searches.length, 0);
  assert.equal(empty.listings.length, 0);
  assert.equal(empty.seller_conversations.length, 0);
  assert.equal(existsSync(resolve(root, "media/test-media")), false);
  assert.ok(existsSync(resolve(root, "sample/media/keep")));
  const saved = await call("save_goodfinds_search", {
    search: state.config.searches[0],
    expected_entity_revision: empty.revisions.absent,
  });
  assert.equal(saved.isError, undefined);
  const replay = await call("reset_goodfinds_workspace", input);
  assert.equal(replay.isError, undefined);
  assert.equal(
    stateFromToolResult(replay).searches.length,
    1,
    "Retry must not delete newly saved data",
  );
  assert.equal(
    operations.reset_workspace.output.parse(replay.structuredContent).receipt?.replayed,
    true,
  );
});

void test("reset refuses active work and host schedules, and restores media after a failed transaction", async (t) => {
  const root = seedWorkspace(mkdtempSync(resolve(tmpdir(), "goodfinds-reset-guards-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const automations = resolve(root, "host/automations");
  mkdirSync(automations, { recursive: true });
  const { calls } = createNativeServer(root, { automationsDirectory: automations });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const fn = calls.get(name);
    assert.ok(fn);
    return fn(args);
  }
  const read = async () => stateFromToolResult(await call("get_goodfinds_workspace"));
  const preview = async () =>
    operations.preview_workspace_reset.output.parse(
      (await call("preview_goodfinds_workspace_reset")).structuredContent,
    );
  const remove = async () => {
    const p = await preview();
    return call("reset_goodfinds_workspace", {
      request_id: randomUUID(),
      reset_token: p.reset_token,
      confirmation: "delete_all_goodfinds_data",
    });
  };
  let state = await read();
  const search = state.searches[0];
  assert.ok(search);
  const requested = operations.request_search_run.output.parse(
    (
      await call("request_goodfinds_search_run", {
        request: { search_id: search.id, request_id: randomUUID() },
      })
    ).structuredContent,
  ).search_run;
  assert.ok(requested);
  assert.ok((await preview()).active_run_ids.includes(requested.id));
  assert.equal((await remove()).isError, true);
  await call("cancel_goodfinds_search_run", { request: { run_id: requested.id } });
  state = await read();
  await call("set_goodfinds_monitoring", {
    expected_entity_revision: state.revisions.monitoring[search.id] ?? state.revisions.absent,
    monitoring: { search_id: search.id, preference: "recurring" },
  });
  state = await read();
  const automationId = "reset-fixture";
  const thread = "00000000-0000-4000-8000-000000000003";
  const linked = await call(
    "report_goodfinds_dispatcher_schedule",
    dispatcherArgs(state, [search.id], {
      automation_id: automationId,
      thread_id: thread,
      status: "active",
      evidence: "Fixture host schedule",
    }),
  );
  assert.equal(linked.isError, undefined, JSON.stringify(linked.content));
  const folder = resolve(automations, automationId);
  mkdirSync(folder);
  writeFileSync(
    resolve(folder, "automation.toml"),
    `id = "${automationId}"
kind = "heartbeat"
status = "ACTIVE"
rrule = "FREQ=HOURLY;INTERVAL=2"
target_thread_id = "${thread}"
`,
  );
  assert.equal((await preview()).schedule_cleanup[0]?.automation_id, automationId);
  assert.equal((await remove()).isError, true);
  rmSync(folder, { recursive: true });
  assert.equal((await preview()).ready, true);
  mkdirSync(resolve(root, "media"));
  writeFileSync(resolve(root, "media/keep"), "keep on rollback");
  const db = new Database(resolve(root, "workspace.sqlite"));
  db.run(
    "CREATE TRIGGER reject_test_reset BEFORE DELETE ON saved_searches BEGIN SELECT RAISE(ABORT,'fixture reset failure'); END",
  );
  assert.equal((await remove()).isError, true);
  assert.ok(existsSync(resolve(root, "media/keep")), "SQL rollback restores staged files");
  db.run("DROP TRIGGER reject_test_reset");
  db.close();
  // Simulate a process exiting after staging files but before committing SQLite.
  renameSync(resolve(root, "media"), resolve(root, `.reset-media-${randomUUID()}`));
  await read();
  assert.ok(existsSync(resolve(root, "media/keep")), "Reopening restores uncommitted staged files");
  assert.equal((await remove()).isError, undefined);
});
