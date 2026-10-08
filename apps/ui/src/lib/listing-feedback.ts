export { listingIsDismissed } from "@goodfinds/contracts/listing-query";

export const DISREGARD_REASONS = [
  "Exclude this model from this search",
  "Too expensive",
  "Too far away",
  "Condition isn’t right",
  "Missing parts or accessories",
  "Seller concerns",
  "Other",
] as const;
