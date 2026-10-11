import { z } from "zod";
import { REGIONAL_MARKETS } from "./regional-data.ts";
import { regionalPreferencesSchema } from "./regional-preferences.ts";
import { savedHostCapabilitiesSchema } from "./runtime.ts";

export const marketplaceSchema = z.enum([
  "facebook_marketplace",
  "ebay",
  "vinted",
  "gumtree",
  "autotrader",
  "craigslist",
  "cargurus",
  "poshmark",
  "depop",
  "mercari",
  "cars_com",
  "autotrader_us",
]);
export type Marketplace = z.infer<typeof marketplaceSchema>;
// The matched capture group is the public URL identifier, shared with the native server.
export const LISTING_PATH_PATTERNS = {
  facebook_marketplace: "^/marketplace/item/([0-9]+)$",
  ebay: "^/itm/(?:[^/]+/)?([0-9]+)$",
  vinted: "^/items/([0-9]+)(?:-[^/]+)?$",
  gumtree: "^/p/(?:[^/]+/)+([0-9]+)$",
  craigslist: "^(?:/(?:[^/]+/)+([0-9]+)\\.html|/view/d/[^/]+/([A-Za-z0-9]{22}))$",
  autotrader: "^/car-details/([0-9]+)$",
  cargurus: "^/details/([0-9]+)$",
  poshmark: "^/listing/[^/]+-([a-f0-9]{24})$",
  depop: "^/products/([A-Za-z0-9][A-Za-z0-9_-]*)$",
  mercari: "^/us/item/(m[0-9]+)$",
  cars_com: "^/vehicledetail/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$",
  autotrader_us: "^/cars-for-sale/(?:vehicle|inventory)/([0-9]+)$",
} as const satisfies Record<Marketplace, string>;
export const browserSchema = z.enum(["in_app", "external"]);
export const deviceBrowserSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120),
});
export type DeviceBrowser = z.infer<typeof deviceBrowserSchema>;
export const MARKETPLACES = [
  {
    id: "facebook_marketplace",
    name: "Facebook Marketplace",
    home: "https://www.facebook.com/marketplace/",
    route: "Browser search",
  },
  { id: "ebay", name: "eBay", home: "https://www.ebay.co.uk/", route: "Browser search" },
  {
    id: "vinted",
    name: "Vinted",
    home: "https://www.vinted.co.uk/",
    route: "Browser search",
  },
  {
    id: "gumtree",
    name: "Gumtree",
    home: "https://www.gumtree.com/",
    route: "Browser search",
  },
  {
    id: "autotrader",
    name: "Auto Trader UK",
    home: "https://www.autotrader.co.uk/",
    route: "Browser search",
  },
  {
    id: "craigslist",
    name: "Craigslist",
    home: "https://www.craigslist.org/",
    route: "Browser search",
  },
  {
    id: "cargurus",
    name: "CarGurus US",
    home: "https://www.cargurus.com/",
    route: "Browser search",
  },
  { id: "poshmark", name: "Poshmark US", home: "https://poshmark.com/", route: "Browser search" },
  { id: "depop", name: "Depop", home: "https://www.depop.com/", route: "Browser search" },
  { id: "mercari", name: "Mercari US", home: "https://www.mercari.com/", route: "Browser search" },
  { id: "cars_com", name: "Cars.com US", home: "https://www.cars.com/", route: "Browser search" },
  {
    id: "autotrader_us",
    name: "Autotrader US",
    home: "https://www.autotrader.com/",
    route: "Browser search",
  },
] as const satisfies readonly { id: Marketplace; name: string; home: string; route: string }[];
export const marketplaceSettingsSchema = z
  .object({
    enabled: z.boolean(),
    browser: z.enum(["default", "in_app", "external"]),
  })
  .strict();
export const accessReportSchema = z
  .object({
    browser: browserSchema,
    browser_id: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["available", "not_connected", "denied", "unavailable", "unknown"]),
    host: z.string().trim().min(1).max(120),
    profile: z.string().trim().min(1).max(120),
    evidence: z.string().trim().min(1).max(1000),
    blocked_domains: z.array(z.string().max(200)).max(30).default([]),
  })
  .strict();
export const savedAccessReportSchema = accessReportSchema.extend({
  checked_at: z.iso.datetime(),
  context_id: z.string(),
});
export const sessionReportSchema = z
  .object({
    marketplace: marketplaceSchema,
    browser: browserSchema,
    browser_id: z.string().trim().min(1).max(200).optional(),
    host: z.string().trim().min(1).max(120),
    profile: z.string().trim().min(1).max(120),
    status: z.enum(["signed_in", "signed_out", "unknown", "expired"]),
    evidence: z.string().trim().min(1).max(1000),
  })
  .strict();
