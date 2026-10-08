import type { ListingSeen, ListingSeenInput } from "@goodfinds/contracts/listing-reading";
import type { ListingDiscovery } from "@goodfinds/contracts/listing-discovery";
import type { SavedSearch, WorkspaceMode } from "@goodfinds/contracts/state";
import { Context } from "effect";
import type { Effect } from "effect";
import type { EvaluationResult } from "./evaluation.ts";
import type { calculateInsights } from "./tracking.ts";
import type {
  ListingObservation,
  SearchCoverage,
  WorkspaceConfiguration,
} from "../workspace/model.ts";
import type { GoodfindsError, StorageError } from "../workspace/errors.ts";

export interface ListingStorage {
  readonly load: (provenance: string) => Effect.Effect<ListingObservation[], GoodfindsError>;
  readonly find: (
    key: string,
    provenance: string,
  ) => Effect.Effect<ListingObservation | undefined, StorageError>;
  readonly discovery: (provenance: string) => Effect.Effect<
    {
      byListing: Map<string, ListingDiscovery[]>;
      counts: Map<string, number>;
      lastSearched: Map<string, string | null>;
    },
    StorageError
  >;
  readonly reading: () => Effect.Effect<Map<string, ListingSeen[]>, StorageError>;
  readonly setSeen: (input: ListingSeenInput, now: number) => Effect.Effect<void, StorageError>;
  readonly historyBatch: (rows: ListingObservation[]) => Effect.Effect<void, StorageError>;
  readonly historyDetails: (row: ListingObservation) => Effect.Effect<void, StorageError>;
  readonly insights: (
    rows: ListingObservation[],
    search: SavedSearch,
    config: WorkspaceConfiguration,
    now: number,
    cohort: (row: ListingObservation, search: SavedSearch) => string | null,
    pricePool?: ListingObservation[],
  ) => Effect.Effect<ReturnType<typeof calculateInsights>, StorageError>;
  readonly evaluations: () => Effect.Effect<
    {
      id: string;
      evaluated_at: string;
      mode: string;
      observed_count: number;
      observations: ListingObservation[];
      search_coverage: SearchCoverage[];
    }[],
    StorageError
  >;
  readonly pendingAlerts: () => Effect.Effect<
    {
      id: string;
      search_id: string;
      listing_key: string;
      price_minor: number;
    }[],
    StorageError
  >;
  readonly withdrawAlert: (id: string) => Effect.Effect<void, StorageError>;
  readonly applyCaptures: (rows: ListingObservation[]) => Effect.Effect<void, StorageError>;
  readonly applyJourneys: (rows: ListingObservation[]) => Effect.Effect<void, StorageError>;
  readonly attachCapture: (
    input: unknown,
    mode: WorkspaceMode,
    now: number,
  ) => Effect.Effect<void, GoodfindsError>;
  readonly recordJourney: (
    input: unknown,
    config: WorkspaceConfiguration,
    rows: ListingObservation[],
    now: number,
  ) => Effect.Effect<void, GoodfindsError>;
  readonly evaluate: (
    config: WorkspaceConfiguration,
    observations: unknown,
    sample: boolean,
    now: number,
    coverage?: unknown,
  ) => Effect.Effect<EvaluationResult, GoodfindsError>;
}

export class ListingRepository extends Context.Service<ListingRepository, ListingStorage>()(
  "goodfinds/ListingRepository",
) {}
