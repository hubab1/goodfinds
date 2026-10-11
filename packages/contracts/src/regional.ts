import { z } from "zod";
import { marketplaceSchema, marketSearchUrl } from "./integrations.ts";
import { REGIONAL_MARKETS } from "./regional-data.ts";
import type { SearchDefinition, SearchDraft } from "./search-definition.ts";

import {
  countrySchema,
  currencySchema,
  currencyDivisorSchema,
  localeSchema,
  fulfilmentSchema,
  type RegionalPreferences,
  type LocaleHints,
} from "./regional-preferences.ts";
export * from "./regional-preferences.ts";
const sourceSchema = z.enum([
  "explicit",
  "saved",
  "location",
  "hint",
  "locale",
  "country",
  "default",
  "unknown",
]);
export const regionalContextSchema = z.object({
  country: countrySchema.nullable(),
  currency: currencySchema.nullable(),
  locale: localeSchema.nullable(),
  fulfilment: fulfilmentSchema,
  sources: z.object({
    country: sourceSchema,
    currency: sourceSchema,
    locale: sourceSchema,
    fulfilment: sourceSchema,
  }),
  marketplaces: z.array(z.object({ id: marketplaceSchema, url: z.url() })),
  needs: z.array(z.enum(["country", "currency"])),
});
export type RegionalContext = z.infer<typeof regionalContextSchema>;
export type RegionalConfig = {
  regional_preferences?: RegionalPreferences | undefined;
  location?: { country: string } | null | undefined;
  platforms?: Partial<Record<z.infer<typeof marketplaceSchema>, { enabled: boolean }>> | undefined;
};
export function browserLocaleHints(): LocaleHints {
  return typeof navigator === "undefined" ? {} : { locale: navigator.language };
}
export function localeCountry(locale: string | null | undefined): string | undefined {
  if (!locale || !localeSchema.safeParse(locale).success) return undefined;
  for (const part of locale.split("-").slice(1)) {
    if (part.length === 1) break; // Unicode extensions do not establish residence.
    if (/^[A-Za-z]{2}$/u.test(part)) return part.toUpperCase();
  }
  return undefined;
}
export function hostLocaleHints(meta: unknown): LocaleHints {
  const value = z.record(z.string(), z.unknown()).safeParse(meta).data ?? {};
  const locale = localeSchema.safeParse(value["openai/locale"] ?? value["webplus/i18n"]).data;
  const location = z
    .object({ country: z.string().optional() })
    .safeParse(value["openai/userLocation"]).data;
  const country = countrySchema.safeParse(location?.country?.toUpperCase()).data;
  return { ...(locale ? { locale } : {}), ...(country ? { country } : {}) };
}
export function resolveRegion(
  config: RegionalConfig,
  explicit: RegionalPreferences = {},
  hints: LocaleHints = {},
  category = "",
): RegionalContext {
  const saved = config.regional_preferences ?? {};
  const sources: RegionalContext["sources"] = {
    country: "unknown",
    currency: "unknown",
    locale: "unknown",
    fulfilment: "default",
  };
  const choose = (key: keyof RegionalPreferences): string | undefined => {
    if (explicit[key]) {
      sources[key] = "explicit";
      return explicit[key];
    }
    if (saved[key]) {
      sources[key] = "saved";
      return saved[key];
    }
    return undefined;
  };
  let locale = choose("locale");
  if (!locale && localeSchema.safeParse(hints.locale).success) {
    locale = hints.locale;
    sources.locale = "hint";
  }
  let country = choose("country");
  if (!country && config.location?.country) {
    country = config.location.country;
    sources.country = "location";
  }
  const hintedCountry = countrySchema.safeParse(hints.country?.toUpperCase()).data;
  if (!country && hintedCountry) {
    country = hintedCountry;
    sources.country = "hint";
  }
  if (!country) {
    country = localeCountry(locale);
    if (country) sources.country = "locale";
  }
  let currency = choose("currency");
  if (!currency && country) {
    currency = (REGIONAL_MARKETS.currencies as Record<string, string>)[country];
    if (currency) sources.currency = "country";
  }
  const fulfilment = fulfilmentSchema.parse(choose("fulfilment") ?? "either");
  const words = category.toLowerCase().split(/[^a-z]+/u);
  const group =
    (["fashion", "vehicle", "rental"] as const).find((key) =>
      REGIONAL_MARKETS.categories[key].some((word) => words.includes(word)),
    ) ?? "general";
  const allowed: readonly string[] = REGIONAL_MARKETS.fulfilment[fulfilment];
  const countryRecommendations: Record<
    string,
    Partial<Record<typeof group, readonly z.infer<typeof marketplaceSchema>[]>>
  > = REGIONAL_MARKETS.countryRecommendations;
  const recommended =
    (country ? countryRecommendations[country]?.[group] : undefined) ??
    REGIONAL_MARKETS.recommendations[group];
  const marketplaces = country
    ? recommended.flatMap((id) => {
        if (
          config.platforms?.[id]?.enabled === false ||
          (group !== "rental" && !allowed.includes(id))
        )
          return [];
        const url = marketSearchUrl(id, "", country, locale);
        return url ? [{ id, url }] : [];
      })
    : [];
  return {
    country: country ?? null,
    currency: currency ?? null,
    locale: locale ?? null,
    fulfilment,
    sources,
    marketplaces,
    needs: [...(!country ? ["country" as const] : []), ...(!currency ? ["currency" as const] : [])],
  };
}
export function currencyDivisor(currency: string) {
  return currencyDivisorSchema.parse(
    10 **
      (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2),
  );
}
// Call only for a fresh starter or an explicit currency edit, never a saved definition on load.
export function localizeTemplate(template: SearchDefinition, currency: string): SearchDefinition {
  const next = structuredClone(template);
  next.price.currency = currency;
  for (const field of next.fields) {
    if (field.match?.attribute !== "price_minor") continue;
    field.display_divisor = currencyDivisor(currency);
    field.unit = currency + (next.price.period === "once" ? "" : ` / ${next.price.period}`);
  }
  return next;
}
export function newSearchDefaults(
  config: RegionalConfig,
  search: Pick<SearchDraft, "definition" | "market" | "marketplaces">,
): void {
  const region = resolveRegion(config, search.market, {}, search.definition.category);
  search.market = {
    ...(region.country ? { country: region.country } : {}),
    ...(region.locale ? { locale: region.locale } : {}),
    fulfilment: region.fulfilment,
    ...search.market,
  };
  if (region.country && search.marketplaces) {
    const unsupported = search.marketplaces.filter(
      (id) => !marketSearchUrl(id, "", region.country, region.locale),
    );
    if (unsupported.length)
      throw new Error(
        `These marketplaces have no supported route for ${region.country}: ${unsupported.join(", ")}. Use this country's recommended marketplaces or change the shopping country.`,
      );
  }
  if (!search.marketplaces && region.country) {
    if (!region.marketplaces.length)
      throw new Error(
        "No existing marketplace matches this country and delivery preference. Choose a marketplace or change the search scope.",
      );
    search.marketplaces = region.marketplaces.map((m) => m.id);
  }
}
export function searchMarketplaceRoutes(
  config: RegionalConfig,
  search: Pick<SearchDraft, "definition" | "market" | "marketplaces">,
) {
  const region = resolveRegion(config, {
    ...search.market,
    currency: search.definition.price.currency,
  });
  return (search.marketplaces ?? ["facebook_marketplace"]).map((id) => ({
    id,
    url: marketSearchUrl(id, "", region.country, region.locale) ?? null,
  }));
}
