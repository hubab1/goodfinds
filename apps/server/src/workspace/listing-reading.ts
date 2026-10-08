import { listingSearchIds, unseenSearchIds } from "@goodfinds/contracts/listing-reading";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type { ListingObservation, WorkspaceConfiguration } from "./model.ts";

export function searchReadingSummary(
  rows: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  lastSearched: string | null,
) {
  const eligible = selectListings(
    { listings: rows, searches: config.searches, config, decisions: [] },
    { search_id: search.id, sellerFilters: EMPTY_SELLER_FILTERS },
  );
  const related = eligible.filter((row) => listingSearchIds(row, [search]).length > 0);
  const unseen_count = related.filter((row) => unseenSearchIds(row, [search]).length > 0).length;
  const discoveries = rows
    .flatMap((row) => {
      const found = row.first_found_runs?.find((entry) => entry.search_id === search.id);
      if (found) return [found.recorded_at ?? found.run_started_at];
      return !row.first_found_runs?.length && row.product === search.product
        ? [row.first_observed_at]
        : [];
    })
    .filter(
      (stamp): stamp is string => typeof stamp === "string" && Number.isFinite(Date.parse(stamp)),
    );
  return {
    unseen_count,
    seen_count: related.length - unseen_count,
    last_searched_at: lastSearched,
    latest_found_at: discoveries.reduce<string | null>(
      (latest, stamp) => (!latest || Date.parse(stamp) > Date.parse(latest) ? stamp : latest),
      null,
    ),
  };
}
