import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { listingDiscoverySchema } from "@goodfinds/contracts/listing-discovery";
import type { ListingDiscovery } from "@goodfinds/contracts/listing-discovery";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import { all, execute } from "./sqlite.ts";
import { iso } from "../workspace/model.ts";

export const recordDiscoveries = Effect.fnUntraced(function* (
  db: Database,
  run: SearchRun,
  keys: string[],
  now: number,
) {
  for (const key of new Set(keys)) {
    yield* execute(
      db,
      `INSERT INTO listing_search_discoveries (listing_key,search_id,run_id,run_started_at,recorded_at) VALUES (?,?,?,?,?) ON CONFLICT(listing_key,search_id) DO UPDATE SET run_id=excluded.run_id,run_started_at=excluded.run_started_at,recorded_at=excluded.recorded_at WHERE julianday(excluded.run_started_at)<julianday(listing_search_discoveries.run_started_at)`,
      [key, run.search_id, run.id, run.created_at, iso(now)],
    );
  }
});

export const discoverySummary = Effect.fnUntraced(function* (db: Database, provenance: string) {
  const rows = yield* all<{
    listing_key: string;
    search_id: string;
    run_id: string;
    run_started_at: string;
    recorded_at: string | null;
  }>(
    db,
    `SELECT discovery.* FROM listing_search_discoveries AS discovery JOIN listings ON listings.listing_key=discovery.listing_key WHERE listings.provenance=?`,
    provenance,
  );
  const byListing = new Map<string, ListingDiscovery[]>();
  const counts = new Map<string, number>();
  // A run with no results has a real zero, even when another search shares its category.
  const searches = yield* all<{ search_id: string; last_searched_at: string | null }>(
    db,
    `SELECT search_id,MAX(COALESCE(
      json_extract(document_json,'$.started_at'),
      json_extract(document_json,'$.worker.claimed_at'),
      json_extract(document_json,'$.first_result_at'),
      CASE WHEN json_extract(document_json,'$.phase')='completed'
        OR EXISTS (SELECT 1 FROM json_each(search_runs.document_json,'$.queries') AS query
          WHERE json_extract(query.value,'$.status')<>'planned')
      THEN json_extract(document_json,'$.created_at') END
    )) AS last_searched_at FROM search_runs GROUP BY search_id`,
  );
  const lastSearched = new Map(
    searches.map((search) => [search.search_id, search.last_searched_at]),
  );
  for (const search of searches) counts.set(search.search_id, 0);
  for (const row of rows) {
    const discovery = listingDiscoverySchema.parse({
      search_id: row.search_id,
      run_id: row.run_id,
      run_started_at: row.run_started_at,
      recorded_at: row.recorded_at,
    });
    const list = byListing.get(row.listing_key) ?? [];
    list.push(discovery);
    byListing.set(row.listing_key, list);
    counts.set(row.search_id, (counts.get(row.search_id) ?? 0) + 1);
  }
  return { byListing, counts, lastSearched };
});
