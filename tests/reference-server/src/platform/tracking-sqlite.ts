import { applyCachedJourneys } from "./journeys-sqlite.ts";
import type { Database } from "bun:sqlite";
import { iso, parseJson, time } from "../workspace/model.ts";
import type {
  WorkspaceConfiguration,
  SearchCoverage,
  ListingObservation,
} from "../workspace/model.ts";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { all, execute } from "./sqlite.ts";
import { Effect } from "effect";
import { applyCaptures } from "./listing-media-sqlite.ts";
import { FINANCE, rebuildHistory, applyHistory, calculateInsights } from "../listings/tracking.ts";
export const observations = Effect.fnUntraced(function* (db: Database, key?: string) {
  return (yield* all<{
    listing_key: string;
    sequence: number;
    evaluation_id: string;
    data: string;
    evaluated_at: string;
  }>(
    db,
    `SELECT o.listing_key, o.rowid AS sequence, o.evaluation_id, o.document_json AS data, s.evaluated_at FROM listing_observations o JOIN listing_evaluations s ON o.evaluation_id=s.id${key ? " WHERE o.listing_key=?" : ""}`,
    ...(key ? [key] : []),
  ))
    .map((entry) => {
      const row = parseJson<ListingObservation>(entry.data);
      if (
        row.price_kind !== "asking" ||
        (row.product !== "rental" && (row.price_period ?? "once") !== "once")
      )
        row.price_minor = null;
      for (const name of FINANCE) delete row[name];
      const stamp = iso(time(row.observed_at));
      return Object.assign({}, row, {
        key: entry.listing_key,
        observed_at: stamp,
        ingested_at: entry.evaluated_at,
        evaluation_id: entry.evaluation_id,
        observation_sequence: entry.sequence,
        check_outcome: row.check_outcome ?? "success",
      });
    })
    .toSorted(
      (a, b) =>
        time(a.observed_at) - time(b.observed_at) ||
        time(a.ingested_at) - time(b.ingested_at) ||
        (a.observation_sequence ?? 0) - (b.observation_sequence ?? 0),
    );
});
export const recordEvaluation = Effect.fn("recordEvaluation")(function* (
  db: Database,
  rows: ListingObservation[],
  id: string,
  runs: SearchCoverage[],
) {
  for (const row of rows) {
    const rebuilt = rebuildHistory(row.key, yield* observations(db, row.key));
    if (!rebuilt) continue;
    const { current, events } = rebuilt;
    yield* execute(
      db,
      "UPDATE listings SET document_json=?, first_observed_at=?, last_observed_at=? WHERE listing_key=?",
      [JSON.stringify(current), rebuilt.firstObservedAt, rebuilt.lastObservedAt, row.key],
    );
    yield* execute(db, "DELETE FROM listing_events WHERE listing_key=?", [row.key]);
    for (const event of events)
      yield* execute(db, "INSERT OR IGNORE INTO listing_events VALUES (?, ?, ?, ?, ?)", [
        event.id,
        row.key,
        event.kind,
        event.stamp,
        event.data,
      ]);
  }
  for (const [index, run] of runs.entries())
    yield* execute(db, "INSERT INTO search_coverage VALUES (?, ?, ?)", [
      `${id}:${index}`,
      id,
      JSON.stringify(run),
    ]);
});
export const load = Effect.fnUntraced(function* (db: Database, provenance: string) {
  const rows = (yield* all<{
    key: string;
    data: string;
    first_observed_at: string;
    last_observed_at: string;
  }>(
    db,
    "SELECT listing_key AS key,provenance,document_json AS data,first_observed_at,last_observed_at FROM listings WHERE provenance=? ORDER BY rowid",
    provenance,
  )).map((entry) =>
    Object.assign(parseJson<ListingObservation>(entry.data), {
      key: entry.key,
      first_observed_at: entry.first_observed_at,
      last_observed_at: entry.last_observed_at,
    }),
  );
  yield* applyCaptures(db, rows);
  yield* applyCachedJourneys(db, rows);
  const parents = new Map<string, string>();
  const root = (key: string): string => {
    const parent = parents.get(key);
    if (!parent) {
      parents.set(key, key);
      return key;
    }
    if (parent === key) return key;
    const value = root(parent);
    parents.set(key, value);
    return value;
  };
  for (const row of rows) {
    root(row.key);
    for (const relation of row.relationships ?? [])
      if (relation.confidence === "confirmed") {
        const target =
          relation.source === "facebook_marketplace"
            ? `${provenance}:${relation.listing_id}`
            : `${provenance}:${relation.source}:${relation.listing_id}`;
        const left = root(row.key),
          right = root(target);
        parents.set(left > right ? left : right, left < right ? left : right);
      }
  }
  return rows.map((row) => Object.assign(row, { entity_key: root(row.key) }));
});
export const historyDetails = Effect.fnUntraced(function* (db: Database, row: ListingObservation) {
  const events = (yield* all<{ data: string }>(
    db,
    "SELECT document_json AS data FROM listing_events WHERE listing_key=? ORDER BY observed_at DESC, id",
    row.key,
  )).map((entry) => parseJson<NonNullable<ListingObservation["events"]>[number]>(entry.data));
  const history = yield* observations(db, row.key);
  applyHistory(row, history, events);
});
export const historyBatch = Effect.fnUntraced(function* (db: Database, rows: ListingObservation[]) {
  if (!rows.length) return;
  const histories = new Map<string, ListingObservation[]>();
  const keys = new Set(rows.map((row) => row.key));
  for (const row of yield* observations(db)) {
    if (!keys.has(row.key)) continue;
    const group = histories.get(row.key) ?? [];
    group.push(row);
    histories.set(row.key, group);
  }
  const events = new Map<string, NonNullable<ListingObservation["events"]>>();
  for (const entry of yield* all<{ listing_key: string; data: string }>(
    db,
    "SELECT listing_key, document_json AS data FROM listing_events ORDER BY observed_at DESC, id",
  )) {
    if (!keys.has(entry.listing_key)) continue;
    const group = events.get(entry.listing_key) ?? [];
    group.push(parseJson<NonNullable<ListingObservation["events"]>[number]>(entry.data));
    events.set(entry.listing_key, group);
  }
  for (const row of rows)
    applyHistory(row, histories.get(row.key) ?? [], events.get(row.key) ?? []);
});
export const insights = Effect.fnUntraced(function* (
  db: Database,
  rows: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  cohort: (row: ListingObservation, search: SavedSearch) => string | null,
  pricePool: ListingObservation[] = [],
) {
  yield* historyBatch(
    db,
    rows.filter((row) => row.duration === undefined),
  );
  const coverage = (yield* all<{ data: string }>(
    db,
    "SELECT document_json AS data FROM search_coverage ORDER BY rowid",
  )).map((entry) => parseJson<SearchCoverage>(entry.data));
  return calculateInsights(rows, search, config, now, cohort, pricePool, coverage);
});
