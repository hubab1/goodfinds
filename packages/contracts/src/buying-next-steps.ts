import { z } from "zod";
import { isVisible } from "./search-definition.ts";
import { offerMessage, sellerMessageDraftSchema } from "./seller-conversation.ts";
import { openingQuestions, verificationChecks } from "./verification.ts";
import type { Decision, Listing, GoodfindsState, SavedSearch } from "./state.ts";
import type { SellerConversationSummary } from "./seller-conversation.ts";
type BuyingListing = Pick<Listing, "key" | "title" | "url" | "product"> &
  Partial<
    Pick<
      Listing,
      | "price_minor"
      | "currency"
      | "price_period"
      | "description"
      | "availability"
      | "check_outcome"
      | "verification_checks"
      | "attributes"
      | "evidence"
      | "condition"
      | "functional"
    >
  > & { field_evidence?: unknown; observation_conflict?: unknown };

export const buyingNextStepSchema = z.object({
  asking_price_minor: z.number().nullable().default(null),
  proposed_price_minor: z.number().nullable().default(null),
  agreed_price_minor: z.number().nullable().default(null),
  currency: z.string().default("GBP"),
  listing_key: z.string(),
  search_id: z.string().nullable(),
  title: z.string(),
  url: z.string(),
  label: z.string(),
  readiness: z.enum(["ready_to_offer", "verify_and_negotiate", "conversation"]),
  reasons: z.array(z.string()),
  questions: z.array(z.string()),
  draft_text: z.string().nullable(),
  priority: z.number(),
});
export type BuyingNextStep = z.infer<typeof buyingNextStepSchema>;

export function searchOfferPrice(search: SavedSearch, includeTarget = true): number | null {
  const targetField = search.definition.fields.find(
    (field) =>
      field.id === "target_price_minor" && isVisible(field, search.values, search.definition),
  );
  const target = targetField && search.values[targetField.id];
  if (includeTarget && typeof target === "number" && Number.isFinite(target) && target > 0)
    return target;
  const prices = search.definition.fields.flatMap((field) => {
    if (
      field.match?.attribute !== "price_minor" ||
      field.match.importance !== "required" ||
      !isVisible(field, search.values, search.definition)
    )
      return [];
    const answer = search.values[field.id];
    const limit =
      field.match.operator === "lte" && typeof answer === "number"
        ? answer
        : field.match.operator === "range" &&
            answer &&
            typeof answer === "object" &&
            !Array.isArray(answer)
          ? answer.max
          : null;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? [limit] : [];
  });
  return prices.length ? Math.min(...prices) : null;
}

export function openingOfferPrice(listing: BuyingListing, search: SavedSearch): number | null {
  const asking = listing.price_minor ?? null;
  if (
    search.definition.price.currency !== (listing.currency ?? "GBP") ||
    search.definition.price.period !== (listing.price_period ?? "once")
  )
    return asking;
  const target = searchOfferPrice(search);
  return asking === null ? target : target === null ? asking : Math.min(asking, target);
}

export function openingMessagePrice(
  listing: BuyingListing,
  proposed: number | null,
): number | null {
  if (
    proposed === null ||
    listing.price_minor == null ||
    proposed >= listing.price_minor ||
    /\b(price (?:is )?firm|no offers|non[- ]negotiable)\b/iu.test(listing.description ?? "")
  )
    return null;
  return proposed;
}

function conflictingFields(listing: BuyingListing): string[] {
  const fields = listing.field_evidence;
  if (!fields || typeof fields !== "object") return [];
  return Object.entries(fields)
    .filter(
      ([, value]: [string, unknown]) =>
        value !== null &&
        typeof value === "object" &&
        "state" in value &&
        value.state === "conflicting",
    )
    .map(([field]) => field.replaceAll("_", " "));
}
export function evidenceConflicts(listing: BuyingListing): string[] {
  return [
    ...(listing.verification_checks ?? [])
      .filter((check) => check.state === "conflicting")
      .map((check) => check.label),
    ...conflictingFields(listing),
    ...(listing.observation_conflict === true ? ["Listing observations"] : []),
  ];
}

