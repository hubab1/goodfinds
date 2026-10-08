import { z } from "zod";
import { browserSchema, marketplaceSchema, accessAvailable } from "./integrations.ts";
import type { GoodfindsState } from "./state.ts";

const minor = z.number().int().nonnegative().max(100_000_000);
export const listingContactReportSchema = z
  .object({
    listing_key: z.string().min(1).max(300),
    listing_url: z.url().max(2000),
    marketplace: marketplaceSchema,
    browser: browserSchema,
    host: z.string().trim().min(1).max(120),
    profile: z.string().trim().min(1).max(120),
    message: z.enum(["available", "unavailable", "unknown"]),
    offer: z.enum(["available", "unavailable", "unknown"]),
    offer_note: z.enum(["available", "unavailable", "unknown"]).default("unknown"),
    message_auth: z.enum(["required", "not_required", "unknown"]).default("required"),
    offer_auth: z.enum(["required", "not_required", "unknown"]).default("required"),
    external_contact: z.boolean(),
    evidence: z.string().trim().min(1).max(2000),
    offer_limits: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/u),
        minimum_minor: minor.nullable(),
        maximum_minor: minor.nullable(),
        step_minor: minor.positive().default(1),
        remaining_offers: z.number().int().nonnegative().nullable(),
        evidence: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const limits = report.offer_limits;
    if (limits && report.offer !== "available")
      ctx.addIssue({ code: "custom", message: "Offer limits need an observed offer interface" });
    if (report.offer_note === "available" && report.offer !== "available")
      ctx.addIssue({ code: "custom", message: "An offer note needs an observed offer interface" });
    if (
      limits?.minimum_minor != null &&
      limits.maximum_minor != null &&
      limits.minimum_minor > limits.maximum_minor
    )
      ctx.addIssue({ code: "custom", message: "Offer minimum exceeds the maximum" });
  });
export const savedListingContactSchema = listingContactReportSchema.safeExtend({
  checked_at: z.iso.datetime(),
  context_id: z.string(),
});
export type ListingContact = z.infer<typeof savedListingContactSchema>;
export const contactConfigShape = {
  listing_contacts: z.array(savedListingContactSchema).max(5000).optional(),
};
type Target = {
  key: string;
  url: string;
  source?: string | undefined;
  availability?: string | null | undefined;
  currency?: string | null | undefined;
};
type Context = {
  config: Pick<
    GoodfindsState["config"],
    "platforms" | "browser_preference" | "browser_access" | "platform_sessions" | "listing_contacts"
  >;
  context_id: string;
  now: number;
  mode: "live" | "sample";
};

