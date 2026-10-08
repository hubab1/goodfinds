import { z } from "zod";
import type { Listing, SavedSearch } from "./state.ts";

export const listingSeenSchema = z
  .object({
    search_id: z.string(),
    seen_at: z.iso.datetime(),
  })
  .strict();
export type ListingSeen = z.infer<typeof listingSeenSchema>;
export const listingSeenInputSchema = z
  .object({
    listings: z
      .array(z.object({ search_id: z.string().min(1), listing_key: z.string().min(1) }).strict())
      .min(1)
      .max(200),
    seen: z.boolean().default(true),
  })
  .strict();
export type ListingSeenInput = z.infer<typeof listingSeenInputSchema>;

type ReadingListing = Pick<Listing, "product" | "first_found_runs" | "seen_in_searches">;
// Recorded discoveries give each search an independent inbox. Older imports
// without run provenance retain their existing category association.
export function listingSearchIds(
  listing: ReadingListing,
  searches: readonly Pick<SavedSearch, "id" | "product">[],
): string[] {
  const found = listing.first_found_runs;
  return searches
    .filter(
      (search) =>
        search.product === listing.product &&
        (!found?.length || found.some((entry) => entry.search_id === search.id)),
    )
    .map((search) => search.id);
}
export function unseenSearchIds(
  listing: ReadingListing,
  searches: readonly Pick<SavedSearch, "id" | "product">[],
  searchId?: string,
): string[] {
  const seen = new Set(listing.seen_in_searches?.map((entry) => entry.search_id));
  return listingSearchIds(listing, searches).filter(
    (id) => (!searchId || id === searchId) && !seen.has(id),
  );
}