export function buyingQuestions(
  listing: BuyingListing,
  search: SavedSearch,
  _reasons: string[] = [],
): string[] {
  const checks = verificationChecks(listing, search.discovery?.verification_checks);
  const unresolved = (id: string) =>
    checks.some((check) => check.id === id && ["unknown", "conflicting"].includes(check.state));
  const conflicts = conflictingFields(listing);
  const questions: string[] = [];
  if (listing.product === "vehicle") {
    if (unresolved("clean_history"))
      questions.push("Has it ever been written off, categorised or accident-damaged?");
    const automatic = search.definition.fields.some(
      (field) =>
        field.match?.attribute === "transmission" && search.values[field.id] === "automatic",
    );
    if (
      automatic &&
      (listing.attributes?.["transmission"] !== "automatic" ||
        unresolved("automatic_gearbox") ||
        unresolved("transmission") ||
        conflicts.includes("transmission"))
    )
      questions.push("Can you confirm it has an automatic gearbox?");
    if (
      unresolved("fully_functioning") ||
      (!checks.some((check) => check.id === "fully_functioning") &&
        ["functional", "functionality", "working", "working_condition"].some(unresolved))
    )
      questions.push("Does it run and drive without any faults?");
  } else {
    questions.push(...openingQuestions(checks));
  }
  const clarification: Record<string, string> = {
    mileage: "What is the current mileage?",
    "mileage unit": "Is the mileage shown in miles or kilometres?",
    transmission: "Is the gearbox automatic or manual?",
    year: "What is the registration year?",
  };
  for (const field of conflicts) {
    if (
      field === "transmission" &&
      questions.includes("Can you confirm it has an automatic gearbox?")
    )
      continue;
    questions.push(clarification[field] ?? `Could you confirm the ${field}?`);
  }
  return [...new Set(questions)].slice(0, 2);
}

export function openingDraft(listing: BuyingListing, search: SavedSearch, reasons: string[] = []) {
  const price = openingMessagePrice(listing, openingOfferPrice(listing, search));
  const draft = sellerMessageDraftSchema.parse({
    search_id: search.id,
    price_minor: price,
    currency: listing.currency ?? "GBP",
    price_period: listing.price_period ?? "once",
    intent: price === null ? "message" : "offer",
    collection: null,
    responds_to: null,
    verification_questions: buyingQuestions(listing, search, reasons),
    text: "Draft",
  });
  draft.text = offerMessage(draft, listing.title);
  return draft;
}

type BuyingContext = {
  searches: SavedSearch[];
  decisions: (Pick<
    Decision,
    | "search_id"
    | "suitability"
    | "verification"
    | "status"
    | "reasons"
    | "preference_score"
    | "setup_total_minor"
  > & { listing: BuyingListing })[];
  seller_conversations: SellerConversationSummary[];
  config: Pick<GoodfindsState["config"], "feedback">;
  search_runs: GoodfindsState["search_runs"];
};
export function fulfilledSearches(conversations: SellerConversationSummary[]): Set<string> {
  return new Set(
    conversations.filter((item) => item.outcome === "bought").flatMap((item) => item.search_ids),
  );
}

