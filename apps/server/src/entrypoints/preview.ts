import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Cause, Effect } from "effect";
import { z } from "zod";
import { createGoodfindsServer } from "./mcp.ts";
import { Backend } from "./backend.ts";
import { WORKSPACE_DIRECTORY } from "../platform/runtime.ts";
import { TransportError, ValidationError, transport, validation } from "../workspace/errors.ts";

const previewInput = z.object({ name: z.string(), arguments: z.unknown().optional() });
function readBody(req: IncomingMessage) {
  return Effect.callback<string, TransportError | ValidationError>((resume) => {
    let body = "";
    const data = (chunk: Buffer | string) => {
      body += chunk.toString();
      if (body.length > 2_000_000)
        resume(Effect.fail(new ValidationError({ message: "Too much data" })));
    };
    const end = () => resume(Effect.succeed(body));
    const error = (cause: Error) =>
      resume(Effect.fail(new TransportError({ message: cause.message, cause })));
    const aborted = () => resume(Effect.fail(new TransportError({ message: "Request cancelled" })));
    req.on("data", data).once("end", end).once("error", error).once("aborted", aborted);
    return Effect.sync(() => {
      req.off("data", data).off("end", end).off("error", error).off("aborted", aborted);
    });
  });
}
function listen(http: Server, port: number) {
  return Effect.callback<void, TransportError>((resume) => {
    const error = (cause: Error) =>
      resume(Effect.fail(new TransportError({ message: cause.message, cause })));
    // Bun can both throw and emit an error for a failed listen. Keep the listener
    // with this server so the queued event remains handled after acquisition fails.
    http.on("error", error);
    try {
      http.listen(port, "127.0.0.1", () => resume(Effect.void));
    } catch (cause) {
      error(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}
function closeHttp(http: Server) {
  return transport(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!http.listening) {
          resolve();
          return;
        }
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  );
}
export const openPreview = Effect.fn("openPreview")(function* (
  workspaceDirectory: string = WORKSPACE_DIRECTORY,
  port: number = Number(process.env["GOODFINDS_PORT"] || 0),
  handoff?: { mode: "live" | "sample"; revision: string; lifetime_ms?: number },
) {
  yield* validation(() => {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Use a valid preview port");
  });
  const { server, effects, runtime } = yield* Effect.sync(() =>
    createGoodfindsServer(workspaceDirectory),
  );
  const token = yield* Effect.sync(() => randomBytes(32).toString("hex"));
  const path = handoff ? `/location/${token}` : "/";
  const expires = Date.now() + (handoff?.lifetime_ms ?? 5 * 60_000);
  let consumed = false;
  const http = createServer((req, res) => {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", abort);
    const program = handleRequest(req, res).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          if (!res.headersSent) res.writeHead(500);
          if (!res.destroyed) res.end("Could not complete that action");
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          res.off("close", abort);
        }),
      ),
    );
    // Node HTTP requires a callback; the request workflow runs in the shared Effect runtime.
    void runtime.runPromise(program, { signal: controller.signal }).catch(() => {
      if (!res.destroyed) res.end();
    });
  });
  const addressPort = () => {
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Goodfinds has not started");
    return address.port;
  };
  const handleRequest = Effect.fn("handleRequest")(function* (
    req: IncomingMessage,
    res: ServerResponse,
  ) {
    const listeningPort = yield* validation(addressPort);
    const origin = `http://127.0.0.1:${listeningPort}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (
      req.headers.host !== `127.0.0.1:${listeningPort}` ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.writeHead(403);
      res.end("This panel is available only on your device.");
      return;
    }
    if (handoff && (consumed || Date.now() > expires)) {
      res.writeHead(410);
      res.end("This location request has expired. Reopen location from Goodfinds.");
      return;
    }
    if (req.method === "GET" && req.url === path) {
      const backend = yield* Backend;
      const html = (yield* backend.panel).replace(
        "<head>",
        `<head><script>window.__GOODFINDS_PREVIEW__={token:${JSON.stringify(token)}${handoff ? `,locationOnly:true,workspaceMode:${JSON.stringify(handoff.mode)}` : ""}};</script>`,
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://ipwho.is https://api.bigdatacloud.net https://api.postcodes.io https://api.zippopotam.us; img-src data:; media-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.end(html);
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/api/tool" &&
      req.headers["x-goodfinds-token"] === token
    ) {
      yield* Effect.gen(function* () {
        const body = yield* readBody(req);
        const input = yield* validation(() => previewInput.parse(JSON.parse(body) as unknown));
        if (handoff) {
          const args = z
            .object({
              mode: z.enum(["live", "sample"]).optional(),
              expected_entity_revision: z.string().optional(),
              settings: z.object({ location: z.unknown() }).strict().optional(),
            })
            .strict()
            .parse(input.arguments ?? {});
          if (
            !["get_goodfinds_workspace", "save_goodfinds_settings"].includes(input.name) ||
            args.mode !== handoff.mode ||
            (input.name === "save_goodfinds_settings" &&
              (args.expected_entity_revision !== handoff.revision || !args.settings))
          ) {
            res.writeHead(403);
            res.end(
              "This one-use page can only save the requested location. Reopen it if settings changed.",
            );
            return;
          }
        }
        const call = effects.get(input.name);
        if (!call) {
          res.writeHead(400);
          res.end("Unknown action");
          return;
        }
        const result = yield* call(input.arguments || {});
        if (handoff && input.name === "save_goodfinds_settings" && !result.isError) consumed = true;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause);
            const tooLarge = error instanceof ValidationError && error.message === "Too much data";
            res.writeHead(tooLarge ? 413 : 400);
            res.end(tooLarge ? "Too much data" : "Could not complete that action");
          }),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  const shutdown = closeHttp(http).pipe(
    Effect.ensuring(transport(() => server.close()).pipe(Effect.orDie)),
  );
  yield* listen(http, port).pipe(Effect.onError(() => shutdown.pipe(Effect.orDie)));
  // Also support callers that close the returned Node server directly.
  http.once("close", () => {
    void server.close().catch(() => {});
  });
  return { http, url: `http://127.0.0.1:${addressPort()}${path}`, shutdown };
});
// Promise adapter for native HTTP clients; main owns openPreview through a Scope.
export function startPreview(
  workspaceDirectory: string = WORKSPACE_DIRECTORY,
  port = Number(process.env["GOODFINDS_PORT"] || 0),
) {
  return Effect.runPromise(openPreview(workspaceDirectory, port));
}
