import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import contracts from "../../apps/server/data/contracts.json";
import { nativeBinary, nativeCall, nativeContext, NativeError } from "./native-driver.ts";
export { stateToolResult } from "./native-workspace.ts";

export type NativeOptions = {
  automationsDirectory?: string | null;
  readDeviceBrowser?: (() => Promise<{ id: string; name: string } | null>) | undefined;
};
export const nativeOptions = (
  _root: string,
  automationsDirectory: string | null = null,
  readDeviceBrowser?: NativeOptions["readDeviceBrowser"],
): NativeOptions => ({ automationsDirectory, readDeviceBrowser });
// The protocol path is a transport relay to the actual native MCP server.
// Direct calls use the same Rust service through the synchronous fixture driver.
export function createNativeServer(directory?: string, options: NativeOptions = {}) {
  const root = directory ?? mkdtempSync(resolve(tmpdir(), "goodfinds-native-"));
  let peer: Transport | undefined;
  let child: StdioClientTransport | undefined;
  const server = {
    async connect(transport: Transport) {
      peer = transport;
      child = new StdioClientTransport({
        command: nativeBinary,
        env: {
          PATH: process.env["PATH"] ?? "",
          GOODFINDS_WORKSPACE_DIR: root,
          GOODFINDS_TEST_AUTOMATIONS: options.automationsDirectory ?? "",
          GOODFINDS_TEST_BROWSER: JSON.stringify((await options.readDeviceBrowser?.()) ?? null),
        },
        stderr: "pipe",
      });
      const native = child;
      // MCP Transport exposes callback properties, not DOM event listeners.
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      native.onmessage = (message) => {
        void transport.send(message);
      };
      // eslint-disable-next-line unicorn/prefer-add-event-listener
      transport.onmessage = (message) => {
        void native.send(message);
      };
      await native.start();
      await transport.start();
    },
    async close() {
      await child?.close();
      await peer?.close();
      if (!directory) rmSync(root, { recursive: true, force: true });
    },
  };
  const calls = new Map<string, (args: unknown, signal?: AbortSignal) => Promise<CallToolResult>>();
  for (const tool of contracts.tools)
    calls.set(tool.name, async (args, signal) => {
      signal?.throwIfAborted();
      try {
        return CallToolResultSchema.parse(
          nativeCall({
            op: "tool",
            root,
            context: nativeContext,
            name: tool.name,
            args,
            automationsDirectory: options.automationsDirectory,
            browser: (await options.readDeviceBrowser?.()) ?? null,
          }),
        );
      } catch (error) {
        if (!(error instanceof NativeError)) throw error;
        return {
          isError: true,
          structuredContent: { error: error.details },
          content: [{ type: "text", text: JSON.stringify({ error: error.details }) }],
        };
      }
    });
  return { server, calls, toolContracts: contracts.tool_contracts };
}
