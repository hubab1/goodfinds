import { z } from "zod";
import { listingSeenSchema } from "./listing-reading.ts";
import { workflowSchema, sellerWorkflowSchema } from "./workflow-schema.ts";
import { revisionsSchema } from "./revisions.ts";
import { monitoringRecordsSchema, monitoringSummarySchema } from "./monitoring.ts";
import { dispatcherRecordsSchema, dispatcherSummarySchema } from "./scheduled-dispatch.ts";
import { quietHoursSchema, defaultQuietHours } from "./search-timing.ts";
import { searchRunSchema } from "./search-workflow.ts";
import { buyingNextStepSchema } from "./buying-next-steps.ts";
import { verificationCheckSchema, setupCostSchema } from "./verification.ts";
import { contactConfigShape } from "./marketplace-actions.ts";
import { conversationSchema, sellerConversationSummarySchema } from "./seller-conversation.ts";
import {
  integrationConfigShape,
  marketplaceSchema,
  marketplaceSettingsSchema,
  deviceBrowserSchema,
  locationSchema,
} from "./integrations.ts";
import { feedbackEventSchema } from "./discovery.ts";
import {
  savedDraftSchema,
  savedSearchSchema,
  type searchInputSchema,
} from "./search-definition.ts";

export const modeSchema = z.enum(["live", "sample"]);
export type WorkspaceMode = z.infer<typeof modeSchema>;

export { savedSearchSchema } from "./search-definition.ts";
export type SavedSearch = z.infer<typeof savedSearchSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;

export const settingsSchema = z
  .object({
    origin: z.string().trim().min(1).max(200).optional(),
    location: locationSchema.nullable().optional(),
    platforms: z.partialRecord(marketplaceSchema, marketplaceSettingsSchema).optional(),
    browser_preference: z.enum(["in_app", "external"]).optional(),
    journey_checks_enabled: z.boolean().optional(),
    interval_minutes: z.number().int().min(15).max(1440).optional(),
    quiet_hours: quietHoursSchema.optional(),
    baseline_days: z.number().int().min(1).max(365).optional(),
    minimum_peer_listings: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const priceHistorySchema = z.object({
  evaluated_at: z.string(),
  observed_at: z.string().optional(),
  price_minor: z.number().nullable(),
  currency: z.string().nullish(),
  price_period: z.string().optional(),
});
const qualitySchema = z
  .object({
    flags: z.array(z.object({ code: z.string(), message: z.string(), severity: z.string() })),
    eligibility: z.record(
      z.string(),
      z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }),
    ),
    observed_active_days: z.number().nullable(),
    advertised_age_minimum_days: z.number().nullable(),
  })
  .loose();
