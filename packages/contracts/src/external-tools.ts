import { z } from "zod";
import { marketplaceSchema } from "./integrations.ts";

export const locationPageResultSchema = z.object({
  result: z.object({ url: z.url(), expires_at: z.iso.datetime(), note: z.string() }),
});
export const marketplaceCapabilitiesResultSchema = z.object({
  result: z.object({
    marketplaces: z.array(
      z.object({ id: marketplaceSchema, name: z.string(), home: z.url(), route: z.string() }),
    ),
    ebay_api_configured: z.boolean(),
    message_execution: z.array(marketplaceSchema),
    native_offer_execution: z.array(marketplaceSchema),
    contact_scope: z.literal("observed_per_listing"),
  }),
});
export const ebaySearchSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    marketplace: z
      .enum(["EBAY_GB", "EBAY_US", "EBAY_DE", "EBAY_FR", "EBAY_CA", "EBAY_AU"])
      .default("EBAY_GB"),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(9950).default(0),
  })
  .strict();
export const ebayItemSchema = z
  .object({
    item_id: z.string().regex(/^v1\|\d+\|\d+$/u),
    marketplace: ebaySearchSchema.shape.marketplace,
  })
  .strict();
const ebayEvidenceSchema = z.object({
  item_id: ebayItemSchema.shape.item_id,
  listing_id: z.string().regex(/^\d+$/u),
  variation_id: z.string().regex(/^\d+$/u).nullable(),
  title: z.string(),
  url: z.url(),
  source: z.literal("ebay"),
  price_minor: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  price_kind: z.enum(["asking", "auction_or_unknown"]),
  condition_text: z.string().nullable(),
  location: z
    .object({
      city: z.string().optional(),
      country: z.string().optional(),
      postalCode: z.string().optional(),
    })
    .nullable(),
  images: z.array(z.url()),
  seller: z
    .object({
      username: z.string().optional(),
      feedbackPercentage: z.string().optional(),
      feedbackScore: z.number().optional(),
    })
    .nullable(),
  raw: z.record(z.string(), z.unknown()),
  note: z.string(),
});
export const ebayItemResultSchema = z.object({ result: ebayEvidenceSchema });
export const ebaySearchResultSchema = z.object({
  result: z.object({
    source: z.literal("ebay"),
    query: z.string(),
    marketplace: ebaySearchSchema.shape.marketplace,
    checked_at: z.iso.datetime(),
    offset: z.number().int().nonnegative(),
    returned_count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().nullable(),
    has_more: z.boolean(),
    pagination_complete: z.boolean(),
    items: z.array(ebayEvidenceSchema),
  }),
});
