import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Development calls the native MCP executable, with the same local token and origin checks.
export function localTools(): Plugin {
  const token = randomBytes(32).toString("hex");
  const client = new Client({ name: "Goodfinds UI development", version: "0.1.0" });
  return {
    name: "goodfinds-local-tools",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          children: `window.__GOODFINDS_PREVIEW__={token:${JSON.stringify(token)}};`,
          injectTo: "head-prepend",
        },
      ];
    },
    async closeBundle() {
      await client.close();
    },
    async configureServer(server) {
      const executable = resolve(
        import.meta.dir,
        "../../dist/build/server",
        process.platform === "win32" ? "goodfinds.exe" : "goodfinds",
      );
      if (!existsSync(executable))
        throw new Error("Build the native server first with bun run build.");
      await client.connect(
        new StdioClientTransport({
          command: executable,
          args: [],
          stderr: "inherit",
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        }),
      );
      const tools = new Set((await client.listTools()).tools.map((tool) => tool.name));
      async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const address = server.httpServer?.address();
        if (!address || typeof address === "string")
          throw new Error("Development server is unavailable");
        const host = `127.0.0.1:${address.port}`;
        if (
          req.method !== "POST" ||
          req.headers.host !== host ||
          (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          req.headers["x-goodfinds-token"] !== token
        ) {
          res.writeHead(403);
          res.end("This panel is available only on your device.");
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2_000_000) {
            res.writeHead(413);
            res.end("Too much data");
            return;
          }
        }
        const input = z
          .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
          .parse(JSON.parse(body) as unknown);
        if (!tools.has(input.name)) {
          res.writeHead(400);
          res.end("Unknown action");
          return;
        }
        const controller = new AbortController();
        const cancel = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.once("close", cancel);
        let result;
        try {
          result = await client.callTool(
            { name: input.name, arguments: input.arguments ?? {} },
            undefined,
            { signal: controller.signal },
          );
        } finally {
          res.off("close", cancel);
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(result));
      }
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/tool") {
          next();
          return;
        }
        void respond(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(400);
          res.end("Could not complete that action");
        });
      });
    },
  };
}
