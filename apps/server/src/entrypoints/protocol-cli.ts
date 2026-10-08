import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { SERVER_ARGUMENTS } from "../platform/runtime.ts";
import { z } from "zod";
import { errorMessage } from "@goodfinds/contracts/state";

const requestSchema = z
  .object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) })
  .strict();
const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Keep a single standard MCP session alive for fallback calls and its access-context identity.
export async function protocolCli(command: string, tool?: string, input?: string) {
  const client = new Client({ name: "Goodfinds protocol helper", version: "0.11.4" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: SERVER_ARGUMENTS,
    stderr: "inherit",
    env: Object.fromEntries(
      [
        "PATH",
        "CODEX_HOME",
        "GOODFINDS_WORKSPACE_DIR",
        "GOODFINDS_EBAY_CLIENT_ID",
        "GOODFINDS_EBAY_CLIENT_SECRET",
      ].flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  });
  try {
    await client.connect(transport);
    if (command === "doctor") {
      const { tools } = await client.listTools();
      const panel = tools.find((item) => item.name === "open_goodfinds_panel");
      const metadata = z.object({ ui: z.object({ resourceUri: z.string() }) }).parse(panel?._meta);
      const resource = await client.readResource({ uri: metadata.ui.resourceUri });
      const context = await client.callTool({
        name: "get_goodfinds_search_context",
        arguments: {},
      });
      if (context.isError) throw new Error("Goodfinds context could not be read");
      return {
        status: "ready",
        tools: tools.length,
        panel_resource: resource.contents.length > 0,
        context_readable: true,
        native_questions: "Host-dependent; helper uses the resumable chat fallback",
        next_step:
          "If tools are missing in Codex, check the plugin MCP connection and open a fresh chat after installation. Use client for a persistent fallback session.",
      };
    }
    if (command === "call") {
      if (!tool || !input) throw new Error("Use call TOOL --input FILE");
      const args = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile(input, "utf8")) as unknown);
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        structuredContent: result.structuredContent,
        content: result.content,
        isError: result.isError,
      };
    }
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = requestSchema.parse(JSON.parse(line) as unknown);
          const result = await client.callTool(request);
          reply({
            structuredContent: result.structuredContent,
            content: result.content,
            isError: result.isError,
          });
        } catch (error) {
          reply({ isError: true, error: errorMessage(error) });
        }
      }
    } finally {
      lines.close();
    }
    return undefined;
  } finally {
    await client.close();
  }
}
