import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

// Ask the actual host loader to discover the packaged server. A direct MCP
// handshake alone cannot catch a manifest the host silently ignores.
const root = resolve(process.argv[2] ?? "dist/goodfinds-marketplace");
const executable = process.argv[3] ?? "codex";
const data = await mkdtemp(resolve(tmpdir(), "goodfinds-host-check-"));
try {
  await cp(root, resolve(data, "plugin"), { recursive: true });
  const marketplace = resolve(data, ".agents/plugins/marketplace.json");
  await mkdir(resolve(data, ".agents/plugins"), { recursive: true });
  await writeFile(
    marketplace,
    JSON.stringify({
      name: "goodfinds-host-check",
      plugins: [
        {
          name: "goodfinds-marketplace",
          source: { source: "local", path: "./plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
  );
  const child = spawn(executable, ["app-server"], {
    cwd: data,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: unknown) => void>();
  lines.on("line", (line) => {
    const parsed = z
      .object({ id: z.number().optional() })
      .loose()
      .safeParse(JSON.parse(line) as unknown);
    if (parsed.success && parsed.data.id !== undefined) replies.get(parsed.data.id)?.(parsed.data);
  });
  async function request(id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`Host check timed out: ${method}`));
      }, 15_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        replies.delete(id);
        reject(error);
      };
      child.once("error", fail);
      replies.set(id, (value) => {
        clearTimeout(timer);
        child.removeListener("error", fail);
        replies.delete(id);
        accept(value);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  try {
    const initialized = await request(1, "initialize", {
      clientInfo: { name: "goodfinds_host_check", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    z.object({ result: z.unknown() }).parse(initialized);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const result = z
      .object({ result: z.object({ plugin: z.object({ mcpServers: z.array(z.string()) }) }) })
      .parse(
        await request(2, "plugin/read", {
          pluginName: "goodfinds-marketplace",
          marketplacePath: marketplace,
        }),
      );
    if (!result.result.plugin.mcpServers.includes("goodfinds"))
      throw new Error("Desktop host loader omitted Goodfinds's packaged MCP server");
    process.stdout.write(
      `${JSON.stringify({ status: "passed", host: executable, server: "goodfinds" })}\n`,
    );
  } finally {
    lines.close();
    child.kill();
  }
} finally {
  await rm(data, { recursive: true, force: true });
}
