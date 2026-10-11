import { nativeBinary } from "./helpers/native-driver.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { operations } from "@goodfinds/contracts/operations";
import example from "../skills/marketplace-shopping/assets/example-workspace.json";

const panel = (result: unknown) =>
  z
    .object({
      _meta: z.object({ goodfinds_panel: z.object({ search_id: z.string() }).optional() }),
    })
    .parse(result)._meta.goodfinds_panel;

void test(`native: first search displays its queued run and quiet reads never reopen it`, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "goodfinds-panel-handoff-"));
  const client = new Client({ name: "Panel handoff regression", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: nativeBinary,
      env: { PATH: "", GOODFINDS_WORKSPACE_DIR: root },
    }),
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const listed = (await client.listTools()).tools;
  const meta = z.object({
    ui: z.object({ resourceUri: z.string() }),
    "ui/resourceUri": z.string(),
    "openai/ui": z.unknown().optional(),
  });
  const foreground = meta.parse(
    listed.find((tool) => tool.name === "start_goodfinds_search")?._meta,
  );
  const opener = meta.parse(listed.find((tool) => tool.name === "open_goodfinds_panel")?._meta);
  assert.equal(foreground.ui.resourceUri, opener.ui.resourceUri);
  await Promise.all(
    [foreground, opener].map(async (entry) => {
      assert.equal(entry["ui/resourceUri"], entry.ui.resourceUri);
      const contents = await client.readResource({ uri: entry["ui/resourceUri"] });
      assert.ok(
        contents.contents.length > 0,
        "Both panel metadata forms resolve to the current resource",
      );
    }),
  );
  const resource = await client.readResource({ uri: foreground.ui.resourceUri });
  assert.deepEqual(resource.contents[0]?._meta?.["openai/ui"], {
    availableDisplayModes: ["inline", "fullscreen"],
    preferredDisplayMode: "fullscreen",
  });
  assert.equal(
    foreground["openai/ui"],
    undefined,
    "The argument-taking start tool is not a global entry point",
  );
  for (const name of [
    "request_goodfinds_search_run",
    "request_goodfinds_scheduled_batch",
    "get_goodfinds_workspace",
    "save_goodfinds_search",
    "set_goodfinds_search_cover",
    "import_goodfinds_listing_observations",
  ]) {
    assert.equal(
      meta.safeParse(listed.find((tool) => tool.name === name)?._meta).success,
      false,
      `${name} must not request a panel`,
    );
  }
  const initial = stateFromToolResult(await call("get_goodfinds_workspace"));
  assert.equal(initial.searches.length, 0);
  const saved = await call("save_goodfinds_search", {
    search: { ...example.searches[0], id: "first-search", cover: undefined },
    expected_entity_revision: initial.revisions.absent,
    request_id: crypto.randomUUID(),
    initial_monitoring: { preference: "once" },
  });
  assert.ok(!saved.isError, JSON.stringify(saved));
  assert.equal(panel(saved), undefined);
  const input = {
    request: { search_id: "first-search", request_id: crypto.randomUUID(), trigger: "manual" },
  };
  const started = await call("start_goodfinds_search", input);
  assert.ok(!started.isError, JSON.stringify(started));
  const run = operations.request_search_run.output.parse(started.structuredContent).search_run;
  assert.ok(run);
  assert.equal(run.phase, "requested");
  assert.equal(run.worker, null);
  assert.equal(panel(started)?.search_id, "first-search");
  assert.equal(stateFromToolResult(started).searches[0]?.cover, undefined);
  const repeated = await call("start_goodfinds_search", input);
  assert.equal(
    operations.request_search_run.output.parse(repeated.structuredContent).search_run?.id,
    run.id,
  );
  const reopened = await call("open_goodfinds_panel", { search_id: "first-search" });
  assert.equal(panel(reopened)?.search_id, "first-search");
  assert.equal(stateFromToolResult(reopened).search_runs.length, 1);
  const refreshed = await call("get_goodfinds_workspace", { search_id: "first-search" });
  assert.equal(panel(refreshed), undefined);
  const scheduled = await call("start_goodfinds_search", {
    request: { ...input.request, trigger: "scheduled" },
  });
  assert.equal(scheduled.isError, true, "A scheduled trigger cannot use the foreground tool");
  const missing = await call("start_goodfinds_search", {
    request: { ...input.request, search_id: "missing", request_id: crypto.randomUUID() },
  });
  assert.equal(missing.isError, true);
  assert.equal(stateFromToolResult(await call("get_goodfinds_workspace")).search_runs.length, 1);
});

void test("Panel cache keys change with frontend inputs and ignore filesystem ordering", async () => {
  const { panelResourceUri } = await import("./helpers/../../scripts/panel-resource.ts");
  const old = [
    ["App.tsx", Buffer.from("old markup")],
    ["style.css", Buffer.from("styles")],
  ] as const;
  const changed = [["App.tsx", Buffer.from("new markup")], old[1]] as const;
  assert.notEqual(panelResourceUri(old), panelResourceUri(changed));
  assert.equal(panelResourceUri(old), panelResourceUri(old.toReversed()));
});

void test("Panel cache keys normalize mixed Windows paths before sorting", async () => {
  const { panelResourceInputs, panelResourceUri } = await import("../scripts/panel-resource.ts");
  const inputs = panelResourceInputs();
  const windows = inputs.map(([path, bytes], index): readonly [string, Uint8Array] => [
    index < 9 ? path : path.replaceAll("/", "\\"),
    bytes,
  ]);
  assert.equal(panelResourceUri(windows), panelResourceUri(inputs));
});
