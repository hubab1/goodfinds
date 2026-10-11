import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { operations, executionSchema } from "@goodfinds/contracts/operations";
import type { QueryName, OperationResult } from "@goodfinds/contracts/operations";
import { stateSchema } from "@goodfinds/contracts/state";
import type { GoodfindsState, WorkspaceMode } from "@goodfinds/contracts/state";
import { workspaceConfigurationSchema } from "@goodfinds/contracts/workspace-schema";
import type { WorkspaceConfiguration } from "@goodfinds/contracts/workspace-schema";
import { nativeCall, nativeEffect, nativeContext } from "./native-driver.ts";

export class NativeWorkspace {
  readonly folder: string;
  readonly databasePath: string;
  readonly base: string;
  readonly mode: WorkspaceMode;
  readonly automationsDirectory: string | null;
  constructor(
    base: string,
    mode: WorkspaceMode = "live",
    automationsDirectory: string | null = null,
  ) {
    this.base = base;
    this.mode = mode;
    this.automationsDirectory = automationsDirectory;
    this.folder = resolve(base, mode === "sample" ? "sample" : ".");
    this.databasePath = resolve(this.folder, "workspace.sqlite");
  }
  private input = () => ({
    root: this.base,
    mode: this.mode,
    context: nativeContext,
    automationsDirectory: this.automationsDirectory,
  });
  config = () =>
    nativeEffect({ ...this.input(), op: "config" }).pipe(
      Effect.map((v) => workspaceConfigurationSchema.parse(v)),
    );
  request = (action: string, args: unknown = {}) =>
    Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      const raw = yield* nativeEffect({ ...this.input(), op: "operation", action, args, now });
      const result = z.record(z.string(), z.unknown()).parse(raw);
      // These domain fixtures explicitly inspect panel state after commands.
      // Production worker renewals return only their resource result.
      if (!result["state"])
        result["state"] = yield* nativeEffect({ ...this.input(), op: "snapshot", now });
      return z
        .object({
          state: stateSchema,
          execution: executionSchema.optional(),
          scheduled_check: z.object({ allowed: z.boolean(), reason: z.string() }).optional(),
        })
        .loose()
        .parse(result);
    });
  query = <K extends QueryName>(action: K, args: Record<string, unknown>) =>
    Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* nativeEffect({ ...this.input(), op: "operation", action, args, now });
    }).pipe(
      Effect.map((value) =>
        z
          .custom<OperationResult<K>>((item) => operations[action].output.safeParse(item).success)
          .parse(value),
      ),
    );
  snapshot = (_db: Database, _config?: WorkspaceConfiguration, now?: number) =>
    nativeEffect({ ...this.input(), op: "snapshot", now }).pipe(
      Effect.map((v) => stateSchema.parse(v)),
    );
}
export const stateToolResult = (result: { state: GoodfindsState; [key: string]: unknown }) =>
  CallToolResultSchema.parse(nativeCall({ op: "state_result", args: result }));
export const backupWorkspace = (database: string, output: string) =>
  nativeEffect({ op: "backup", args: { database, output } });
export const restoreWorkspace = (input: string, output: string) =>
  nativeEffect({ op: "restore", args: { input, output } });
export const saveConfiguration = (db: Database, config: WorkspaceConfiguration) =>
  nativeEffect({ op: "save_config", root: dirname(db.filename), args: config });
export const initializeWorkspaceDatabase = (db: Database) =>
  nativeCall({ op: "initialize", path: db.filename });
export const WORKSPACE_SCHEMA_VERSION = 1;
