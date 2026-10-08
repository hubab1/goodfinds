import { z } from "zod";
import { listingSearchIds, unseenSearchIds } from "./listing-reading.ts";
import { appliesToSearch, modelIsExcluded } from "./discovery.ts";
import type { Listing, Decision } from "./state.ts";
import type { FeedbackEvent } from "./discovery.ts";
import type { SavedSearch } from "./state.ts";

export const listingQuerySchema = z
  .object({
    search_id: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    seller_filters: z
      .object({
        minimum_listings: z.number().int().min(1).optional(),
        maximum_listings: z.number().int().min(1).optional(),
        joined_by: z.number().int().min(1900).max(9999).optional(),
      })
      .strict()
      .refine(
        (filters) =>
          filters.minimum_listings === undefined ||
          filters.maximum_listings === undefined ||
          filters.minimum_listings <= filters.maximum_listings,
        "Maximum must be at least the minimum.",
      )
      .optional(),
    result_type: z.enum(["all", "promising", "good_deals"]).default("all"),
    seen: z.enum(["all", "unseen", "seen"]).default("all"),
    include_dismissed: z.boolean().default(false),
    include_excluded: z.boolean().default(false),
    sort: z
      .enum(["recent", "recommended", "price_low", "price_high", "found_newest", "found_oldest"])
      .default("recent"),
  })
  .strict();
export type ListingQuery = z.infer<typeof listingQuerySchema>;

export function querySellerFilters(query: Pick<ListingQuery, "seller_filters">): SellerFilters {
  return {
    minimumListings: query.seller_filters?.minimum_listings?.toString() ?? "",
    maximumListings: query.seller_filters?.maximum_listings?.toString() ?? "",
    joinedBy: query.seller_filters?.joined_by?.toString() ?? "",
  };
}

type SellerFilterListing = Pick<
  Listing,
  | "seller_account_joined_at"
  | "seller_listing_count"
  | "seller_listing_count_precision"
  | "seller_listings_checked_at"
  | "seller_profile_url"
  | "evidence"
>;
type SelectableListing = SellerFilterListing &
  Pick<
    Listing,
    | "attributes"
    | "evidence"
    | "key"
    | "product"
    | "price_minor"
    | "currency"
    | "price_period"
    | "last_observed_at"
    | "first_observed_at"
    | "observed_at"
    | "first_found_runs"
    | "seen_in_searches"
  >;

export function selectListings<L extends SelectableListing>(
  state: {
    listings: L[];
    searches: (Pick<SavedSearch, "id" | "product"> & Partial<Pick<SavedSearch, "discovery">>)[];
    config: { feedback: FeedbackEvent[] };
    decisions: (Pick<Decision, "search_id" | "status" | "suitability" | "preference_score"> & {
      listing: Pick<Listing, "key">;
    })[];
  },
  options: {
    search_id?: string | undefined;
    sellerFilters: SellerFilters;
    result_type?: ListingQuery["result_type"];
    seen?: ListingQuery["seen"];
    include_dismissed?: boolean;
    include_excluded?: boolean;
    sort?: ListingQuery["sort"];
  },
  now = Date.now(),
): L[] {
  const search = state.searches.find((item) => item.id === options.search_id);
  const decisions = state.decisions.filter((item) => !search || item.search_id === search.id);
  const byListing = new Map<string, typeof decisions>();
  for (const decision of decisions) {
    const group = byListing.get(decision.listing.key) ?? [];
    group.push(decision);
    byListing.set(decision.listing.key, group);
  }
  const preference = (key: string) =>
    Math.max(0, ...(byListing.get(key) ?? []).map((item) => item.preference_score ?? 0));
  return state.listings
    .filter((listing) => {
      if (search && listing.product !== search.product) return false;
      if (options.seen && options.seen !== "all") {
        if (!listingSearchIds(listing, search ? [search] : state.searches).length) return false;
        const unseen =
          unseenSearchIds(listing, search ? [search] : state.searches, search?.id).length > 0;
        if ((options.seen === "unseen") !== unseen) return false;
      }
      if (!matchesSellerFilters(listing, options.sellerFilters, now)) return false;
      if (
        !options.include_dismissed &&
        listingIsDismissed(listing, search ? [search] : state.searches, state.config.feedback)
      )
        return false;
      const related = (search ? [search] : state.searches).filter(
        (item) => item.product === listing.product,
      );
      if (
        !options.include_excluded &&
        related.length &&
        related.every((item) => modelIsExcluded({ ...listing }, item, state.config.feedback))
      )
        return false;
      const matches = byListing.get(listing.key) ?? [];
      if (options.result_type === "good_deals")
        return matches.some((item) => item.status === "qualifies");
      if (options.result_type === "promising")
        return matches.some((item) =>
          item.suitability
            ? item.suitability !== "unsuitable"
            : ["qualifies", "not_deal", "insufficient_comparables"].includes(item.status),
        );
      return true;
    })
    .toSorted((a, b) => {
      if (options.sort === "recommended") return preference(b.key) - preference(a.key);
      if (options.sort === "price_low" || options.sort === "price_high") {
        // Unknown and differently denominated amounts have no comparable numeric order.
        if (a.price_minor == null || b.price_minor == null)
          return Number(a.price_minor == null) - Number(b.price_minor == null);
        const cohort = `${a.currency ?? ""}:${a.price_period ?? "once"}`.localeCompare(
          `${b.currency ?? ""}:${b.price_period ?? "once"}`,
        );
        return (
          cohort ||
          (options.sort === "price_low"
            ? a.price_minor - b.price_minor
            : b.price_minor - a.price_minor)
        );
      }
      if (options.sort === "found_newest" || options.sort === "found_oldest") {
        // Rechecking a listing must not change when it was first found.
        const foundA = Date.parse(a.first_observed_at ?? a.observed_at ?? "");
        const foundB = Date.parse(b.first_observed_at ?? b.observed_at ?? "");
        if (!Number.isFinite(foundA) || !Number.isFinite(foundB))
          return (
            Number(!Number.isFinite(foundA)) - Number(!Number.isFinite(foundB)) ||
            a.key.localeCompare(b.key)
          );
        return (
          (options.sort === "found_newest" ? foundB - foundA : foundA - foundB) ||
          a.key.localeCompare(b.key)
        );
      }
      return (
        Date.parse(b.last_observed_at ?? b.observed_at ?? "") -
          Date.parse(a.last_observed_at ?? a.observed_at ?? "") || a.key.localeCompare(b.key)
      );
    });
}

