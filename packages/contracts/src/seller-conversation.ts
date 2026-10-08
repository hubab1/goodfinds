import { z } from "zod";
import { sellerActionStatuses } from "./seller-action-states.ts";
import { browserSchema } from "./integrations.ts";
import { workerExecutionSchema } from "./worker-execution.ts";

const amount = z.number().int().positive().max(100_000_000);
const text = z.string().trim().min(1).max(5000);
export const collectionSchema = z
  .object({
    date: z.iso.date(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
      .nullable(),
    end_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
      .nullable(),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions();
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid time zone"),
  })
  .strict()
  .refine(
    (v) => !v.end_time || (v.time !== null && v.end_time > v.time),
    "Collection window must end after it starts",
  );
export const sellerMessageDraftSchema = z
  .object({
    search_id: z.string().nullable().optional(),
    collection_purpose: z.enum(["viewing", "collection"]).optional(),
    price_minor: amount.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    price_period: z.string().max(30),
    collection: collectionSchema.nullable(),
    text,
    intent: z.enum(["offer", "accept", "decline", "message", "arrange"]),
    responds_to: z.string().nullable(),
    verification_questions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  })
  .strict()
  .refine(
    (v) => !["offer", "accept"].includes(v.intent) || v.price_minor !== null,
    "Enter an offer price",
  );
export type SellerMessageDraft = z.infer<typeof sellerMessageDraftSchema>;
export const replyFacetsSchema = z
  .object({
    price: z.enum(["none", "accept", "counter", "decline", "firm"]),
    price_minor: amount.nullable(),
    availability: z.enum(["unknown", "available", "unavailable"]),
    collection: z.enum(["none", "question", "proposal", "confirmed"]),
    information_request: z.boolean(),
    unclear: z.boolean(),
    supporting_text: z.string().max(5000),
  })
  .strict();
export const EMPTY_FACETS: z.infer<typeof replyFacetsSchema> = {
  price: "none",
  price_minor: null,
  availability: "unknown",
  collection: "none",
  information_request: false,
  unclear: true,
  supporting_text: "",
};
export const sellerMessageInputSchema = z
  .object({
    external_id: z.string().min(1).max(300),
    text,
    platform_at: z.iso.datetime().nullable(),
    facets: replyFacetsSchema,
  })
  .strict();
export const sellerIdentitySchema = z
  .object({
    listing_url: z.url(),
    listing_id: z.string().min(1),
    seller_profile_url: z.url(),
    buyer_identity: z.string().trim().min(1).max(200),
    thread_url: z.url(),
    host: z.string().min(1).max(120),
    profile: z.string().min(1).max(120),
    evidence: z.string().trim().min(1).max(2000),
  })
  .strict();
export const sellerActionStatusSchema = z.enum(sellerActionStatuses);
export const sellerActionSchema = z.object({
  id: z.string(),
  kind: z.enum(["send", "check"]),
  status: sellerActionStatusSchema,
  requested_at: z.string(),
  started_at: z.string().nullable(),
  confirmed_sent_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  browser: browserSchema,
  manual_only: z.boolean().default(false),
  worker_id: z.string().nullable(),
  execution: workerExecutionSchema.optional(),
  lease_token: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  draft: sellerMessageDraftSchema.nullable(),
  identity: sellerIdentitySchema.nullable(),
  evidence: z.string().nullable(),
  reason: z.string().nullable(),
});
export const sellerEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  observed_at: z.string(),
  actor: z.enum(["user", "browser", "assistant"]),
  text: z.string(),
  action_id: z.string().nullable(),
  message_id: z.string().nullable(),
});
export const sellerMessageSchema = sellerMessageInputSchema.extend({
  id: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  observed_at: z.string(),
  provenance: z.enum(["browser", "user_reported"]),
  action_id: z.string().nullable(),
  draft: sellerMessageDraftSchema.nullable(),
});
export const collectionPlanSchema = z
  .object({
    purpose: z.enum(["viewing", "collection"]),
    status: z.enum(["draft", "proposed", "confirmed"]),
    when: collectionSchema.nullable(),
    pickup_location: z.string().trim().min(1).max(500).nullable(),
    demonstration: z.string().trim().min(1).max(1000).nullable(),
    evidence: z.string().trim().min(1).max(2000).nullable(),
    seller_message_id: z.string().nullable(),
    provenance: z.enum(["user_reported", "seller_message"]),
  })
  .strict()
  .refine(
    (plan) =>
      plan.status !== "confirmed" || Boolean(plan.when && plan.pickup_location && plan.evidence),
    "A confirmed plan needs a date, pickup location and supporting evidence",
  );
