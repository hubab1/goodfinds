import { marketplaceSchema, integrationConfigShape } from "@goodfinds/contracts/integrations";
import { monitoringRecordsSchema } from "@goodfinds/contracts/monitoring";
import { dispatcherRecordsSchema } from "@goodfinds/contracts/scheduled-dispatch";
import { quietHoursSchema, defaultQuietHours } from "@goodfinds/contracts/search-timing";
import { contactConfigShape } from "@goodfinds/contracts/marketplace-actions";
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { z } from "zod";
import { listingSchema } from "@goodfinds/contracts/state";
import { savedSearchSchema, savedDraftSchema } from "@goodfinds/contracts/search-definition";

const sourceNames = marketplaceSchema.options;

const relationshipSchema = z.object({
  source: z.enum(sourceNames),
  listing_id: z.string().min(1),
  kind: z.enum(["relist_of", "cross_post_of", "duplicate_of"]),
  confidence: z.enum(["confirmed", "probable"]),
  evidence: z.string().trim().min(1),
});
export const listingObservationSchema = listingSchema.extend({
  collection_stage: z.enum(["discovery", "verification", "availability"]).optional(),
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
        interval_minutes: z.number().int().min(15).max(1440).default(120),
        enabled: z.literal(false).default(false),
        requires_awake_device: z.boolean().default(true),
        quiet_hours: quietHoursSchema.default(defaultQuietHours),
      })
      .loose()
      .default({
        interval_minutes: 120,
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