export type ListingCountRange = { min?: number; max?: number };

export type SellerFilters = {
  minimumListings: string;
  maximumListings: string;
  joinedBy: string;
};

export const EMPTY_SELLER_FILTERS: SellerFilters = {
  minimumListings: "",
  maximumListings: "",
  joinedBy: "",
};

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function sellerFilterError(
  filters: SellerFilters,
  currentYear = new Date().getFullYear(),
): string {
  const counts = [filters.minimumListings, filters.maximumListings].filter(Boolean).map(Number);
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 1))
    return "Use a whole number of 1 or more, or leave it as Any.";
  if (
    filters.minimumListings &&
    filters.maximumListings &&
    Number(filters.minimumListings) > Number(filters.maximumListings)
  )
    return "Maximum must be at least the minimum.";
  if (
    filters.joinedBy &&
    (!/^\d{4}$/.test(filters.joinedBy) ||
      Number(filters.joinedBy) < 1900 ||
      Number(filters.joinedBy) > currentYear)
  )
    return "Choose a year up to the current year.";
  return "";
}

export function matchesJoinedYear(
  value: string | null | undefined,
  by: string,
): boolean | undefined {
  if (!by) return true;
  if (!value) return undefined;
  const yearOnly = /^\d{4}$/.test(value);
  if (!yearOnly && !validDate(value)) return undefined;
  return Number(value.slice(0, 4)) <= Number(by);
}

export function matchesSellerFilters(
  listing: SellerFilterListing,
  filters: SellerFilters,
  now = Date.now(),
): boolean {
  if (sellerFilterError(filters, new Date(now).getUTCFullYear())) return false;
  const range = {
    ...(filters.minimumListings ? { min: Number(filters.minimumListings) } : {}),
    ...(filters.maximumListings ? { max: Number(filters.maximumListings) } : {}),
  };
  return (
    matchesListingCount(listing, range, now) === true &&
    matchesJoinedYear(listing.seller_account_joined_at, filters.joinedBy) === true
  );
}

export function listingCountIsFresh(listing: SellerFilterListing, now = Date.now()): boolean {
  const checked = Date.parse(listing.seller_listings_checked_at ?? "");
  const excerpt = listing.evidence?.["seller_listing_count"];
  return (
    listing.seller_listing_count != null &&
    Boolean(listing.seller_profile_url) &&
    typeof excerpt === "string" &&
    Boolean(excerpt.trim()) &&
    Number.isFinite(checked) &&
    checked <= now &&
    now - checked <= 30 * 24 * 60 * 60 * 1000
  );
}

// Undefined means the evidence cannot establish whether the count fits the range.
export function matchesListingCount(
  listing: SellerFilterListing,
  range: ListingCountRange,
  now = Date.now(),
): boolean | undefined {
  if (range.min === undefined && range.max === undefined) return true;
  if (!listingCountIsFresh(listing, now) || listing.seller_listing_count == null) return undefined;
  const count = listing.seller_listing_count;
  if (listing.seller_listing_count_precision === "exact")
    return (
      (range.min === undefined || count >= range.min) &&
      (range.max === undefined || count <= range.max)
    );
  if (listing.seller_listing_count_precision === "lower_bound") {
    if (range.max !== undefined && count > range.max) return false;
    if (range.max === undefined && (range.min === undefined || count >= range.min)) return true;
  }
  return undefined;
}

export function listingIsDismissed(
  listing: Pick<Listing, "key" | "product">,
  searches: Pick<SavedSearch, "id" | "product">[],
  feedback: FeedbackEvent[],
): boolean {
  const related = searches.filter((search) => search.product === listing.product);
  // A search-specific dismissal must not hide a listing from another search.
  return (
    related.length > 0 &&
    related.every(
      (search) =>
        feedback.findLast(
          (event) => event.listing_key === listing.key && appliesToSearch(event, search),
        )?.action === "dismiss",
    )
  );
}
