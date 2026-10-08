import { formatAnswer } from "@goodfinds/contracts/search-definition";
import { firstDiscovery } from "@goodfinds/contracts/listing-discovery";
import type { Listing } from "@goodfinds/contracts/state";
import type { Decision, SavedSearch } from "@goodfinds/contracts/state";
import { money, storage } from "./presentation.ts";

const FACT_LABELS: Record<string, string> = {
  brand: "Brand",
  model: "Model",
  size: "Size",
  colour: "Colour",
  year: "Year",
  mileage: "Mileage",
  bedrooms: "Bedrooms",
  property_type: "Property type",
  accommodation: "Accommodation",
  screen_inches: "Screen size",
  battery_health: "Battery health",
};
const AVAILABILITY: Record<string, string> = {
  active: "Available",
  sold: "Sold",
  reserved: "Reserved",
  removed: "Removed",
  unknown: "Not confirmed",
};

export function listingDetailFacts(listing: Listing, search?: SavedSearch) {
  const facts: { label: string; value: string }[] = [];
  const computer = listing.product === "macbook_pro" || listing.product === "mac_mini";
  if (computer)
    facts.push(
      { label: "Chip", value: listing.chip || "Not stated" },
      { label: "Memory", value: listing.ram_gb == null ? "Not stated" : `${listing.ram_gb} GB` },
      { label: "Storage", value: listing.ssd_gb == null ? "Not stated" : storage(listing.ssd_gb) },
    );
  const keys = new Set([
    ...(listing.product === "rental"
      ? ["bedrooms", "property_type", "accommodation"]
      : ["brand", "model", "size", "colour", "year", "mileage"]),
    ...(search?.definition.comparison_attributes ?? []),
  ]);
  const excluded = new Set([
    "price_minor",
    "currency",
    "price_period",
    "condition",
    "location",
    "drive_minutes",
    "chip",
    "ram_gb",
    "ssd_gb",
    "seller_listing_count",
  ]);
  for (const key of keys) {
    if (excluded.has(key) || key.startsWith("seller_")) continue;
    const value = listing.attributes?.[key];
    if (
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      value === ""
    )
      continue;
    const field = search?.definition.fields.find((item) => item.match?.attribute === key);
    const label =
      FACT_LABELS[key] ??
      field?.label
        .replace(/^(Minimum|Maximum)\s+/iu, "")
        .replace(/^./u, (first) => first.toUpperCase()) ??
      key.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase());
    const formatted =
      key === "accommodation" && value === "whole_property"
        ? "Whole property"
        : field
          ? formatAnswer(field, value)
          : typeof value === "boolean"
            ? value
              ? "Yes"
              : "No"
            : String(value).replaceAll("_", " ");
    if (!facts.some((fact) => fact.label === label)) facts.push({ label, value: formatted });
  }
  facts.push({
    label: "Condition",
    value:
      !listing.condition || listing.condition === "unknown"
        ? "Not stated"
        : listing.condition.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase()),
  });
  if (listing.drive_minutes != null)
    facts.push({ label: "Drive", value: `${listing.drive_minutes} min` });
  facts.push({
    label: "Availability",
    value:
      !listing.availability || listing.availability === "unknown"
        ? "Not confirmed"
        : (AVAILABILITY[listing.availability] ??
          listing.availability.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase())),
  });
  return facts;
}

const COPY: Record<string, string> = {
  "Full asking price needs verification": "Price not confirmed",
  "Full purchase price is unknown or unavailable": "Price not confirmed",
  "Availability is unknown": "Availability not confirmed",
  "Listing is unavailable": "Listing unavailable",
  "Every listing image needs inspection": "Photos still need checking",
  "Working condition needs verification": "Working condition not confirmed",
  "New/used state is unknown": "Condition not confirmed",
  "Laptop screen size needs verification": "Screen size not confirmed",
  "Comparison attributes need verification": "Some details are missing for a price comparison",
  "Travel origin needs confirmation": "Starting location needs confirming",
};

export function friendlyDecisionReasons(decision: Decision, search?: SavedSearch) {
  const reasons: string[] = [];
  for (const reason of decision.reasons) {
    const field = search?.definition.fields.find(
      (item) =>
        reason === item.label + " needs verification" ||
        reason === item.label + " does not meet your requirement",
    );
    if (
      [
        "Driving time from the configured origin is unknown",
        "Journey check time is unknown",
        "Journey source is unknown",
        "Journey estimate needs a fresh check",
      ].includes(reason) ||
      (field?.match?.attribute === "drive_minutes" && reason.endsWith("needs verification"))
    ) {
      reasons.push(
        decision.listing.drive_minutes == null
          ? "Journey time hasn’t been checked"
          : "Journey time needs updating",
      );
      continue;
    }
    if (field?.match && search && reason.endsWith("does not meet your requirement")) {
      const expected = search.values[field.id];
      const actual =
        decision.listing[field.match.attribute] ??
        decision.listing.attributes?.[field.match.attribute];
      if (
        typeof actual === "number" &&
        typeof expected === "number" &&
        ["gte", "lte"].includes(field.match.operator)
      ) {
        const label = field.label.replace(/^(Minimum|Maximum)\s+/u, "").toLowerCase();
        const format = (value: number) =>
          field.match?.attribute === "price_minor"
            ? money(value, decision.listing.currency ?? search.definition.price.currency)
            : formatAnswer(field, value);
        reasons.push(
          format(actual) +
            (field.match.attribute === "price_minor" ? "" : " " + label) +
            "; you asked for " +
            (field.match.operator === "gte" ? "at least " : "up to ") +
            format(expected),
        );
        continue;
      }
    }
    reasons.push(COPY[reason] ?? reason);
  }
  return [...new Set(reasons)];
}

export function listingDiscoveryLabel(
  listing: Pick<Listing, "first_found_runs">,
  searchId?: string,
  timeZone?: string,
) {
  const discovery = firstDiscovery(listing.first_found_runs ?? [], searchId);
  if (!discovery) return undefined;
  const started = new Date(discovery.run_started_at);
  if (!Number.isFinite(started.getTime())) return undefined;
  const day = started.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
  const hour = started
    .toLocaleTimeString("en-GB", {
      hour: "numeric",
      hourCycle: "h12",
      ...(timeZone ? { timeZone } : {}),
    })
    .replace(/\s/gu, "");
  return {
    label: `Found ${day} · ${hour} search`,
    detail: `First found in the search started ${started.toLocaleString("en-GB", timeZone ? { timeZone } : {})}`,
    started_at: discovery.run_started_at,
  };
}
