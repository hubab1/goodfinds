import { resolve } from "node:path";
import { Effect } from "effect";
import type { WorkspaceMode } from "@goodfinds/contracts/state";
import exampleConfig from "../../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import { validateConfiguration } from "../../apps/server/src/listings/evaluation.ts";
import { saveConfiguration } from "../../apps/server/src/platform/configuration-sqlite.ts";
import { close, get, openDatabase, transaction } from "../../apps/server/src/platform/sqlite.ts";

// Workflow tests opt into fictional searches; production workspaces start empty.
export function seedWorkspace(base: string, mode: WorkspaceMode = "live"): string {
  if (mode === "sample") return base;
  Effect.runSync(
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        openDatabase(resolve(base, "workspace.sqlite")),
        close,
      );
      yield* transaction(
        db,
        Effect.gen(function* () {
          const saved = yield* get(db, "SELECT 1 FROM workspace_settings WHERE id=1");
          if (!saved) yield* saveConfiguration(db, yield* validateConfiguration(exampleConfig));
        }),
      );
    }).pipe(Effect.scoped),
  );
  return base;
}
