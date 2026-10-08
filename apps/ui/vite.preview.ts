import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { createGoodfindsServer } from "@goodfinds/server/mcp";

// Development uses the same local tools as the packaged panel, with a token and origin checks.
export function localTools(): Plugin {
  const token = randomBytes(32).toString("hex");
  let application: ReturnType<typeof createGoodfindsServer> | undefined;
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
      await application?.server.close();
    },
    configureServer(server) {
      application = createGoodfindsServer();
      const { calls } = application;
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
          .object({ name: z.string(), arguments: z.unknown().optional() })
          .parse(JSON.parse(body) as unknown);
        const call = calls.get(input.name);
        if (!call) {
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
          result = await call(input.arguments ?? {}, controller.signal);
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
