import type { SellerFilters } from "@goodfinds/contracts/listing-query";
export {
  EMPTY_SELLER_FILTERS,
  matchesSellerFilters,
  matchesJoinedYear,
  matchesListingCount,
  listingCountIsFresh,
  sellerFilterError,
} from "@goodfinds/contracts/listing-query";
export type { SellerFilters, ListingCountRange } from "@goodfinds/contracts/listing-query";
import type { Listing } from "@goodfinds/contracts/state";
import type { SearchDefinition } from "@goodfinds/contracts/search-definition";
import { marketplaceUrl } from "./presentation.ts";

export function sellerFilterCount(filters: SellerFilters): number {
  return (
    Number(Boolean(filters.minimumListings)) +
    Number(Boolean(filters.maximumListings)) +
    Number(Boolean(filters.joinedBy))
  );
}

export function normalizeListingLimit(value: string): string {
  return value && Number(value) < 1 ? "" : value;
}

export function sellerFilterChips(filters: SellerFilters) {
  return [
    {
      field: "minimumListings" as const,
      label: `${filters.minimumListings}+ listings`,
      value: filters.minimumListings,
    },
    {
      field: "maximumListings" as const,
      label: `Up to ${filters.maximumListings} listings`,
      value: filters.maximumListings,
    },
    { field: "joinedBy" as const, label: `Joined by ${filters.joinedBy}`, value: filters.joinedBy },
  ].filter((chip) => chip.value);
}

export function joinedLabel(value: string | null | undefined): string {
  if (!value) return "Join date unavailable";
  if (/^\d{4}$/.test(value)) return `Joined Facebook in ${value}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime())
    ? `Joined Facebook ${parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`
    : "Join date unavailable";
}

export function listingCountLabel(listing: Listing): string {
  const count = listing.seller_listing_count;
  if (count == null) return "Listing count unavailable";
  const lowerBound = listing.seller_listing_count_precision === "lower_bound";
  const prefix = listing.seller_listing_count_precision === "approximate" ? "About " : "";
  return `${prefix}${count.toLocaleString("en-GB")}${lowerBound ? "+" : ""} ${count === 1 && !lowerBound ? "listing" : "listings"}`;
}

export function sellerInventorySignal(listing: Listing, now = Date.now()) {
  const review = listing.seller_inventory_review;
  const checked = Date.parse(review?.checked_at ?? "");
  const inspected = new Map(
    review?.listings
      .filter((item) => marketplaceUrl(item.url))
      .map((item) => [item.listing_id, item]),
  );
  if (
    review &&
    review.item_kind === "goods" &&
    listing.product !== "rental" &&
    review.category === listing.product &&
    review.source_url === listing.seller_profile_url &&
    marketplaceUrl(review.source_url) &&
    Number.isFinite(checked) &&
    checked <= now &&
    now - checked <= 30 * 24 * 60 * 60 * 1000 &&
    inspected.size >= 5
  ) {
    return {
      label: "Possible reseller",
      detail: `At least ${inspected.size} similar ${review.category_label} were inspected on this seller’s current profile. A repeated item type can suggest reselling.`,
      checkedAt: review.checked_at,
      evidence: review.evidence,
      listings: [...inspected.values()],
    };
  }
  return undefined;
}

export function withSellerListingField(definition: SearchDefinition): SearchDefinition {
  if (definition.fields.some((field) => field.match?.attribute === "seller_listing_count"))
    return definition;
  // A full custom definition remains editable without adding a thirty-first field.
  if (definition.fields.length >= 30) return definition;
  const ids = new Set(definition.fields.map((field) => field.id));
  let id = "seller_listing_count";
  let suffix = 1;
  while (ids.has(id)) id = `seller_listing_count_${suffix++}`;
  return {
    ...definition,
    version: definition.version + 1,
    fields: [
      ...definition.fields,
      {
        id,
        label: "Seller listing count",
        type: "range",
        required: false,
        question_stage: "refinement",
        minimum: 0,
        hint: "Optional · number of current Marketplace listings. Leave either limit blank. Unavailable counts need checking.",
        match: { attribute: "seller_listing_count", operator: "range", importance: "required" },
      },
    ],
  };
}