export const savedSessionReportSchema = sessionReportSchema.extend({
  checked_at: z.iso.datetime(),
  context_id: z.string(),
});
export const locationSchema = z
  .object({
    source: z.enum(["device", "ip", "postal", "manual"]),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    accuracy_m: z.number().nonnegative().nullable(),
    area: z.string().trim().min(1).max(200),
    country: z.string().regex(/^[A-Z]{2}$/u),
    postal_code: z.string().trim().max(30).optional(),
    acquired_at: z.iso.datetime(),
    display: z.enum(["town", "postal"]),
  })
  .strict()
  .superRefine((location, ctx) => {
    if ((location.latitude === null) !== (location.longitude === null))
      ctx.addIssue({ code: "custom", message: "Latitude and longitude must be supplied together" });
    if (location.source !== "manual" && location.latitude === null)
      ctx.addIssue({ code: "custom", message: "Detected locations need coordinates" });
    if (location.display === "postal" && !location.postal_code)
      ctx.addIssue({
        code: "custom",
        message: "Enter a postal code before choosing postal display",
      });
  });
export type Location = z.infer<typeof locationSchema>;
export const integrationConfigShape = {
  host_capabilities: z.array(savedHostCapabilitiesSchema).max(20).default([]),
  regional_preferences: regionalPreferencesSchema.optional(),
  platforms: z.partialRecord(marketplaceSchema, marketplaceSettingsSchema).default({}),
  browser_access: z.array(savedAccessReportSchema).max(20).default([]),
  platform_sessions: z.array(savedSessionReportSchema).max(100).default([]),
  location: locationSchema.nullable().default(null),
};
export function accessAvailable(
  reports: z.infer<typeof savedAccessReportSchema>[],
  browser: z.infer<typeof browserSchema>,
  context: string,
  now: number,
  domain?: string,
): boolean {
  return reports.some(
    (report) =>
      report.browser === browser &&
      report.status === "available" &&
      report.context_id === context &&
      (!domain ||
        !report.blocked_domains.some(
          (blocked) => blocked === "*" || domain === blocked || domain.endsWith(`.${blocked}`),
        )) &&
      now >= Date.parse(report.checked_at) &&
      now - Date.parse(report.checked_at) <= 30 * 60_000,
  );
}
export function postalLabel(country: string): string {
  return country === "US"
    ? "ZIP code"
    : ["GB", "AU", "NZ"].includes(country)
      ? "Postcode"
      : "Postal code";
}
export function marketDomain(
  source: Marketplace,
  country?: string | null,
  locale?: string | null,
): string | undefined {
  const domains: Record<string, string> = REGIONAL_MARKETS.domains[source];
  const variants: Partial<Record<Marketplace, Record<string, string>>> =
    REGIONAL_MARKETS.languageDomains;
  const language = locale?.split("-")[0]?.toLowerCase();
  return (
    (country && language ? variants[source]?.[`${language}-${country}`] : undefined) ??
    (country ? domains[country] : undefined) ??
    domains["*"]
  );
}
export function marketplaceDomains(source: Marketplace): string[] {
  const variants: Partial<Record<Marketplace, Record<string, string>>> =
    REGIONAL_MARKETS.languageDomains;
  return [
    ...new Set([
      ...Object.values(REGIONAL_MARKETS.domains[source]),
      ...Object.values(variants[source] ?? {}),
    ]),
  ];
}
export function marketHome(
  source: Marketplace,
  country?: string | null,
  locale?: string | null,
): string | undefined {
  const domain = marketDomain(source, country, locale);
  if (!domain) return undefined;
  const host =
    source === "poshmark" || /^(benl|befr|cafr)\./u.test(domain) ? domain : `www.${domain}`;
  if (source === "depop" && country === "GB") return `https://${host}/gb/`;
  return `https://${host}${source === "facebook_marketplace" ? "/marketplace/" : "/"}`;
}
export function marketSearchUrl(
  source: Marketplace,
  query: string,
  country?: string | null,
  locale?: string | null,
): string | undefined {
  const home = marketHome(source, country, locale);
  if (!home) return undefined;
  const encoded = encodeURIComponent(query);
  switch (source) {
    case "facebook_marketplace":
      return `${home}search/?query=${encoded}`;
    case "ebay":
      return `${home}sch/i.html?_nkw=${encoded}&LH_BIN=1`;
    case "vinted":
      return `${home}catalog?search_text=${encoded}`;
    case "gumtree":
      return `${home}search?search_category=all&q=${encoded}`;
    case "autotrader":
      return `${home}car-search`;
    case "craigslist":
      return home;
    case "cargurus":
      return `${home}Cars/spt-used-cars`;
    case "cars_com":
      return `${home}shopping/`;
    case "autotrader_us":
      return `${home}cars-for-sale`;
    case "poshmark":
      return `${home}search?query=${encoded}&type=listings`;
    case "depop":
      return `https://www.depop.com/search/?q=${encoded}`;
    case "mercari":
      return `${home}search/?keyword=${encoded}`;
  }
  return undefined;
}
export function isMarketplaceUrl(value: string, source?: Marketplace): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (source ? [source] : marketplaceSchema.options).some((id) =>
        marketplaceDomains(id).some(
          (host) =>
            url.hostname === host ||
            url.hostname === `www.${host}` ||
            (!(REGIONAL_MARKETS.exactHosts as readonly string[]).includes(id) &&
              url.hostname.endsWith(`.${host}`)),
        ),
      )
    );
  } catch {
    return false;
  }
}