export function sameListingUrl(first: string, second: string): boolean {
  try {
    const a = new URL(first),
      b = new URL(second);
    return (
      a.protocol === "https:" &&
      b.protocol === "https:" &&
      !a.username &&
      !b.username &&
      !a.password &&
      !b.password &&
      a.origin === b.origin &&
      a.pathname.replace(/\/$/u, "") === b.pathname.replace(/\/$/u, "")
    );
  } catch {
    return false;
  }
}
export function listingContactState(
  target: Target,
  context: Context,
  selectedBrowser?: "in_app" | "external",
) {
  const source = marketplaceSchema.safeParse(target.source ?? "facebook_marketplace");
  const unavailable = {
    message: false,
    offer: false,
    observation: undefined as ListingContact | undefined,
    reason: "Contact options need checking",
    check_needed: true,
  };
  if (!source.success)
    return { ...unavailable, reason: "Marketplace is unsupported", check_needed: false };
  if (target.availability !== "active")
    return { ...unavailable, reason: "Recheck listing availability", check_needed: true };
  if (context.config.platforms[source.data]?.enabled === false)
    return { ...unavailable, reason: "Marketplace is disabled", check_needed: false };
  if (context.mode === "sample")
    return {
      ...unavailable,
      message: source.data === "facebook_marketplace",
      reason: "Fictional manual practice",
      check_needed: false,
    };
  const preference = context.config.platforms[source.data]?.browser;
  const browser =
    selectedBrowser ??
    (preference && preference !== "default" ? preference : context.config.browser_preference);
  const observation = context.config.listing_contacts?.findLast(
    (r) => r.listing_key === target.key && r.marketplace === source.data && r.browser === browser,
  );
  if (
    !observation ||
    observation.context_id !== context.context_id ||
    !sameListingUrl(observation.listing_url, target.url) ||
    context.now < Date.parse(observation.checked_at) ||
    context.now - Date.parse(observation.checked_at) > 30 * 60_000
  )
    return unavailable;
  const result = { ...unavailable, observation };
  if (observation.message === "unavailable" && observation.offer === "unavailable")
    return {
      ...result,
      reason: observation.external_contact
        ? "Contact is outside the marketplace"
        : "Seller contact is unavailable",
      check_needed: false,
    };
  const access = context.config.browser_access.filter(
    (r) => r.host === observation.host && r.profile === observation.profile,
  );
  if (
    !accessAvailable(access, browser, context.context_id, context.now, new URL(target.url).hostname)
  )
    return { ...result, reason: "Check access to the selected browser and site" };
  const session = context.config.platform_sessions.findLast(
    (r) =>
      r.marketplace === source.data &&
      r.browser === browser &&
      r.host === observation.host &&
      r.profile === observation.profile,
  );
  if (
    !session ||
    session.context_id !== context.context_id ||
    !["signed_in", "signed_out"].includes(session.status) ||
    context.now < Date.parse(session.checked_at) ||
    context.now - Date.parse(session.checked_at) > 30 * 60_000
  )
    return { ...result, reason: "Verify sign-in in the selected browser profile" };
  const message =
    observation.message === "available" &&
    (session.status === "signed_in" ||
      (source.data !== "facebook_marketplace" &&
        source.data !== "craigslist" &&
        observation.message_auth === "not_required"));
  const offer =
    observation.offer === "available" &&
    observation.offer_limits?.remaining_offers !== 0 &&
    (session.status === "signed_in" || observation.offer_auth === "not_required");
  return {
    observation,
    message,
    offer,
    reason:
      observation.offer_limits?.remaining_offers === 0
        ? "No offers remain for this listing"
        : !message && !offer
          ? "Verify sign-in or this route's guest access"
          : "",
    check_needed:
      observation.message === "unknown" ||
      observation.offer === "unknown" ||
      (observation.message === "available" && !message) ||
      (observation.offer === "available" &&
        !offer &&
        observation.offer_limits?.remaining_offers !== 0),
  };
}

export function validatePlatformOffer(
  contact: ListingContact,
  priceMinor: number,
  currency: string,
): string | null {
  if (contact.offer !== "available") return "This listing does not expose an offer interface";
  const limits = contact.offer_limits;
  if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0)
    return "Enter a positive amount in minor units";
  if (!limits) return "Offer limits need checking in the platform interface";
  if (limits.currency !== currency) return "Offer currency differs from the platform interface";
  if (limits.remaining_offers === 0) return "No offers remain for this listing";
  if (limits.minimum_minor !== null && priceMinor < limits.minimum_minor)
    return "Offer is below the platform minimum";
  if (limits.maximum_minor !== null && priceMinor > limits.maximum_minor)
    return "Offer is above the platform maximum";
  if ((priceMinor - (limits.minimum_minor ?? 0)) % limits.step_minor)
    return "Offer does not match the platform increment";
  return null;
}

export function sellerApproach(contact: {
  message: boolean;
  offer: boolean;
  observation?: ListingContact | undefined;
}): "offer_with_note" | "offer_and_message" | "offer_only" | "message_only" | "unavailable" {
  if (contact.offer) {
    if (contact.observation?.offer_note === "available") return "offer_with_note";
    if (contact.message) return "offer_and_message";
    return "offer_only";
  }
  return contact.message ? "message_only" : "unavailable";
}
