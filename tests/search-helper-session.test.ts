import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import { seedWorkspace } from "./helpers/workspace.ts";

const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() });
const binary = nativeBinary;

void test("independent native helper calls preserve ownership and enforce cancellation", async (t) => {
  const folder = seedWorkspace(await mkdtemp(resolve(tmpdir(), "goodfinds-helper-session-")));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const input = resolve(folder, `${randomUUID()}.json`);
    await writeFile(input, JSON.stringify(args));
    const process = Bun.spawn([binary, "call", name, "--input", input], {
      env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    assert.equal(code, 0, stderr);
    return envelope.parse(JSON.parse(stdout));
  };
  const context = operations.get_search_context.output.parse(
    (await call("get_goodfinds_search_context", {})).structuredContent,
  );
  const search = context.searches[0];
  assert.ok(search);
  const requestedResult = operations.request_search_run.output.parse(
    (
      await call("request_goodfinds_search_run", {
        request: { search_id: search.id, request_id: randomUUID(), trigger: "manual" },
      })
    ).structuredContent,
  );
  const requested = requestedResult.search_run;
  assert.ok(requested);
  assert.deepEqual(
    requestedResult.workflow.actions.find((action) => action.event === "claim")?.execution,
    { profile: "browser_collection", spawn: { fork_turns: "none" } },
    "The packaged server must use the same browser dispatch policy as the reference model",
  );
  const worker = randomUUID();
  const execution = { profile: "browser_collection", model: "Fixture browser model" };
  const claimed = operations.claim_search_run.output.parse(
    (
      await call("claim_goodfinds_search_run", {
        request: {
          run_id: requested.id,
          expected_version: requested.version,
          worker_id: worker,
          agent_id: "helper-fixture",
          execution,
        },
      })
    ).structuredContent,
  ).search_run;
  assert.equal(claimed?.worker?.id, worker);
  const renewed = operations.renew_search_lease.output.parse(
    (
      await call("renew_goodfinds_search_lease", {
        request: { run_id: requested.id, worker_id: worker },
      })
    ).structuredContent,
  ).search_run;
  assert.ok(renewed);
  assert.equal(renewed.worker?.id, worker);
  assert.deepEqual(renewed.worker?.execution, execution);
  assert.equal(renewed.phase, claimed?.phase);
  const query = renewed.queries[0];
  assert.ok(query);
  const request = {
    run_id: requested.id,
    expected_version: renewed.version,
    worker_id: worker,
    phase: "discovering",
    query: { ...query, status: "completed", result_count: 0, unique_relevant_count: 0 },
  };
  assert.equal(
    (
      await call("update_goodfinds_search_run", {
        request: { ...request, worker_id: randomUUID() },
      })
    ).isError,
    true,
  );
  const updated = operations.update_search_run.output.parse(
    (await call("update_goodfinds_search_run", { request })).structuredContent,
  ).search_run;
  assert.equal(updated?.queries.find((q) => q.id === query.id)?.status, "completed");
  assert.equal(updated?.worker?.id, worker);
  const cancelled = operations.cancel_search_run.output.parse(
    (await call("cancel_goodfinds_search_run", { request: { run_id: requested.id } }))
      .structuredContent,
  ).search_run;
  assert.equal(cancelled?.phase, "cancelled");
  assert.equal(
    (
      await call("renew_goodfinds_search_lease", {
        request: { run_id: requested.id, worker_id: worker },
      })
    ).isError,
    true,
    "A new helper process must not revive a cancelled worker",
  );
});
