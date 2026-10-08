import { z } from "zod";
import type { Listing, SavedSearch } from "./state.ts";
import { modelIsExcluded } from "./model-feedback.ts";
import { listingIsDismissed } from "./listing-query.ts";
import type { FeedbackEvent } from "./discovery.ts";

const DAY = 86_400_000;
export const journeyReportSchema = z
  .object({
    origin_key: z.string().min(1).max(1000),
    destination: z.string().trim().min(1).max(300),
    country: z.string().trim().max(100).nullable(),
    listing_keys: z.array(z.string()).min(1).max(500),
    drive_minutes: z.number().int().nonnegative().max(10080),
    precision: z.literal("town").default("town"),
    estimate_kind: z.enum(["traffic", "typical"]).default("traffic"),
    source_url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        /^(www\.)?google\.(com|co\.uk)$/u.test(url.hostname) &&
        url.pathname.startsWith("/maps/dir")
      );
    }, "Use the Google Maps directions URL actually checked"),
    evidence: z.string().trim().min(1).max(2000),
    checked_at: z.iso.datetime(),
  })
  .strict();
export type JourneyReport = z.infer<typeof journeyReportSchema>;
export const journeyEstimateSchema = journeyReportSchema.omit({ listing_keys: true }).extend({
  expires_at: z.iso.datetime(),
});
export type JourneyEstimate = z.infer<typeof journeyEstimateSchema>;
export type JourneyOrigin = {
  origin: string;
  origin_confirmed?: boolean | undefined;
  journey_checks_enabled?: boolean | undefined;
  location?:
    | { latitude: number | null; longitude: number | null; country: string }
    | null
    | undefined;
};
export function journeyOriginKey(config: JourneyOrigin): string {
  return JSON.stringify([
    config.origin.trim(),
    config.location?.latitude ?? null,
    config.location?.longitude ?? null,
    config.location?.country ?? null,
  ]);
}
export function journeyDestinationKey(
  destination: string,
  country: string | null | undefined,
): string {
  return JSON.stringify([
    destination.trim().toLowerCase().replace(/\s+/gu, " "),
    country?.trim().toLowerCase() ?? null,
  ]);
}
export function journeyLifetime(kind: JourneyReport["estimate_kind"]): number {
  return kind === "typical" ? 7 * DAY : DAY;
}
export function journeyFresh(
  estimate: JourneyEstimate,
  config: JourneyOrigin,
  row: Pick<Listing, "location"> & { [key: string]: unknown },
  now: number,
): boolean {
  return (
    estimate.origin_key === journeyOriginKey(config) &&
    journeyDestinationKey(estimate.destination, estimate.country) ===
      journeyDestinationKey(
        row.location ?? "",
        typeof row["country"] === "string" ? row["country"] : config.location?.country,
      ) &&
    Date.parse(estimate.checked_at) <= now &&
    Date.parse(estimate.expires_at) > now
  );
}
export function journeyQueue(
  rows: (Pick<
    Listing,
    | "key"
    | "product"
    | "location"
    | "attributes"
    | "evidence"
    | "drive_minutes"
    | "travel_source"
    | "travel_checked_at"
    | "journey_estimate"
  > & { [key: string]: unknown })[],
  searches: SavedSearch[],
  feedback: FeedbackEvent[],
  config: JourneyOrigin,
  now: number,
) {
  const groups = new Map<
    string,
    { destination: string; country: string | null; listing_keys: string[]; maps_url: string }
  >();
  if (config.journey_checks_enabled === false || config.origin_confirmed !== true) return [];
  for (const row of rows) {
    const related = searches.filter(
      (search) =>
        search.product === row.product &&
        search.enabled &&
        search.definition.fields.some(
          (field) => field.match?.attribute === "drive_minutes" && search.values[field.id] != null,
        ),
    );
    if (
      !related.length ||
      row["availability"] === "sold" ||
      row["availability"] === "removed" ||
      related.every(
        (search) =>
          listingIsDismissed(row, [search], feedback) || modelIsExcluded(row, search, feedback),
      )
    )
      continue;
    if (!row.location?.trim()) continue;
    if (row.journey_estimate && journeyFresh(row.journey_estimate, config, row, now)) continue;
    const checked = Date.parse(row.travel_checked_at ?? "");
    if (
      !row.journey_estimate &&
      row.drive_minutes != null &&
      row["drive_origin"] === config.origin &&
      row.travel_source &&
      checked <= now &&
      now - checked < DAY &&
      (config.location?.latitude == null ||
        (row["drive_latitude"] === config.location.latitude &&
          row["drive_longitude"] === config.location.longitude))
    )
      continue;
    const country =
      typeof row["country"] === "string" ? row["country"] : (config.location?.country ?? null);
    const key = journeyDestinationKey(row.location, country);
    let group = groups.get(key);
    if (!group) {
      const params = new URLSearchParams({
        api: "1",
        origin: config.origin,
        destination: [row.location, country].filter(Boolean).join(", "),
        travelmode: "driving",
      });
      group = {
        destination: row.location,
        country,
        listing_keys: [],
        maps_url: `https://www.google.com/maps/dir/?${params}`,
      };
      groups.set(key, group);
    }
    group.listing_keys.push(row.key);
  }
  return [...groups.values()];
}