export function recommendations(
  state: BuyingContext,
  searchId?: string,
  keys?: string[],
): BuyingNextStep[] {
  const fulfilled = fulfilledSearches(state.seller_conversations);
  const searches = new Map(state.searches.map((search) => [search.id, search]));
  const conversations = new Map(state.seller_conversations.map((item) => [item.listing_key, item]));
  const allowed = keys ? new Set(keys) : null;
  const candidates = state.decisions
    .filter((decision) => {
      const listing = decision.listing,
        search = searches.get(decision.search_id);
      if (
        !search ||
        fulfilled.has(search.id) ||
        (searchId && search.id !== searchId) ||
        (allowed && !allowed.has(listing.key))
      )
        return false;
      if (
        !search.enabled &&
        !state.search_runs.some(
          (run) =>
            run.search_id === search.id &&
            run.listing_keys.includes(listing.key) &&
            ["completed", "partial"].includes(run.phase),
        )
      )
        return false;
      const conversation = conversations.get(listing.key);
      return (
        listing.availability === "active" &&
        (!listing.check_outcome || listing.check_outcome === "success") &&
        (decision.suitability
          ? decision.suitability !== "unsuitable"
          : ["qualifies", "not_deal", "insufficient_comparables"].includes(decision.status)) &&
        (!conversation || conversation.outcome === "open") &&
        state.config.feedback.findLast(
          (item) => item.search_id === search.id && item.listing_key === listing.key,
        )?.action !== "dismiss"
      );
    })
    .toSorted(
      (a, b) =>
        Number(evidenceConflicts(a.listing).length > 0) -
          Number(evidenceConflicts(b.listing).length > 0) ||
        Number(b.suitability === "suitable") - Number(a.suitability === "suitable") ||
        (b.preference_score ?? 0) - (a.preference_score ?? 0) ||
        Number(b.verification === "complete") - Number(a.verification === "complete") ||
        (a.setup_total_minor ?? a.listing.price_minor ?? Infinity) -
          (b.setup_total_minor ?? b.listing.price_minor ?? Infinity) ||
        a.listing.key.localeCompare(b.listing.key),
    );
  const seen = new Set<string>();
  return candidates
    .filter((decision) => {
      if (seen.has(decision.listing.key)) return false;
      seen.add(decision.listing.key);
      return true;
    })
    .slice(0, 3)
    .map((decision) => {
      const search = searches.get(decision.search_id);
      if (!search) throw new Error("A buying recommendation needs its saved search");
      const questions = buyingQuestions(decision.listing, search, decision.reasons);
      const ready =
        decision.suitability === "suitable" &&
        decision.verification === "complete" &&
        !questions.length;
      const price = openingDraft(decision.listing, search, decision.reasons).price_minor;
      return {
        asking_price_minor: decision.listing.price_minor ?? null,
        proposed_price_minor: price,
        agreed_price_minor: null,
        currency: decision.listing.currency ?? "GBP",
        listing_key: decision.listing.key,
        search_id: search.id,
        title: decision.listing.title,
        url: decision.listing.url,
        label: ready ? (price === null ? "Review message" : "Review offer") : "Verify details",
        readiness: ready ? ("ready_to_offer" as const) : ("verify_and_negotiate" as const),
        reasons: [
          ...evidenceConflicts(decision.listing).map(
            (label) => `${label}: conflicting evidence needs review`,
          ),
          ...decision.reasons,
        ],
        questions,
        draft_text: null,
        priority: evidenceConflicts(decision.listing).length ? 6 : 4,
      };
    });
}

export function buyingNextSteps(state: BuyingContext): BuyingNextStep[] {
  const fulfilled = fulfilledSearches(state.seller_conversations);
  const items: BuyingNextStep[] = state.seller_conversations
    .filter(
      (item) =>
        item.outcome === "open" &&
        (!item.search_ids.some((id) => fulfilled.has(id)) ||
          item.pending_action?.status === "uncertain") &&
        (item.draft_text || item.first_sent_at || item.pending_action),
    )
    .map((item) => ({
      asking_price_minor:
        state.decisions.find((decision) => decision.listing.key === item.listing_key)?.listing
          .price_minor ?? null,
      proposed_price_minor: item.phase === "accepted" ? null : item.price_minor,
      agreed_price_minor: item.agreed_price_minor,
      currency: item.currency,
      listing_key: item.listing_key,
      search_id: item.search_ids[0] ?? null,
      title: item.title,
      url: item.url,
      label: item.action_label,
      readiness:
        !item.first_sent_at &&
        (item.verification_questions.length > 0 ||
          state.decisions.some(
            (decision) =>
              decision.listing.key === item.listing_key &&
              item.search_ids.includes(decision.search_id) &&
              decision.verification !== "complete",
          ))
          ? "verify_and_negotiate"
          : "conversation",
      reasons: [
        item.label,
        ...(!item.first_sent_at
          ? (state.decisions.find(
              (decision) =>
                decision.listing.key === item.listing_key &&
                item.search_ids.includes(decision.search_id),
            )?.reasons ?? [])
          : []),
      ],
      questions: item.verification_questions,
      draft_text: item.draft_text,
      priority:
        item.label === "Check send" || item.label === "Action needed"
          ? 0
          : ["Counteroffer", "Needs reply", "Needs review"].includes(item.label)
            ? 1
            : item.phase === "accepted"
              ? 2
              : item.first_sent_at
                ? 5
                : state.decisions.some(
                      (d) =>
                        d.listing.key === item.listing_key &&
                        evidenceConflicts(d.listing).length > 0,
                    )
                  ? 6
                  : 3,
    }));
  const seen = new Set(items.map((item) => item.listing_key));
  for (const item of recommendations(state))
    if (!seen.has(item.listing_key)) {
      items.push(item);
      seen.add(item.listing_key);
    }
  return items.toSorted((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}
