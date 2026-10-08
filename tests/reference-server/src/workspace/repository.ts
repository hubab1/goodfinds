import type { Revisions } from "@goodfinds/contracts/revisions";
import { Context } from "effect";
import type { Effect } from "effect";
import type { WorkspaceConfiguration } from "./model.ts";
import type { GoodfindsError, StorageError } from "./errors.ts";

export interface WorkspaceStorage {
  readonly ebayCredentialsConfigured: boolean;
  readonly configuration: Effect.Effect<WorkspaceConfiguration, GoodfindsError>;
  readonly revisions: Effect.Effect<Revisions, StorageError>;
  readonly saveConfiguration: (
    config: WorkspaceConfiguration,
  ) => Effect.Effect<void, GoodfindsError>;
}

export class WorkspaceRepository extends Context.Service<WorkspaceRepository, WorkspaceStorage>()(
  "goodfinds/WorkspaceRepository",
) {}
