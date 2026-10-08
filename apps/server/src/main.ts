import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Effect, Logger } from "effect";
import { errorMessage } from "@goodfinds/contracts/state";
import { createGoodfindsServer } from "./entrypoints/mcp.ts";
import { openPreview } from "./entrypoints/preview.ts";
import { runCli } from "./entrypoints/cli.ts";
import type { TransportError } from "./workspace/errors.ts";
import { storage, transport } from "./workspace/errors.ts";
export { runCli, runCliMain } from "./entrypoints/cli.ts";

export const main = Effect.fn("main")(
  function* (argv: string[]) {
    if (argv.includes("--preview")) {
      const preview = yield* Effect.acquireRelease(openPreview(), ({ shutdown }) =>
        shutdown.pipe(Effect.orDie),
      );
      yield* storage("write preview address", () =>
        process.stdout.write(`Goodfinds panel: ${preview.url}\n`),
      );
      yield* Effect.never;
    } else if (
      [
        "doctor",
        "call",
        "client",
        "demo",
        "export",
        "backup",
        "restore",
        "evaluate",
        "status",
        "ack",
        "--help",
      ].includes(argv[0] ?? "")
    )
      yield* runCli(argv);
    else {
      const { server } = yield* Effect.acquireRelease(
        Effect.sync(() => createGoodfindsServer()),
        (application) => transport(() => application.server.close()).pipe(Effect.orDie),
      );
      yield* Effect.callback<void, TransportError>((resume) => {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- The standard MCP SDK exposes an onclose callback, not EventTarget.
        server.server.onclose = () => resume(Effect.void);
        const end = () => resume(Effect.void);
        process.stdin.once("end", end);
        // MCP transport owns stdio; Effect owns its lifetime and finalization.
        void server
          .connect(new StdioServerTransport())
          .catch((cause: unknown) => resume(transport(() => Promise.reject(cause))));
        return Effect.sync(() => {
          process.stdin.off("end", end);
        });
      });
    }
  },
  Effect.scoped,
  Effect.provideService(Logger.LogToStderr, true),
);
if (import.meta.main)
  BunRuntime.runMain(
    main(process.argv.slice(2)).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          process.stderr.write(
            `Could not complete the request: ${errorMessage(Cause.squash(cause))}\n`,
          );
          process.exitCode = 2;
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
