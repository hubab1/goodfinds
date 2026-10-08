import { integrationConfigShape } from "@goodfinds/contracts/integrations";
import { monitoringRecordsSchema } from "@goodfinds/contracts/monitoring";
import { dispatcherRecordsSchema } from "@goodfinds/contracts/scheduled-dispatch";
import { quietHoursSchema, defaultQuietHours } from "@goodfinds/contracts/search-timing";
import { contactConfigShape } from "@goodfinds/contracts/marketplace-actions";
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { createHash } from "node:crypto";
import { z } from "zod";
import { listingSchema } from "@goodfinds/contracts/state";
import { savedSearchSchema, savedDraftSchema } from "@goodfinds/contracts/search-definition";

export const DAY = 86400000;
const sourceNames = [
  "facebook_marketplace",
  "ebay",
  "vinted",
  "gumtree",
  "craigslist",
  "autotrader",
] as const;
export const SOURCES = {
  facebook_marketplace: ["facebook.com"],
  ebay: ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.ca", "ebay.com.au"],
  vinted: ["vinted.co.uk", "vinted.com", "vinted.fr", "vinted.de"],
  gumtree: ["gumtree.com"],
  craigslist: ["craigslist.org"],
  autotrader: ["autotrader.co.uk"],
} as const;
export const TERMINAL = new Set([
  "sold",
  "out_of_stock",
  "ended_unsold",
  "expired",
  "removed",
  "unknown_unavailable",
]);
export const qualityDefaults = {
  minimum_outlier_peers: 20,
  outlier_z: 3.5,
  max_check_age_hours: 72,
};
export const credibilityDefaults = {
  recent_account_months: 24,
  minimum_peer_listings: 10,
  stddev_threshold: 3,
  zero_variance_discount_fraction: 0.5,
  established_account_minimum_friends: 100,
};

