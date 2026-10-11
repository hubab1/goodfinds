import { currencyDivisor } from "@goodfinds/contracts/regional";
import { isMarketplaceUrl, MARKETPLACES } from "@goodfinds/contracts/integrations";
export function money(minor: number | null | undefined, currency = "GBP"): string {
  const divisor = currencyDivisor(currency);
  return minor == null
    ? "Unknown price"
    : new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: minor % divisor ? Math.log10(divisor) : 0,
      }).format(minor / divisor);
}
export function storage(gb: number | null | undefined): string {
  if (gb == null) return "Unknown storage";
  return gb >= 1000 ? `${gb / 1000} TB` : `${gb} GB`;
}
export function date(value: string | null | undefined): string {
  if (!value) return "Not checked yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Unknown date"
    : parsed.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function facebookUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function marketplaceUrl(value: string | null | undefined): string | undefined {
  return value && isMarketplaceUrl(value) ? value : undefined;
}
export function sourceName(source: string | undefined): string {
  return (
    MARKETPLACES.find((m) => m.id === (source ?? "facebook_marketplace"))?.name ?? "Marketplace"
  );
}
export function evidenceText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "Unknown");
}
import type { Listing } from "@goodfinds/contracts/state";

export function listingSummary(listing: Listing): string {
  if (listing.product === "macbook_pro" || listing.product === "mac_mini")
    return `${listing.chip ?? "Unknown chip"} · ${listing.ram_gb ?? "Unknown"} GB memory · ${storage(listing.ssd_gb)} SSD`;
  if (listing.product === "rental") {
    const attributes = listing.attributes ?? {};
    const accommodation = attributes["accommodation"];
    return (
      [
        attributes["area"],
        typeof attributes["bedrooms"] === "number"
          ? `${attributes["bedrooms"]} bedrooms`
          : undefined,
        attributes["property_type"],
        accommodation === "whole_property"
          ? "Whole property"
          : accommodation === "private_room"
            ? "Private room"
            : accommodation === "shared_room"
              ? "Shared room"
              : undefined,
      ]
        .filter((value): value is string => typeof value === "string")
        .join(" · ") || "Property details need verification"
    );
  }
  return listing.description ?? "Details need verification";
}

export function pricePeriod(period: string | null | undefined): string {
  return period === "month" ? " / month" : period === "week" ? " / week" : "";
}
