import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { ListingSeenInput, ListingSeen } from "@goodfinds/contracts/listing-reading";
import { all, execute } from "./sqlite.ts";
import { iso } from "../workspace/model.ts";

export const readingSummary = Effect.fnUntraced(function* (db: Database) {
  const rows = yield* all<{ listing_key: string; search_id: string; seen_at: string }>(
    db,
    "SELECT listing_key,search_id,seen_at FROM listing_seen",
  );
  const byListing = new Map<string, ListingSeen[]>();
  for (const row of rows) {
    const entries = byListing.get(row.listing_key) ?? [];
    entries.push({ search_id: row.search_id, seen_at: row.seen_at });
    byListing.set(row.listing_key, entries);
  }
  return byListing;
});
export const setListingsSeen = Effect.fnUntraced(function* (
  db: Database,
  input: ListingSeenInput,
  now: number,
) {
  for (const entry of input.listings) {
    if (input.seen)
      yield* execute(
        db,
        "INSERT INTO listing_seen (listing_key,search_id,seen_at) VALUES (?,?,?) ON CONFLICT(listing_key,search_id) DO NOTHING",
        [entry.listing_key, entry.search_id, iso(now)],
      );
    else
      yield* execute(db, "DELETE FROM listing_seen WHERE listing_key=? AND search_id=?", [
        entry.listing_key,
        entry.search_id,
      ]);
  }
});
