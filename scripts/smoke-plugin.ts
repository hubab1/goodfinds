import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { operations } from "@goodfinds/contracts/operations";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { bundledSearchCovers } from "@goodfinds/contracts/search-cover-presets";
import { searchCoverSchema } from "@goodfinds/contracts/search-cover";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { executionPolicy, WORKER_ROUTING_GUIDANCE } from "@goodfinds/contracts/worker-execution";
import { connectionCheckResultSchema } from "@goodfinds/contracts/connection-checks";
import { stateFromToolResult } from "@goodfinds/contracts/state";

const root = resolve(process.argv[2] ?? "dist/goodfinds-marketplace");
const schema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({ command: z.string(), args: z.array(z.string()), cwd: z.string().optional() }),
  ),
});
const portable = schema.parse(
  JSON.parse(await readFile(resolve(root, "mcp.json"), "utf8")) as unknown,
);
const codex = schema.parse(
  JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8")) as unknown,
);
const commands = (servers: typeof codex) =>
  Object.fromEntries(
    Object.entries(servers.mcpServers).map(([name, { command, args }]) => [
      name,
      { command, args },
    ]),
  );
if (JSON.stringify(commands(portable)) !== JSON.stringify(commands(codex)))
  throw new Error("Portable and Codex launch configurations differ");