const marketHistorySchema = z.object({
  completed_period_count: z.number().default(0),
  unfinished_period_count: z.number().default(0),
  median_completed_lower_days: z.number().nullable().default(null),
  median_completed_upper_days: z.number().nullable().default(null),
  cohort_listing_ids: z.array(z.string()),
  cohort_listing_keys: z.array(z.string()).default([]),
  distinct_count: z.number(),
  confirmed_active_count: z.number(),
  sold_count: z.number(),
  unknown_outcome_count: z.number(),
  supported_arrivals: z.number(),
  coverage_days: z.number(),
  arrivals_per_day: z.number().nullable(),
  median_arrival_gap_days: z.number().nullable(),
  median_cash_price_minor: z.number().nullable(),
  cash_price_sample_count: z.number(),
  window_days: z.number(),
  currency: z.string().nullish(),
  price_period: z.string().optional(),
  note: z.string(),
});
export type MarketHistory = z.infer<typeof marketHistorySchema>;
const photoSchema = z.object({
  media_id: z.string().regex(/^[a-f0-9]{64}$/),
  position: z.number().int().positive(),
  caption: z.string(),
});
const credibilitySchema = z.object({
  status: z.string(),
  reasons: z.array(z.string()),
  peer_count: z.number(),
  reference_median_minor: z.number().nullable(),
  reference_stddev_minor: z.number().nullable(),
  stddevs_below_median: z.number().nullable(),
  price_is_outlier: z.boolean().nullable(),
  seller_account_recent: z.boolean().nullable(),
  seller_has_profile_image: z.boolean().nullable(),
  seller_friend_count: z.number().int().nonnegative().nullish(),
  older_account_with_many_friends: z.boolean().nullable().default(null),
  supporting_signals: z.array(z.string()).default([]),
  policy: z.object({
    recent_account_months: z.number(),
    minimum_peer_listings: z.number(),
    stddev_threshold: z.number(),
    zero_variance_discount_fraction: z.number(),
    established_account_minimum_friends: z.number().default(100),
  }),
});
import { listingDiscoverySchema } from "./listing-discovery.ts";
import { journeyEstimateSchema } from "./journeys.ts";
export const listingSchema = z
  .object({
    collection_stage: z.enum(["discovery", "verification"]).optional(),
    verification_checks: z
      .array(verificationCheckSchema)
      .max(30)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
        "Verification IDs must be unique",
      )
      .optional(),
    setup_costs: z
      .array(setupCostSchema)
      .max(20)
      .refine(
        (items) => new Set(items.map((item) => item.label)).size === items.length,
        "Setup cost labels must be unique",
      )
      .optional(),
    key: z.string(),
    entity_key: z.string().optional(),
    price_kind: z.string().nullish(),
    listing_id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    url: z.string(),
    product: z.string(),
    chip: z.string().nullish(),
    ram_gb: z.number().nullish(),
    ssd_gb: z.number().nullish(),
    price_minor: z.number().nullable(),
    currency: z.string().nullish(),
    source: z.string().optional(),
    observed_at: z.string().optional(),
    first_observed_at: z.string().optional(),
    first_found_runs: z.array(listingDiscoverySchema).optional(),
    seen_in_searches: z.array(listingSeenSchema).optional(),
    last_observed_at: z.string().optional(),
    last_successful_at: z.string().nullish(),
    last_attempted_at: z.string().optional(),
    check_outcome: z.string().optional(),
    total_cash_cost_minor: z.number().nullish(),
    publication: z
      .object({
        raw_text: z.string().nullish(),
        earliest_at: z.string().nullish(),
        latest_at: z.string().nullish(),
        precision: z.string(),
        kind: z.string().optional(),
      })
      .loose()
      .nullish(),
    quality: qualitySchema.optional(),
    duration: z
      .object({
        lower_days: z.number().nullable(),
        upper_days: z.number().nullable(),
        unfinished: z.boolean(),
        outcome: z.string().optional(),
        basis: z.string(),
      })
      .optional(),
    events: z
      .array(
        z
          .object({
            kind: z.string(),
            observed_at: z.string(),
            previous_price_minor: z.number().optional(),
            price_minor: z.number().optional(),
            currency: z.string().nullish(),
            state: z.string().optional(),
            previous_state: z.string().optional(),
            outcome: z.string().optional(),
            earliest_at: z.string().optional(),
            latest_at: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    condition: z.string().nullish(),
    item_state: z.string().nullish(),
    functional: z.boolean().nullish(),
    availability: z.string().nullish(),
    seller_name: z.string().nullish(),
    seller_profile_url: z.string().nullish(),
    seller_public_profile_url: z.string().nullish(),
    seller_friend_count: z.number().int().nonnegative().nullish(),
    seller_friend_count_text: z.string().nullish(),
    seller_friend_count_precision: z.enum(["exact", "approximate", "lower_bound"]).nullish(),
    seller_listing_count: z.number().int().nonnegative().nullish(),
    seller_listing_count_text: z.string().nullish(),
    seller_listing_count_precision: z.enum(["exact", "approximate", "lower_bound"]).nullish(),
    seller_listings_checked_at: z.string().nullish(),
    seller_inventory_review: z
      .object({
        checked_at: z.iso.datetime({ offset: true }),
        source_url: z.url().max(2000),
        category: z.string().trim().min(1).max(64),
        category_label: z.string().trim().min(1).max(100),
        item_kind: z.enum(["goods", "rental", "service"]),
        evidence: z.string().trim().min(1).max(4000),
        listings: z
          .array(
            z
              .object({
                listing_id: z.string().trim().min(1).max(100),
                url: z.url().max(2000),
                title: z.string().trim().min(1).max(500),
                availability: z.literal("active"),
                evidence: z.string().trim().min(1).max(2000),
              })
              .strict(),
          )
          .max(30),
      })
      .strict()
      .nullish(),
    seller_profile_checked_at: z.string().nullish(),
    seller_profile_notes: z.string().nullish(),
    seller_avatar_media_id: z.string().nullish(),
    seller_has_profile_image: z.boolean().nullish(),
    seller_account_joined_at: z.string().nullish(),
    seller_last_active_text: z.string().nullish(),
    seller_metadata_checked_at: z.string().nullish(),
    photos: z.array(photoSchema).max(100).default([]),
    videos: z
      .array(
        photoSchema.extend({
          poster_media_id: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        }),
      )
      .max(20)
      .default([]),
    video_review: z
      .object({
        total_videos: z.number().int().nonnegative(),
        reviewed_positions: z.array(z.number().int().positive()),
        complete: z.boolean(),
        notes: z.string().optional(),
      })
      .nullish(),
    media_capture: z
      .object({
        status: z.enum(["complete", "partial", "unavailable"]),
        expected_photos: z.number().int().nonnegative().optional(),
        expected_videos: z.number().int().nonnegative().optional(),
        captured_at: z.iso.datetime({ offset: true }).optional(),
        notes: z.string().max(2000).optional(),
      })
      .optional(),
    image_review: z
      .object({
        total_images: z.number().int().nonnegative(),
        reviewed_positions: z.array(z.number().int().positive()),
        complete: z.boolean(),
        notes: z.string().optional(),
      })
      .nullish(),
    location: z.string().nullish(),
    drive_minutes: z.number().nullish(),
    journey_estimate: journeyEstimateSchema.optional(),
    price_period: z.enum(["once", "month", "week"]).nullish(),
    attributes: z.record(z.string(), z.unknown()).nullish(),
    travel_source: z.string().nullish(),
    travel_checked_at: z.string().nullish(),
    evidence: z.record(z.string(), z.unknown()).nullish(),
    price_history: z.array(priceHistorySchema).default([]),
  })
  .loose();
export type Listing = z.infer<typeof listingSchema>;
const decisionSchema = z.object({
  suitability: z.enum(["suitable", "possible", "unsuitable"]).optional(),
  verification: z.enum(["complete", "needs_check"]).optional(),
  value: z.enum(["below_average", "at_or_above_average", "unknown"]).optional(),
  setup_total_minor: z.number().nullable().optional(),
  setup_cost_basis: z.enum(["observed", "estimate", "unknown"]).optional(),
  listing: listingSchema,
  status: z.string(),
  reasons: z.array(z.string()),
  search_id: z.string(),
  search_name: z.string(),
  credibility: credibilitySchema.optional(),
  preferences: z.array(z.string()).optional(),
  preference_score: z.number().optional(),
  peer_count: z.number().optional(),
  reference_average_minor: z.number().optional(),
  percent_below_average: z.number().optional(),
  peer_listing_ids: z.array(z.string()).optional(),
  quality: qualitySchema.optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
const dealSchema = decisionSchema.extend({
  status: z.literal("qualifies"),
  peer_count: z.number(),
  reference_average_minor: z.number(),
  percent_below_average: z.number(),
  peer_listing_ids: z.array(z.string()),
});
export type Deal = z.infer<typeof dealSchema>;
export const stateSchema = z.object({
  device_browser: deviceBrowserSchema.nullable().default(null),
  next_steps: z.array(buyingNextStepSchema).default([]),
  search_runs: z.array(searchRunSchema).default([]),
  search_workflows: z.record(z.string(), workflowSchema).default({}),
  search_run_workflows: z.record(z.string(), workflowSchema).default({}),
  seller_workflow: sellerWorkflowSchema.nullable().default(null),
  seller_conversations: z.array(sellerConversationSummarySchema).default([]),
  seller_conversation: conversationSchema.nullable().default(null),
  api_connections: z
    .object({ ebay_credentials_configured: z.boolean() })
    .default({ ebay_credentials_configured: false }),
  access_context: z.string().default("unknown"),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  revisions: revisionsSchema,
  mode: modeSchema,
  config: z
    .object({
      ...integrationConfigShape,
      ...contactConfigShape,
      feedback: z.array(feedbackEventSchema).default([]),
      monitoring: monitoringRecordsSchema,
      dispatchers: dispatcherRecordsSchema,
      origin: z.string(),
      origin_confirmed: z.boolean().optional(),
      browser_preference: z.enum(["in_app", "external"]),
      journey_checks_enabled: z.boolean().default(true),
      baseline_days: z.number(),
      minimum_peer_listings: z.number(),
      searches: z.array(savedSearchSchema),
      schedule: z
        .object({
          interval_minutes: z.number(),
          enabled: z.boolean(),
          quiet_hours: quietHoursSchema.default(defaultQuietHours),
        })
        .loose(),
    })
    .loose(),
  searches: z.array(
    savedSearchSchema.extend({
      qualified_count: z.number(),
      tracked_count: z.number(),
      found_count: z.number().int().nonnegative().nullable().optional(),
      unseen_count: z.number().int().nonnegative().default(0),
      seen_count: z.number().int().nonnegative().default(0),
      last_searched_at: z.iso.datetime().nullable().default(null),
      latest_found_at: z.iso.datetime().nullable().default(null),
      market_history: z.array(marketHistorySchema).default([]),
    }),
  ),
  drafts: z.array(savedDraftSchema).default([]),
  deals: z.array(dealSchema),
  decisions: z.array(decisionSchema),
  listings: z.array(listingSchema),
  activity: z.array(
    z.object({
      id: z.string(),
      evaluated_at: z.string(),
      mode: z.string(),
      observed_count: z.number(),
      collection_method: z.string().default("supplied"),
      status: z.enum(["recorded", "partial", "failed"]).default("recorded"),
    }),
  ),
  counts: z.object({
    listings: z.number(),
    deals: z.number(),
    active_searches: z.number(),
    pending_alerts: z.number(),
  }),
  monitor: z.object({
    collector_available: z.boolean(),
    scheduler_available: z.boolean(),
    notification_delivery_available: z.boolean(),
    next_run_at: z.string().nullable(),
    last_run_at: z.string().nullable(),
    message: z.string(),
  }),
  monitoring: z.array(monitoringSummarySchema).default([]),
  dispatchers: z.array(dispatcherSummarySchema).default([]),
  generated_at: z.string(),
});
export type GoodfindsState = z.infer<typeof stateSchema>;
export const stateEnvelopeSchema = z.object({ state: stateSchema });
export const toolResultSchema = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
      .default([]),
  })
  .loose();

export function stateFromToolResult(result: unknown): GoodfindsState {
  const parsed = toolResultSchema.parse(result);
  if (parsed.isError) {
    throw new Error(
      parsed.content.find((item) => item.type === "text")?.text ?? "Could not complete that action",
    );
  }
  return z.object({ _meta: z.object({ goodfinds_state: stateSchema }) }).parse(result)._meta
    .goodfinds_state;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not complete that action";
}
