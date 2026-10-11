import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { searchCoverSchema } from "@goodfinds/contracts/search-cover";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { seedWorkspace } from "./helpers/workspace.ts";

void test(
  `native preserves claimed work across cover edits but stops changed criteria`,
  { timeout: 30000 },
  async (t) => {
    const folder = seedWorkspace(await mkdtemp(resolve(tmpdir(), "goodfinds-cover-run-")));
    const client = new Client({ name: "Cover run test", version: "1" });
    t.after(async () => {
      await client.close();
      await rm(folder, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: nativeBinary,
        args: [],
        env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result;
    };
    const initial = stateFromToolResult(await call("get_goodfinds_workspace", {}));
    const search = initial.config.searches[0];
    assert.ok(search);
    const started = operations.request_search_run.output.parse(
      (
        await call("request_goodfinds_search_run", {
          request: { search_id: search.id, request_id: randomUUID() },
        })
      ).structuredContent,
    ).search_run;
    assert.ok(started);
    const worker = randomUUID();
    const claimed = operations.claim_search_run.output.parse(
      (
        await call("claim_goodfinds_search_run", {
          request: {
            run_id: started.id,
            expected_version: started.version,
            worker_id: worker,
            agent_id: "fixture-cover-worker",
          },
        })
      ).structuredContent,
    ).search_run;
    assert.ok(claimed);
    const query = claimed.queries[0];
    assert.ok(query);
    const progress = operations.update_search_run.output.parse(
      (
        await call("update_goodfinds_search_run", {
          request: {
            run_id: started.id,
            expected_version: claimed.version,
            worker_id: worker,
            phase: "discovering",
            query: { ...query, status: "completed", result_count: 0, unique_relevant_count: 0 },
          },
        })
      ).structuredContent,
    ).search_run;
    assert.ok(progress);
    const covers = z
      .object({ covers: z.array(z.object({ cover: searchCoverSchema })) })
      .parse((await call("list_goodfinds_search_covers", {})).structuredContent);
    const cover = covers.covers[0]?.cover;
    assert.ok(cover);
    let revision = initial.revisions.searches[search.id];
    let currentRun: SearchRun = progress;
    const editCover = async (selected: z.infer<typeof searchCoverSchema> | null) => {
      const reply = await call("set_goodfinds_search_cover", {
        search_id: search.id,
        expected_entity_revision: revision,
        cover: selected,
      });
      const preserved: SearchRun | undefined = stateFromToolResult(reply).search_runs.find(
        (run) => run.id === started.id,
      );
      assert.equal(preserved?.version, currentRun.version);
      assert.deepEqual(
        preserved?.worker,
        currentRun.worker,
        "A cover edit must not renew the lease",
      );
      const edited = operations.set_search_cover.output.parse(reply.structuredContent);
      revision = edited.revisions.searches[search.id];
      const renewed: SearchRun | null = operations.renew_search_lease.output.parse(
        (
          await call("renew_goodfinds_search_lease", {
            request: { run_id: started.id, worker_id: worker },
          })
        ).structuredContent,
      ).search_run;
      assert.ok(renewed);
      assert.equal(renewed.worker?.id, worker);
      assert.equal(renewed.phase, progress.phase);
      assert.deepEqual(renewed.queries, progress.queries);
      currentRun = renewed;
    };
    await editCover(cover);
    await editCover(null);
    const changed = await call("save_goodfinds_search", {
      expected_entity_revision: revision,
      search: { ...search, values: { ...search.values, max_price_minor: 99900 } },
    });
    await call("set_goodfinds_search_cover", {
      search_id: search.id,
      expected_entity_revision: operations.save_search.output.parse(changed.structuredContent)
        .revisions.searches[search.id],
      cover,
    });
    const stale = await client.callTool({
      name: "renew_goodfinds_search_lease",
      arguments: { request: { run_id: started.id, worker_id: worker } },
    });
    assert.equal(stale.isError, true, "Real buying changes must still invalidate the old worker");
  },
);