const reference = await readFile(
  resolve(root, "skills/marketplace-shopping/references/state-model.md"),
  "utf8",
);
const sourceReference = await readFile(
  resolve(import.meta.dir, "../skills/marketplace-shopping/references/state-model.md"),
  "utf8",
);
if (reference !== sourceReference) throw new Error("Packaged state reference differs from source");
const launch = Object.values(codex.mcpServers)[0];
if (!launch) throw new Error("Packaged MCP server missing");
const data = await mkdtemp(resolve(tmpdir(), "goodfinds-package-smoke-"));
const environment = {
  PATH: "",
  HOME: data,
  USERPROFILE: data,
  ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
  GOODFINDS_WORKSPACE_DIR: resolve(data, "workspace"),
};
const client = new Client({ name: "Goodfinds package smoke", version: "1.0.0" });
try {
  // Copy only the executable, so neither repository files nor adjacent assets can rescue it.
  const isolated = resolve(
    data,
    `standalone executable/${process.platform === "win32" ? "goodfinds.exe" : "goodfinds"}`,
  );
  await mkdir(resolve(data, "standalone executable"));
  await copyFile(resolve(root, launch.command), isolated);
  const doctor = z
    .object({
      status: z.literal("ready"),
      panel_resource: z.literal(true),
      context_readable: z.literal(true),
    })
    .parse(
      JSON.parse(
        execFileSync(isolated, ["doctor"], {
          cwd: data,
          env: environment,
          encoding: "utf8",
          timeout: 20_000,
        }),
      ) as unknown,
    );
  await client.connect(
    new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: resolve(root, launch.cwd ?? "."),
      env: environment,
    }),
  );
  if (client.getServerVersion()?.version !== GOODFINDS_VERSION)
    throw new Error("Packaged server version differs from the current plugin release");
  const { tools } = await client.listTools();
  if (!client.getInstructions()?.includes(WORKER_ROUTING_GUIDANCE))
    throw new Error("Packaged server model routing instructions are missing");
  for (const name of [
    "open_goodfinds_panel",
    "get_goodfinds_settings",
    "list_goodfinds_activity",
    "cache_goodfinds_media",
    "get_goodfinds_image",
    "list_goodfinds_search_covers",
    "get_goodfinds_media_file",
    "get_goodfinds_video",
    "get_goodfinds_search_context",
    "request_goodfinds_search_run",
    "check_goodfinds_scheduled_search",
    "get_goodfinds_dispatcher_context",
    "request_goodfinds_scheduled_batch",
    "report_goodfinds_dispatcher_schedule",
    "update_goodfinds_search_run",
    "save_goodfinds_seller_message_draft",
    "set_goodfinds_monitoring",
    "report_goodfinds_host_schedule",
    "start_goodfinds_connection_check",
    "get_goodfinds_connection_check",
    "claim_goodfinds_connection_check",
    "renew_goodfinds_connection_check",
    "complete_goodfinds_connection_check",
    "interrupt_goodfinds_connection_check",
    "cancel_goodfinds_connection_check",
    "claim_goodfinds_search_run",
    "renew_goodfinds_search_lease",
    "cancel_goodfinds_search_run",
  ])
    if (!tools.some((tool) => tool.name === name))
      throw new Error(`Packaged tool missing: ${name}`);
  const imageVisibility = z
    .object({ ui: z.object({ visibility: z.array(z.string()) }) })
    .parse(tools.find((tool) => tool.name === "get_goodfinds_image")?._meta).ui.visibility;
  if (!imageVisibility.includes("model"))
    throw new Error("Saved images must be available to agents");
  const catalog = await client.callTool({ name: "list_goodfinds_search_covers", arguments: {} });
  if (catalog.isError) throw new Error("Packaged search cover catalog failed");
  const covers = z
    .object({ covers: z.array(z.object({ cover: searchCoverSchema })) })
    .parse(catalog.structuredContent).covers;
  if (
    JSON.stringify(covers.map(({ cover }) => cover.media_id).toSorted()) !==
    JSON.stringify(bundledSearchCovers.map(({ image }) => image.media_id).toSorted())
  )
    throw new Error("Packaged search cover catalog differs from source");
  for (const { cover } of covers) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read large stdio image replies one at a time.
    const result = await client.callTool({
      name: "get_goodfinds_image",
      arguments: { media_id: cover.media_id },
    });
    const image = z
      .object({ content: z.array(z.object({ type: z.literal("image"), data: z.string() })) })
      .parse(result).content[0];
    if (
      !image ||
      createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") !==
        cover.media_id
    )
      throw new Error(`Packaged search cover missing or corrupt: ${cover.media_id}`);
  }
  const empty = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: {} }),
  );
  if (empty.searches.length || empty.config.origin_confirmed)
    throw new Error("Fresh live workspaces must not contain demo searches or a confirmed location");
  const example = z
    .object({ searches: z.array(z.unknown()) })
    .parse(
      JSON.parse(
        await readFile(
          resolve(root, "skills/marketplace-shopping/assets/example-workspace.json"),
          "utf8",
        ),
      ),
    );
  const seeded = await client.callTool({
    name: "save_goodfinds_search",
    arguments: { search: example.searches[0], expected_entity_revision: empty.revisions.absent },
  });
  if (seeded.isError) throw new Error("Could not save the first smoke-test search");
  const context = await client.callTool({ name: "get_goodfinds_search_context", arguments: {} });
  if (context.isError) throw new Error("Packaged context read failed");
  const parsed = operations.get_search_context.output.parse(context.structuredContent);
  if (
    !Object.values(parsed.search_workflows).some((view) =>
      view.actions.some(
        (action) =>
          action.execution.profile === "collection" &&
          JSON.stringify(action.execution.spawn) ===
            JSON.stringify(executionPolicy("collection").spawn),
      ),
    )
  )
    throw new Error("Packaged search dispatch model settings are missing");
  const search = parsed.searches[0];
  const sample = stateFromToolResult(
    await client.callTool({ name: "get_goodfinds_workspace", arguments: { mode: "sample" } }),
  );
  const check = await client.callTool({
    name: "start_goodfinds_connection_check",
    arguments: {
      mode: "sample",
      request_id: randomUUID(),
      expected_entity_revision: sample.revisions.settings,
    },
  });
  if (check.isError) throw new Error("Packaged connection-check request failed");
  const checkResult = connectionCheckResultSchema.parse(check.structuredContent);
  if (
    checkResult.run?.status !== "unavailable" ||
    checkResult.run.worker !== null ||
    JSON.stringify(checkResult.execution) !== JSON.stringify(executionPolicy("collection"))
  )
    throw new Error("Packaged connection checks lack worker routing or sample isolation");
  if (!search) throw new Error("Packaged search context lacks a saved search");
  const requested = await client.callTool({
    name: "request_goodfinds_search_run",
    arguments: { request: { search_id: search.id, request_id: randomUUID() } },
  });
  const run = operations.request_search_run.output.parse(requested.structuredContent);
  if (
    !run.search_run ||
    run.workflow.actions.find((a) => a.event === "claim")?.availability !== "requires_input"
  )
    throw new Error("Packaged run guidance is invalid");
  const blocked = await client.callTool({
    name: "update_goodfinds_search_run",
    arguments: {
      request: {
        run_id: run.search_run.id,
        expected_version: run.search_run.version,
        phase: "verifying",
      },
    },
  });
  const failure = operations.update_search_run.wire.parse(blocked.structuredContent);
  if (
    !blocked.isError ||
    !failure.error?.blockers?.some((b) => b.code === "category_query_unchecked")
  )
    throw new Error("Packaged guard blockers are missing");

  const resource = await client.readResource({
    uri: z
      .object({ ui: z.object({ resourceUri: z.string() }) })
      .parse(tools.find((tool) => tool.name === "open_goodfinds_panel")?._meta).ui.resourceUri,
  });
  if (!resource.contents.length) throw new Error("Packaged panel missing");
  process.stdout.write(
    `${JSON.stringify({ status: "passed", root, tools: tools.length, context: "readable", panel: "readable", search_covers: covers.length, state_model: "packaged", workflow_guards: "checked", path: "empty", standalone_doctor: doctor.status, executable_bytes: (await stat(isolated)).size })}\n`,
  );
} finally {
  await client.close();
  await rm(data, { recursive: true, force: true });
}
