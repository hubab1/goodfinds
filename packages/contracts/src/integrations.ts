import { z } from "zod";

export const marketplaceSchema = z.enum([
  "facebook_marketplace",
  "ebay",
  "vinted",
  "gumtree",
  "autotrader",
  "craigslist",
]);
export type Marketplace = z.infer<typeof marketplaceSchema>;
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
  { id: "ebay", name: "eBay", home: "https://www.ebay.co.uk/", route: "Browse API or browser" },
  {
    id: "vinted",
    name: "Vinted",
    home: "https://www.vinted.co.uk/",
    route: "Open search and import",
  },
  {
    id: "gumtree",
    name: "Gumtree",
    home: "https://www.gumtree.com/",
    route: "Open search and import",
  },
  {
    id: "autotrader",
    name: "Auto Trader UK",
    home: "https://www.autotrader.co.uk/",
    route: "Open search and import",
  },
  {
    id: "craigslist",
    name: "Craigslist",
    home: "https://www.craigslist.org/",
    route: "Open search and import",
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
export function marketSearchUrl(source: Marketplace, query: string, country = "GB"): string {
  const encoded = encodeURIComponent(query);
  const ebayDomains: Record<string, string> = {
    GB: "ebay.co.uk",
    US: "ebay.com",
    DE: "ebay.de",
    FR: "ebay.fr",
    CA: "ebay.ca",
    AU: "ebay.com.au",
  };
  const vintedDomains: Record<string, string> = {
    GB: "vinted.co.uk",
    US: "vinted.com",
    DE: "vinted.de",
    FR: "vinted.fr",
  };
  switch (source) {
    case "facebook_marketplace":
      return `https://www.facebook.com/marketplace/search/?query=${encoded}`;
    case "ebay":
      return `https://www.${ebayDomains[country] ?? "ebay.co.uk"}/sch/i.html?_nkw=${encoded}&LH_BIN=1`;
    case "vinted":
      return `https://www.${vintedDomains[country] ?? "vinted.co.uk"}/catalog?search_text=${encoded}`;
    case "gumtree":
      return `https://www.gumtree.com/search?search_category=all&q=${encoded}`;
    case "autotrader":
      return "https://www.autotrader.co.uk/car-search";
    case "craigslist":
      return "https://www.craigslist.org/";
  }
  throw new Error("Unsupported marketplace");
}
