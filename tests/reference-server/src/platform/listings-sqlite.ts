import type { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { ListingRepository } from "../listings/repository.ts";
import { parseJson } from "../workspace/model.ts";
import type { ListingObservation, SearchCoverage } from "../workspace/model.ts";
import * as tracking from "./tracking-sqlite.ts";
import { all, execute, get } from "./sqlite.ts";
import { readingSummary, setListingsSeen } from "./listing-reading-sqlite.ts";
import { discoverySummary } from "./listing-discovery-sqlite.ts";
import { applyCaptures, attachCapture } from "./listing-media-sqlite.ts";
import { applyCachedJourneys, recordJourney } from "./journeys-sqlite.ts";
import { evaluateObservations } from "./listing-evaluation-sqlite.ts";

export const listingStorageLayer = (db: Database, databasePath: string) =>
  Layer.succeed(ListingRepository, {
    load: (provenance) => tracking.load(db, provenance),
    find: (key, provenance) =>
      get<{ data: string }>(
        db,
        "SELECT document_json AS data FROM listings WHERE listing_key=? AND provenance=?",
        key,
        provenance,
      ).pipe(
        Effect.map((entry) => (entry ? parseJson<ListingObservation>(entry.data) : undefined)),
      ),
    discovery: (provenance) => discoverySummary(db, provenance),
    reading: () => readingSummary(db),
    setSeen: (input, now) => setListingsSeen(db, input, now),
    historyBatch: (rows) => tracking.historyBatch(db, rows),
    historyDetails: (row) => tracking.historyDetails(db, row),
    insights: (rows, search, config, now, cohort, pool) =>
      tracking.insights(db, rows, search, config, now, cohort, pool),
    evaluations: Effect.fnUntraced(function* () {
      const evaluations = yield* all<{
        id: string;
        evaluated_at: string;
        mode: string;
        observed_count: number;
      }>(
        db,
        "SELECT id, evaluated_at, mode, observed_count FROM listing_evaluations ORDER BY evaluated_at DESC LIMIT 30",
      );
      return yield* Effect.forEach(evaluations, (entry) =>
        Effect.gen(function* () {
          const observations = (yield* all<{ data: string }>(
            db,
            "SELECT document_json AS data FROM listing_observations WHERE evaluation_id=?",
            entry.id,
          )).map((row) => parseJson<ListingObservation>(row.data));
          const search_coverage = (yield* all<{ data: string }>(
            db,
            "SELECT document_json AS data FROM search_coverage WHERE evaluation_id=?",
            entry.id,
          )).map((row) => parseJson<SearchCoverage>(row.data));
          return { ...entry, observations, search_coverage };
        }),
      );
    }),
    pendingAlerts: () =>
      all<{ id: string; search_id: string; listing_key: string; price_minor: number }>(
        db,
        "SELECT id, search_id, listing_key, price_minor FROM deal_alerts WHERE status='pending'",
      ),
    withdrawAlert: (id) =>
      execute(db, "UPDATE deal_alerts SET status='withdrawn' WHERE id=?", [id]).pipe(Effect.asVoid),
    applyCaptures: (rows) => applyCaptures(db, rows),
    applyJourneys: (rows) => applyCachedJourneys(db, rows),
    attachCapture: (input, mode, now) => attachCapture(db, input, mode, now),
    recordJourney: (input, config, rows, now) => recordJourney(db, input, config, rows, now),
    evaluate: (config, observations, sample, now, coverage = null) =>
      evaluateObservations(config, observations, databasePath, sample, now, coverage, db),
  });
