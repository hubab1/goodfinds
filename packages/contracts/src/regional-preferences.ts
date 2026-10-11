import { z } from "zod";

export const countrySchema = z.string().regex(/^[A-Z]{2}$/u);
export const currencyDivisorSchema = z.union([
  z.literal(1),
  z.literal(10),
  z.literal(100),
  z.literal(1000),
  z.literal(10000),
]);
export const currencySchema = z.enum(Intl.supportedValuesOf("currency"));
export const localeSchema = z
  .string()
  .max(80)
  .regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/u);
export const fulfilmentSchema = z.enum(["collection", "delivery", "either"]);
export const regionalPreferencesSchema = z
  .object({
    country: countrySchema.nullable().optional(),
    currency: currencySchema.nullable().optional(),
    locale: localeSchema.nullable().optional(),
    fulfilment: fulfilmentSchema.nullable().optional(),
  })
  .strict();
export const searchMarketSchema = z
  .object({
    country: countrySchema.optional(),
    locale: localeSchema.optional(),
    fulfilment: fulfilmentSchema.optional(),
  })
  .strict();
export const localeHintsSchema = z
  .object({
    locale: z.string().max(80).optional(),
    country: z.string().max(10).optional(),
  })
  .strict();
export type RegionalPreferences = z.infer<typeof regionalPreferencesSchema>;
export type LocaleHints = z.infer<typeof localeHintsSchema>;