export type CollectionPlan = z.infer<typeof collectionPlanSchema>;
export const conversationSchema = z.object({
  search_ids: z.array(z.string()).default([]),
  collection_plan: collectionPlanSchema.nullable().default(null),
  id: z.string(),
  listing_key: z.string(),
  version: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  target: z.object({
    listing_id: z.string(),
    url: z.string(),
    source: z.string(),
    title: z.string(),
    seller_profile_url: z.string().nullable(),
    currency: z.string(),
    price_period: z.string(),
  }),
  draft: sellerMessageDraftSchema.nullable(),
  actions: z.array(sellerActionSchema),
  messages: z.array(sellerMessageSchema),
  events: z.array(sellerEventSchema),
  phase: z.enum([
    "not_contacted",
    "awaiting_reply",
    "needs_review",
    "question",
    "counteroffer",
    "accepted",
    "declined",
  ]),
  outcome: z.enum(["open", "bought", "withdrawn", "unavailable"]),
  agreed_price_minor: amount.nullable(),
  first_sent_at: z.string().nullable(),
  latest_sent_at: z.string().nullable(),
  latest_incoming_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type SellerAction = z.infer<typeof sellerActionSchema>;
export const sellerConversationSummarySchema = conversationSchema
  .pick({
    id: true,
    listing_key: true,
    version: true,
    phase: true,
    outcome: true,
    agreed_price_minor: true,
    first_sent_at: true,
    latest_sent_at: true,
    latest_incoming_at: true,
    last_checked_at: true,
    updated_at: true,
  })
  .extend({
    search_ids: z.array(z.string()).default([]),
    collection_plan: collectionPlanSchema.nullable().default(null),
    title: z.string().default("Listing"),
    url: z.string().default(""),
    draft_text: z.string().nullable().default(null),
    verification_questions: z.array(z.string()).default([]),
    label: z.string(),
    action_label: z.string(),
    price_minor: amount.nullable(),
    currency: z.string(),
    pending_action: sellerActionSchema.nullable(),
  });
export type SellerConversationSummary = z.infer<typeof sellerConversationSummarySchema>;
export function pendingAction(c: Conversation): SellerAction | undefined {
  return c.actions.findLast((a) =>
    ["awaiting_handoff", "requested", "running", "ready_to_send", "uncertain"].includes(a.status),
  );
}
export function sellerSummary(c: Conversation, now = Date.now()): SellerConversationSummary {
  const pending = pendingAction(c);
  const expired = pending?.lease_expires_at && Date.parse(pending.lease_expires_at) <= now;
  let label: string;
  if (pending?.kind === "send" && (pending.status === "uncertain" || expired)) label = "Check send";
  else if (pending?.kind === "send")
    label = pending.manual_only
      ? "Message ready"
      : pending.status === "awaiting_handoff"
        ? "Continue in chat"
        : "Sending";
  else if (pending?.kind === "check")
    label = pending.status === "awaiting_handoff" ? "Continue in chat" : "Checking replies";
  else if (c.outcome !== "open")
    label = { bought: "Bought", withdrawn: "Withdrawn", unavailable: "Unavailable" }[c.outcome];
  else if (c.actions.at(-1)?.status === "blocked") label = "Action needed";
  else
    label = {
      not_contacted: c.draft ? "Draft" : "Not contacted",
      awaiting_reply: "Awaiting reply",
      needs_review: "Needs review",
      question: "Needs reply",
      counteroffer: "Counteroffer",
      accepted: "Offer accepted",
      declined: "Offer declined",
    }[c.phase];
  return {
    search_ids: c.search_ids,
    collection_plan: c.collection_plan,
    title: c.target.title,
    url: c.target.url,
    draft_text: c.draft?.text ?? null,
    verification_questions: c.draft?.verification_questions ?? [],
    id: c.id,
    listing_key: c.listing_key,
    version: c.version,
    phase: c.phase,
    outcome: c.outcome,
    agreed_price_minor: c.agreed_price_minor,
    first_sent_at: c.first_sent_at,
    latest_sent_at: c.latest_sent_at,
    latest_incoming_at: c.latest_incoming_at,
    last_checked_at: c.last_checked_at,
    updated_at: c.updated_at,
    label,
    action_label:
      c.outcome !== "open"
        ? "View history"
        : pending
          ? label === "Check send"
            ? "Verify send"
            : "Continue action"
          : c.phase === "accepted"
            ? c.collection_plan?.status === "confirmed"
              ? "Confirm purchase"
              : "Arrange collection"
            : c.phase === "counteroffer"
              ? "Review counteroffer"
              : ["question", "needs_review"].includes(c.phase)
                ? "Review reply"
                : c.phase === "awaiting_reply"
                  ? "Check replies"
                  : c.draft
                    ? "Review message"
                    : "Prepare message",
    price_minor:
      c.agreed_price_minor ??
      c.messages.findLast((m) => m.direction === "incoming")?.facets.price_minor ??
      c.draft?.price_minor ??
      null,
    currency: c.target.currency,
    pending_action: pending ?? null,
  };
}
export function localDay(now: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((p) => p.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function collectionExpired(
  collection: SellerMessageDraft["collection"],
  now: number,
): boolean {
  if (!collection) return false;
  const today = localDay(now, collection.timezone);
  if (collection.date !== today) return collection.date < today;
  if (!collection.time) return false;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: collection.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return clock >= (collection.end_time ?? collection.time);
}
export function currencyDivisor(currency: string): number {
  return (
    10 **
    (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2)
  );
}
export function offerMessage(draft: Omit<SellerMessageDraft, "text">, _title: string): string {
  const questions = [...new Set(draft.verification_questions ?? [])];
  const price =
    draft.price_minor === null
      ? ""
      : new Intl.NumberFormat("en-GB", { style: "currency", currency: draft.currency }).format(
          draft.price_minor / currencyDivisor(draft.currency),
        );
  const period =
    draft.price_period === "month"
      ? " per month"
      : draft.price_period === "week"
        ? " per week"
        : "";
  let message =
    draft.intent === "arrange"
      ? `Thanks, could we arrange ${draft.collection_purpose === "viewing" ? "a viewing" : "collection"}?`
      : draft.intent === "accept"
        ? `Thanks, ${price}${period} works for me${questions.length ? ", subject to confirming the details below" : ""}.`
        : draft.intent === "decline"
          ? "Thanks for getting back to me. I'll leave it for now."
          : draft.intent === "message" || draft.price_minor === null
            ? "Hi, is this still available?"
            : `Hi, would you consider ${price}${period}?`;
  if (questions.length && draft.intent !== "decline") {
    message += ` ${questions.join(" ")}`;
  }
  if (
    draft.collection &&
    draft.intent !== "decline" &&
    ["accept", "arrange"].includes(draft.intent)
  ) {
    const c = draft.collection;
    const day = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${c.date}T12:00:00Z`));
    message += ` ${questions.length ? "If those details check out, I can" : "I can"} ${draft.collection_purpose === "viewing" ? "view it" : "collect"} on ${day}${c.time ? (c.end_time ? ` between ${c.time} and ${c.end_time}` : ` around ${c.time}`) : ""}, if that suits you.`;
  }
  return message;
}

const base = {
  mode: z.enum(["live", "sample"]).default("live"),
  listing_key: z.string().min(1).max(300),
};
const version = z.number().int().nonnegative();
const actionBase = { ...base, action_id: z.uuid() };
export const sellerCommands = {
  plan: z.object({ ...base, expected_version: version, plan: collectionPlanSchema }).strict(),
  arrange: z.object({ ...base, expected_version: version }).strict(),
  get: z.object(base).strict(),
  save: z.object({ ...base, expected_version: version, draft: sellerMessageDraftSchema }).strict(),
  request: z
    .object({
      ...base,
      expected_version: version,
      request_id: z.uuid(),
      kind: z.enum(["send", "check"]),
    })
    .strict(),
  handoff: z.object({ ...actionBase }).strict(),
  cancel: z.object({ ...actionBase }).strict(),
  claim: z
    .object({
      ...actionBase,
      worker_id: z.string().min(1).max(200),
      execution: workerExecutionSchema.optional(),
    })
    .strict(),
  prepare: z
    .object({ ...actionBase, lease_token: z.uuid(), identity: sellerIdentitySchema })
    .strict(),
  complete: z
    .object({
      ...actionBase,
      lease_token: z.uuid(),
      result: z.enum(["sent", "checked", "not_sent", "uncertain", "blocked"]),
      evidence: z.string().trim().min(1).max(10000),
      identity: sellerIdentitySchema.optional(),
      messages: z.array(sellerMessageInputSchema).max(100).default([]),
    })
    .strict(),
  manual: z
    .object({
      ...base,
      expected_version: version,
      direction: z.enum(["incoming", "outgoing"]),
      message: sellerMessageInputSchema,
      action_id: z.uuid().optional(),
    })
    .strict(),
  correct: z
    .object({
      ...base,
      expected_version: version,
      message_id: z.string(),
      facets: replyFacetsSchema,
    })
    .strict(),
  outcome: z
    .object({
      ...base,
      expected_version: version,
      outcome: conversationSchema.shape.outcome,
      search_ids: z.array(z.string()).max(30).optional(),
    })
    .strict(),
};
