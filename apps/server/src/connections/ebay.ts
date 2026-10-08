import { z } from "zod";

export { ebaySearchSchema, ebayItemSchema } from "@goodfinds/contracts/external-tools";
const moneySchema = z.object({ value: z.string(), currency: z.string() });
export const itemSchema = z
  .object({
    itemId: z.string().regex(/^v1\|\d+\|\d+$/u),
    title: z.string(),
    itemWebUrl: z.url(),
    price: moneySchema.optional(),
    buyingOptions: z.array(z.string()).optional(),
    condition: z.string().optional(),
    itemLocation: z
      .object({
        city: z.string().optional(),
        country: z.string().optional(),
        postalCode: z.string().optional(),
      })
      .optional(),
    image: z.object({ imageUrl: z.url() }).optional(),
    additionalImages: z.array(z.object({ imageUrl: z.url() })).optional(),
    seller: z
      .object({
        username: z.string().optional(),
        feedbackPercentage: z.string().optional(),
        feedbackScore: z.number().optional(),
      })
      .optional(),
  })
  .loose();
export function priceMinor(value: string, currency: string): number | null {
  if (!["GBP", "USD", "EUR", "CAD", "AUD", "NZD", "JPY"].includes(currency)) return null;
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match?.[1]) return null;
  const places = currency === "JPY" ? 0 : 2,
    fraction = match[2] ?? "";
  if (fraction.length > places && /[1-9]/u.test(fraction.slice(places))) return null;
  const amount =
    BigInt(match[1]) * 10n ** BigInt(places) +
    BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function ebayEvidence(input: unknown) {
  const item = itemSchema.parse(input);
  const url = new URL(item.itemWebUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !["ebay.co.uk", "ebay.com", "ebay.de", "ebay.fr", "ebay.ca", "ebay.com.au"].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  )
    throw new Error("Unexpected eBay listing URL");
  const [, listingId, variationId] = item.itemId.split("|");
  const urlId = /^\/itm\/(?:[^/]+\/)?(\d+)\/?$/u.exec(url.pathname)?.[1];
  if (!urlId || urlId !== listingId) throw new Error("eBay listing ID and URL disagree");
  const fixed = item.buyingOptions?.includes("FIXED_PRICE") === true;
  return {
    item_id: item.itemId,
    listing_id: listingId,
    variation_id: variationId === "0" ? null : variationId,
    title: item.title,
    url: item.itemWebUrl,
    source: "ebay",
    price_minor: fixed && item.price ? priceMinor(item.price.value, item.price.currency) : null,
    currency: item.price?.currency ?? null,
    price_kind: fixed ? "asking" : "auction_or_unknown",
    condition_text: item.condition ?? null,
    location: item.itemLocation ?? null,
    images: [
      item.image?.imageUrl,
      ...(item.additionalImages ?? []).map((image) => image.imageUrl),
    ].filter((value): value is string => value !== undefined),
    seller: item.seller ?? null,
    raw: item,
    note: "API evidence, not a completed inspection. Verify attributes, availability, complete costs and every image before importing an alert candidate. Use listing_id for the canonical observation ID; item_id is the API identifier. Prices for a variation apply only to that verified variation. Buyer browser sign-in is separate from this application token.",
  };
}
