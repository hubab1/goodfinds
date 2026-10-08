import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { stateEnvelopeSchema } from "@goodfinds/contracts/state";
import type { WorkspaceMode } from "@goodfinds/contracts/state";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";
import type { WorkspaceConfiguration } from "../workspace/model.ts";
import { get, close, transaction } from "./sqlite.ts";
import { Effect } from "effect";
import { directory } from "./files.ts";
import { isCommandName, parseOperation } from "@goodfinds/contracts/operations";
import { withReceipt } from "./receipts.ts";
import type { WorkspaceCommandResult } from "./receipts.ts";
import { loadConfiguration } from "./configuration-sqlite.ts";
import { validation } from "../workspace/errors.ts";
export { atomicJson } from "./files.ts";
import * as engineStorage from "./listing-evaluation-sqlite.ts";

export { ACCESS_CONTEXT } from "../workspace/context.ts";
import { workspaceSnapshot } from "../workspace/snapshot.ts";
import { workspaceCommand } from "../workspace/commands.ts";
import { workspaceQuery } from "../workspace/queries.ts";
import { workspaceWorkflowLayer } from "../entrypoints/workspace-layer.ts";

export class WorkspaceStore {
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
  config = Effect.fn("WorkspaceStore.config")(
    { self: this },
    function* (this: WorkspaceStore) {
      const db = yield* Effect.acquireRelease(engineStorage.connect(this.databasePath), close);
      return yield* transaction(db, this.configIn(db));
    },
    Effect.scoped,
  );
  private configIn = (db: Database) => loadConfiguration(db, this.mode);
  snapshot = (db: Database, config?: WorkspaceConfiguration, now?: number) =>
    workspaceSnapshot(this, config, now).pipe(Effect.provide(workspaceWorkflowLayer(db, this)));
  request = Effect.fn("WorkspaceStore.request")(
    { self: this },
    function* (
      this: WorkspaceStore,
      action: string,
      input: unknown = {},
      guard?: (config: WorkspaceConfiguration) => void,
    ) {
      const args: Record<string, unknown> = yield* validation(() => {
        if (!isCommandName(action)) throw new Error("Unsupported action");
        return parseOperation(action, input);
      });
      yield* directory(this.folder);
      const db = yield* Effect.acquireRelease(engineStorage.connect(this.databasePath), close);
      return yield* transaction(
        db,
        withReceipt(db, action, args, workspaceCommand(this, action, args, guard), () =>
          workspaceSnapshot(this),
        ),
      ).pipe(Effect.provide(workspaceWorkflowLayer(db, this)));
    },
    Effect.scoped,
  );
  query = Effect.fn("WorkspaceStore.query")(
    { self: this },
    function* (
      this: WorkspaceStore,
      action: string,
      args: Partial<ListingQuery> & {
        listing_key?: string | undefined;
        progress_only?: boolean | undefined;
        thread_id?: string | undefined;
        dispatcher_id?: string | undefined;
        search_ids?: string[] | undefined;
      },
    ) {
      const db = yield* Effect.acquireRelease(engineStorage.connect(this.databasePath), close);
      const saved = yield* get<{ present: number }>(
        db,
        "SELECT 1 AS present FROM workspace_settings WHERE id=1",
      );
      return yield* transaction(
        db,
        workspaceQuery(this, action, args),
        saved ? "deferred" : "immediate",
      ).pipe(Effect.provide(workspaceWorkflowLayer(db, this)));
    },
    Effect.scoped,
  );
}
export function executeWorkspaceCommand(
  action: string,
  args: unknown,
  mode: WorkspaceMode,
  workspaceDirectory: string,
  automationsDirectory: string | null = null,
  guard?: (config: WorkspaceConfiguration) => void,
) {
  return new WorkspaceStore(workspaceDirectory, mode, automationsDirectory)
    .request(action, args, guard)
    .pipe(
      Effect.flatMap((result) =>
        validation(() => {
          const verified: WorkspaceCommandResult = {
            ...result,
            ...stateEnvelopeSchema.parse(result),
          };
          return verified;
        }),
      ),
    );
}
