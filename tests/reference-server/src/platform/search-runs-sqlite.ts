import type { Database } from "bun:sqlite";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { searchRunSchema } from "@goodfinds/contracts/search-workflow";
import { Effect, Layer } from "effect";
import { SearchRunRepository } from "../searches/repository.ts";
import { parseJson } from "../workspace/model.ts";
import { all, execute, get } from "./sqlite.ts";
import { recordDiscoveries } from "./listing-discovery-sqlite.ts";

type StoredSearchRun = { data: string; worker_data: string | null };
const select =
  "SELECT search_runs.document_json AS data, search_run_workers.document_json AS worker_data FROM search_runs LEFT JOIN search_run_workers ON search_run_workers.run_id=search_runs.id";

function decode(entry: StoredSearchRun): SearchRun {
  return searchRunSchema.parse({
    ...parseJson<Record<string, unknown>>(entry.data),
    worker: entry.worker_data ? parseJson<unknown>(entry.worker_data) : null,
  });
}

function document(run: SearchRun): string {
  const { worker: _worker, ...data } = run;
  return JSON.stringify(data);
}

// The workspace supplies the connection so all domains participate in the same transaction.
export const searchRunStorageLayer = (db: Database) => {
  const find = (id: string) =>
    get<StoredSearchRun>(db, `${select} WHERE search_runs.id=?`, id).pipe(
      Effect.map((entry) => (entry ? decode(entry) : undefined)),
    );
  return Layer.succeed(SearchRunRepository, {
    list: (searchId, limit = 50) =>
      all<StoredSearchRun>(
        db,
        `${select}${searchId === undefined ? "" : " WHERE search_id=?"} ORDER BY search_runs.updated_at DESC, search_runs.rowid DESC${limit === null ? "" : " LIMIT ?"}`,
        ...(searchId === undefined ? [] : [searchId]),
        ...(limit === null ? [] : [limit]),
      ).pipe(Effect.map((entries) => entries.map(decode))),
    find,
    latestScheduled: (searchId) =>
      get<StoredSearchRun>(
        db,
        `${select} WHERE search_id=? AND json_extract(search_runs.document_json,'$.scheduled_at') IS NOT NULL ORDER BY json_extract(search_runs.document_json,'$.scheduled_at') DESC,search_runs.rowid DESC LIMIT 1`,
        searchId,
      ).pipe(Effect.map((entry) => (entry ? decode(entry) : undefined))),
    save: Effect.fnUntraced(function* (run: SearchRun) {
      yield* execute(
        db,
        "INSERT INTO search_runs (id, search_id, document_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json, updated_at=excluded.updated_at",
        [run.id, run.search_id, document(run), run.updated_at],
      );
      if (run.worker)
        yield* execute(
          db,
          "INSERT INTO search_run_workers (run_id,document_json) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET document_json=excluded.document_json",
          [run.id, JSON.stringify(run.worker)],
        );
      else yield* execute(db, "DELETE FROM search_run_workers WHERE run_id=?", [run.id]);
    }),
    saveIfVersion: Effect.fnUntraced(function* (run: SearchRun, version: number) {
      yield* execute(
        db,
        "UPDATE search_runs SET document_json=?, updated_at=? WHERE id=? AND json_extract(document_json, '$.version')=?",
        [document(run), run.updated_at, run.id, version],
      );
      return yield* find(run.id);
    }),
    recordDiscoveries: (run, listingKeys, now) => recordDiscoveries(db, run, listingKeys, now),
  });
};
