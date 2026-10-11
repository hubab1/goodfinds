import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNativeServer } from "./helpers/native-mcp.ts";

void test("Every model-visible MCP tool fits the Agent Plugin catalogue budget", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "goodfinds-catalog-"));
  const { server } = createNativeServer(root);
  const client = new Client({ name: "Catalogue budget regression", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  let total = 0;
  for (const tool of tools) {
    const ui = tool._meta?.["ui"];
    if (
      ui &&
      typeof ui === "object" &&
      "visibility" in ui &&
      Array.isArray(ui.visibility) &&
      !ui.visibility.includes("model")
    )
      continue;
    // Count the unpruned schema and repeated namespace wrapper. This is an
    // upper bound on Codex's normalized spec, without relying on lossy pruning.
    const bytes = Buffer.byteLength(
      JSON.stringify({
        type: "namespace",
        name: "mcp__goodfinds",
        description: client.getInstructions(),
        tools: [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            strict: false,
            parameters: tool.inputSchema,
          },
        ],
      }),
    );
    assert.ok(bytes < 8_000, `${tool.name}: ${bytes} bytes exceeds the per-tool limit`);
    total += bytes;
  }
  assert.ok(total < 60_000, `${total} bytes leaves no room within the 64 KB host limit`);
});

void test("Compact discovery retains the full schema and server validation", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "goodfinds-full-schema-"));
  const { server, toolContracts } = createNativeServer(root);
  const client = new Client({ name: "Full contract regression", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const advertised = (await client.listTools()).tools;
  assert.equal(advertised.length, Object.keys(toolContracts).length);
  const name = "save_goodfinds_search";
  const full = await client.callTool({ name: "get_goodfinds_tool_schema", arguments: { name } });
  assert.deepEqual(full.structuredContent, toolContracts[name]);
  assert.ok(
    JSON.stringify(full.structuredContent).length >
      JSON.stringify(advertised.find((tool) => tool.name === name)?.inputSchema).length,
  );
  assert.equal(
    (
      await client.callTool({
        name: "get_goodfinds_tool_schema",
        arguments: { name: "missing_tool" },
      })
    ).isError,
    true,
  );
  // This field is deliberately opaque in discovery, but its real nested fields
  // and UUID formats must still be checked before any workspace mutation.
  const invalid = await client.callTool({
    name: "claim_goodfinds_search_run",
    arguments: {
      request: {
        run_id: "3b107753-6c9b-49b7-ad9d-aedc8d63f477",
        expected_version: 1,
        worker_id: "3b107753-6c9b-49b7-ad9d-aedc8d63f477",
        agent_id: "/root",
        execution: { profile: "invented-profile" },
      },
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /profile/u);
  const invalidUuid = await client.callTool({
    name: "claim_goodfinds_search_run",
    arguments: {
      request: {
        run_id: "not-a-uuid",
        worker_id: "3b107753-6c9b-49b7-ad9d-aedc8d63f477",
        expected_version: 1,
        agent_id: "/root",
      },
    },
  });
  assert.equal(invalidUuid.isError, true);
});
