import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { Context } from "effect";
import type { Effect } from "effect";
import type { StorageError } from "../workspace/errors.ts";

export interface SearchRunStorage {
  readonly list: (
    searchId?: string,
    limit?: number | null,
  ) => Effect.Effect<SearchRun[], StorageError>;
  readonly find: (id: string) => Effect.Effect<SearchRun | undefined, StorageError>;
  readonly latestScheduled: (
    searchId: string,
  ) => Effect.Effect<SearchRun | undefined, StorageError>;
  readonly save: (run: SearchRun) => Effect.Effect<void, StorageError>;
  readonly saveIfVersion: (
    run: SearchRun,
    version: number,
  ) => Effect.Effect<SearchRun | undefined, StorageError>;
  readonly recordDiscoveries: (
    run: SearchRun,
    listingKeys: string[],
    now: number,
  ) => Effect.Effect<void, StorageError>;
}

export class SearchRunRepository extends Context.Service<SearchRunRepository, SearchRunStorage>()(
  "goodfinds/SearchRunRepository",
) {}