const relationshipSchema = z.object({
  source: z.enum(sourceNames),
  listing_id: z.string().min(1),
  kind: z.enum(["relist_of", "cross_post_of", "duplicate_of"]),
  confidence: z.enum(["confirmed", "probable"]),
  evidence: z.string().trim().min(1),
});
export const listingObservationSchema = listingSchema.extend({
  source: z.enum(sourceNames),
  photos: listingSchema.shape.photos.unwrap().optional(),
  videos: listingSchema.shape.videos.unwrap().optional(),
  price_history: listingSchema.shape.price_history.unwrap().optional(),
  provenance: z.enum(["manual", "synthetic"]),
  observed_at: z.string(),
  price_kind: z.string().nullish(),
  attributes: z
    .record(
      z.string(),
      z.union([
        z.string().max(500),
        z.number(),
        z.boolean(),
        z.array(z.string().max(500)).max(30),
        z.null(),
      ]),
    )
    .nullish(),
  screen_inches: z.number().nullish(),
  drive_origin: z.string().nullish(),
  drive_latitude: z.number().min(-90).max(90).nullish(),
  drive_longitude: z.number().min(-180).max(180).nullish(),
  cash_price_minor: z.number().int().nonnegative().nullish(),
  seller_avatar_media_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullish(),
  displayed_previous_price_minor: z.number().int().nonnegative().nullish(),
  shipping_minor: z.number().int().nonnegative().nullish(),
  buyer_fee_minor: z.number().int().nonnegative().nullish(),
  tax_minor: z.number().int().nonnegative().nullish(),
  costs_complete: z.boolean().nullish(),
  quantity: z.number().int().positive().nullish(),
  inventory_type: z.enum(["single_item", "multiple_units", "unknown"]).nullish(),
  bundle_type: z.string().nullish(),
  seller_type: z.string().nullish(),
  collection_method: z.string().nullish(),
  observation_time_precision: z.string().optional(),
  entity_key: z.string().optional(),
  entity_sources: z.array(z.string()).optional(),
  ingested_at: z.string().optional(),
  evaluation_id: z.string().optional(),
  observation_sequence: z.number().optional(),
  first_confirmed_active_at: z.string().nullish(),
  last_confirmed_active_at: z.string().nullish(),
  observation_conflict: z.boolean().optional(),
  field_evidence: z
    .record(
      z.string(),
      z
        .object({
          state: z.enum([
            "observed",
            "inferred",
            "unknown",
            "unsupported",
            "not_inspected",
            "conflicting",
          ]),
        })
        .loose(),
    )
    .nullish(),
  relationships: z.array(relationshipSchema).max(30).optional(),
  publication: z
    .object({
      raw_text: z.string().nullish(),
      earliest_at: z.string().nullish(),
      latest_at: z.string().nullish(),
      precision: z.enum(["exact", "bounded", "approximate", "unknown"]),
      kind: z.enum(["published", "updated", "renewed", "unknown"]).optional(),
      timezone: z.string().nullish(),
      evidence: z.string().nullish(),
    })
    .strict()
    .nullish(),
});
export type ListingObservation = z.infer<typeof listingObservationSchema>;
export const workspaceConfigurationSchema = z
  .object({
    ...integrationConfigShape,
    ...contactConfigShape,
    feedback: z.array(feedbackEventSchema).max(10000).default([]),
    monitoring: monitoringRecordsSchema,
    dispatchers: dispatcherRecordsSchema,
    origin: z.string().trim().min(1).max(200),
    origin_confirmed: z.boolean().optional(),
    browser_preference: z.enum(["in_app", "external"]).default("in_app"),
    journey_checks_enabled: z.boolean().default(true),
    baseline_days: z.number().int().min(1).max(365),
    minimum_peer_listings: z.number().int().min(1).max(100),
    alert_policy: z.enum(["first_qualification_and_lower_price", "every_run"]),
    searches: z.array(savedSearchSchema).max(50),
    drafts: z.array(savedDraftSchema).max(20).default([]),
    schedule: z
      .object({
        interval_minutes: z.number().int().min(15).max(1440).default(60),
        enabled: z.literal(false).default(false),
        requires_awake_device: z.boolean().default(true),
        quiet_hours: quietHoursSchema.default(defaultQuietHours),
      })
      .loose()
      .default({
        interval_minutes: 60,
        enabled: false,
        requires_awake_device: true,
        quiet_hours: defaultQuietHours(),
      }),
    quality_policy: z
      .object({
        minimum_outlier_peers: z.number().int().min(3).max(500).optional(),
        outlier_z: z.number().positive().optional(),
        max_check_age_hours: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    credibility_policy: z
      .object({
        recent_account_months: z.number().int().positive().optional(),
        minimum_peer_listings: z.number().int().min(2).optional(),
        stddev_threshold: z.number().positive().optional(),
        zero_variance_discount_fraction: z.number().gt(0).lt(1).optional(),
        established_account_minimum_friends: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .loose();
export type WorkspaceConfiguration = z.infer<typeof workspaceConfigurationSchema>;
export const searchCoverageSchema = z
  .object({
    source: listingObservationSchema.shape.source,
    search_id: z.string(),
    query: z.string().max(2000),
    filters: z.record(z.string(), z.unknown()),
    sort: z.string().max(2000),
    started_at: z.string(),
    finished_at: z.string(),
    status: z.enum(["success", "partial", "failed"]),
    pagination_complete: z.boolean(),
    result_count: z.number().int().nonnegative().nullish(),
    inspected_count: z.number().int().nonnegative().nullish(),
    notes: z.string().optional(),
  })
  .strict();
export type SearchCoverage = z.infer<typeof searchCoverageSchema> & {
  search_revision: string;
  scope_key: string;
};

export function time(value: unknown): number {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    throw new Error("Timestamps must include a timezone");
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) throw new Error("Invalid timestamp");
  const calendar = /^(\d{4}-\d{2}-\d{2})(?:T| )/u.exec(value)?.[1];
  if (!calendar || new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar)
    throw new Error("Invalid timestamp date");
  return stamp;
}
export function iso(value: number): string {
  return new Date(value).toISOString();
}
export function fresh(value: unknown, now: number, days: number): boolean {
  try {
    const age = now - time(value);
    return age >= 0 && age <= days * DAY;
  } catch {
    return false;
  }
}
export function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// Persisted payloads are validated on import. Keep this assertion at the database boundary.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function parseJson<T>(value: string): T {
  const result: unknown = JSON.parse(value);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result as T;
}
export function withDefaults<T extends object>(
  defaults: T,
  overrides?: Partial<{ [K in keyof T]: T[K] | undefined }>,
): T {
  return Object.assign(
    {},
    defaults,
    Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined)),
  );
}

// Deterministic sorted JSON gives equivalent documents the same rule and coverage hash.
export function canonical(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Expected finite JSON data");
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(", ")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => `${canonical(key)}: ${canonical(value[key])}`)
      .join(", ")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Expected JSON data");
  return text.replace(
    /[\u007f-\uffff]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  const right = sorted[middle];
  if (right === undefined) return null;
  return sorted.length % 2 ? right : ((sorted[middle - 1] ?? right) + right) / 2;
}
export function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
