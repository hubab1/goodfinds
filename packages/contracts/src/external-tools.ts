import { countrySchema, localeSchema } from "./regional-preferences.ts";
import { z } from "zod";
import { marketplaceSchema } from "./integrations.ts";

export const locationPageResultSchema = z.object({
  result: z.object({ url: z.url(), expires_at: z.iso.datetime(), note: z.string() }),
});
export const marketplaceCapabilitiesInputSchema = z
  .object({ country: countrySchema.optional(), locale: localeSchema.optional() })
  .strict();
export const marketplaceCapabilitiesResultSchema = z.object({
  result: z.object({
    marketplaces: z.array(
      z.object({
        id: marketplaceSchema,
        name: z.string(),
        home: z.url().nullable(),
        route: z.string(),
      }),
    ),
    message_execution: z.array(marketplaceSchema),
    native_offer_execution: z.array(marketplaceSchema),
    contact_scope: z.literal("observed_per_listing"),
  }),
});
