import type { Conversation, SellerAction } from "./seller-conversation.ts";
import { collectionExpired, pendingAction } from "./seller-conversation.ts";
import { accessAvailable, marketplaceSchema } from "./integrations.ts";
import { listingContactState, sameListingUrl } from "./marketplace-actions.ts";
import type { GoodfindsState } from "./state.ts";
import { blocker, describeAction, workflow } from "./workflow-model.ts";
import type { Blocker } from "./workflow-model.ts";

import { sellerGuards, sellerEvents } from "./seller-action-states.ts";
export {
  sellerActionStatuses,
  sellerStates,
  sellerGuards,
  sellerEvents,
} from "./seller-action-states.ts";
export type SellerEvent = keyof typeof sellerEvents;
export type SellerContext = {
  now: number;
  config?: GoodfindsState["config"] | undefined;
  context_id?: string | undefined;
  mode?: "live" | "sample" | undefined;
  availability?: string | null | undefined;
  expected_version?: number | undefined;
  worker_id?: string | undefined;
  lease_token?: string | undefined;
  identity?: NonNullable<SellerAction["identity"]> | undefined;
  result?: "sent" | "checked" | "not_sent" | "uncertain" | "blocked" | undefined;
  evidence?: string | undefined;
  proposed?: boolean | undefined;
  reviewed?: boolean | undefined;
};
const issue = (code: keyof typeof sellerGuards, kind: Blocker["kind"] = "blocked") =>
  blocker(sellerGuards, code, kind);
function facebook(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
      ? url
      : null;
  } catch {
    return null;
  }
}
function sameProfile(a: string, b: string): boolean {
  const first = facebook(a),
    second = facebook(b);
  return (
    !!first &&
    !!second &&
    first.pathname.replace(/\/$/u, "") === second.pathname.replace(/\/$/u, "") &&
    (first.pathname !== "/profile.php" ||
      first.searchParams.get("id") === second.searchParams.get("id"))
  );
}
export function sellerIdentityBlockers(
  c: Conversation,
  a: SellerAction,
  identity?: SellerContext["identity"],
): Blocker[] {
  if (!identity) return [issue("identity_unverified", "input")];
  const listing = facebook(identity.listing_url);
  if (
    listing?.pathname.match(/\/marketplace\/item\/(\d+)/u)?.[1] !== c.target.listing_id ||
    identity.listing_id !== c.target.listing_id ||
    !facebook(identity.seller_profile_url) ||
    !facebook(identity.thread_url)
  )
    return [issue("listing_identity")];
  if (
    c.target.seller_profile_url &&
    !sameProfile(c.target.seller_profile_url, identity.seller_profile_url)
  )
    return [issue("seller_identity")];
  for (const established of [c.actions.find((x) => x.identity)?.identity, a.identity]) {
    if (
      established &&
      (!sameProfile(established.seller_profile_url, identity.seller_profile_url) ||
        !sameProfile(established.thread_url, identity.thread_url) ||
        established.buyer_identity !== identity.buyer_identity ||
        established.host !== identity.host ||
        established.profile !== identity.profile)
    )
      return [issue("identity_mismatch")];
  }
  return [];
}
export function sellerRouteBlockers(
  c: Conversation,
  a: SellerAction,
  context: SellerContext,
): Blocker[] {
  if (context.mode === "sample") return [issue("sample_only")];
  if (c.target.source !== "facebook_marketplace") return [issue("manual_only")];
  const url = facebook(c.target.url);
  if (!url || url.pathname.match(/\/marketplace\/item\/(\d+)/u)?.[1] !== c.target.listing_id)
    return [issue("identity_mismatch")];
  const config = context.config;
  if (!config || !context.context_id || context.mode === undefined)
    return [issue("browser_unverified", "input")];
  if (config.platforms.facebook_marketplace?.enabled === false)
    return [issue("marketplace_disabled")];
  if (
    !accessAvailable(
      config.browser_access,
      a.browser,
      context.context_id,
      context.now,
      url.hostname,
    )
  )
    return [issue("browser_unverified")];
  const contact = listingContactState(
    { key: c.listing_key, url: c.target.url, source: c.target.source, availability: "active" },
    { config, context_id: context.context_id, now: context.now, mode: "live" },
    a.browser,
  );
  if (!contact.message)
    return [
      {
        ...issue("contact_unverified"),
        message: contact.reason || sellerGuards.contact_unverified.message,
      },
    ];
  const account = config.platform_sessions.findLast(
    (report) =>
      report.marketplace === c.target.source &&
      report.browser === a.browser &&
      report.host === contact.observation?.host &&
      report.profile === contact.observation.profile,
  );
  if (account?.status !== "signed_in") return [issue("signin_unverified")];
  if (
    context.identity &&
    (contact.observation?.host !== context.identity.host ||
      contact.observation.profile !== context.identity.profile)
  )
    return [issue("profile_mismatch")];
  return [];
}
export function sellerDraftBlockers(
  c: Conversation,
  draft: SellerAction["draft"],
  context: SellerContext,
): Blocker[] {
  const result: Blocker[] = [];
  if (!draft) result.push(issue("draft_missing"));
  else if (collectionExpired(draft.collection, context.now))
    result.push(issue("collection_expired"));
  if (context.availability !== "active")
    result.push(
      issue("availability_unchecked", context.availability === undefined ? "input" : "blocked"),
    );
  const latest = c.messages.findLast((m) => m.direction === "incoming");
  if (latest && latest.id !== draft?.responds_to) result.push(issue("reply_unreviewed"));
  return result;
}
export function sellerLeaseBlockers(a: SellerAction, context: SellerContext): Blocker[] {
  if (!a.lease_expires_at || Date.parse(a.lease_expires_at) <= context.now)
    return [issue("lease_expired")];
  if (context.lease_token === undefined) return [issue("lease_input", "input")];
  return a.lease_token === context.lease_token ? [] : [issue("lease_expired")];
}
export function expiredSellerAction(a: SellerAction, now: number): SellerAction {
  if (
    !["running", "ready_to_send"].includes(a.status) ||
    !a.lease_expires_at ||
    Date.parse(a.lease_expires_at) > now
  )
    return a;
  return {
    ...a,
    status: a.kind === "send" ? sellerEvents.expire.to[0] : sellerEvents.expire.to[1],
    reason: "Execution interrupted or lease expired; verify the thread",
  };
}
export function sellerBlockers(
  c: Conversation,
  event: SellerEvent,
  context: SellerContext,
  action = pendingAction(c),
): Blocker[] {
  c = { ...c, actions: c.actions.map((a) => expiredSellerAction(a, context.now)) };
  const result: Blocker[] = [];
  if (["inspect", "handoff", "expire"].includes(event)) return result;
  if (
    [
      "save_draft",
      "collection_plan",
      "arrange",
      "request_send",
      "request_check",
      "outcome",
    ].includes(event)
  ) {
    if (context.expected_version === undefined) result.push(issue("conversation_changed", "input"));
    else if (context.expected_version !== c.version) result.push(issue("conversation_changed"));
    const pending = pendingAction(c);
    if (["save_draft", "collection_plan"].includes(event) && pending?.kind === "send")
      result.push(issue("pending_send"));
    if (["request_send", "request_check", "arrange", "outcome"].includes(event) && pending)
      result.push(issue("pending_action"));
    if (["request_send", "request_check", "arrange"].includes(event) && c.outcome !== "open")
      result.push(issue("conversation_closed"));
    if (["save_draft", "collection_plan", "outcome"].includes(event) && !context.proposed)
      result.push(issue("input_required", "input"));
    if (["request_send", "request_check"].includes(event) && !context.proposed)
      result.push(issue("input_required", "input"));
    if (event === "request_send") {
      result.push(...sellerDraftBlockers(c, c.draft, context));
      if (!context.reviewed) result.push(issue("review_required", "input"));
      if (context.mode !== "sample") {
        const config = context.config;
        const source = marketplaceSchema.safeParse(c.target.source);
        const platform = source.success ? config?.platforms[source.data] : undefined;
        const browser =
          platform?.browser && platform.browser !== "default"
            ? platform.browser
            : config?.browser_preference;
        const contact = config?.listing_contacts?.findLast(
          (report) => report.listing_key === c.listing_key && report.browser === browser,
        );
        if (
          !contact ||
          contact.context_id !== context.context_id ||
          !sameListingUrl(contact.listing_url, c.target.url) ||
          contact.marketplace !== c.target.source ||
          contact.message !== "available" ||
          context.now < Date.parse(contact.checked_at) ||
          context.now - Date.parse(contact.checked_at) > 30 * 60_000
        )
          result.push(issue("contact_unverified", !config ? "input" : "blocked"));
        if (platform?.enabled === false) result.push(issue("marketplace_disabled"));
      }
    }
    return result;
  }
  if (!action) return [issue("action_unclaimed")];
  const a = expiredSellerAction(action, context.now);
  if (event === "cancel")
    return ["awaiting_handoff", "requested", "blocked"].includes(a.status)
      ? []
      : [issue("uncertain_send")];
  if (event === "claim") {
    if (a.worker_id && a.lease_expires_at && Date.parse(a.lease_expires_at) > context.now)
      result.push(issue("executor_active"));
    result.push(...sellerRouteBlockers(c, a, context));
    if (!context.worker_id) result.push(issue("executor_input", "input"));
  }
  if (event === "permit" || event === "result") {
    result.push(...sellerLeaseBlockers(a, context));
    if (event === "permit") {
      if (a.kind !== "send" || a.status !== "running") result.push(issue("permit_already_issued"));
      result.push(
        ...sellerRouteBlockers(c, a, context),
        ...sellerIdentityBlockers(c, a, context.identity),
        ...sellerDraftBlockers(c, a.draft, context),
      );
      if (c.outcome !== "open") result.push(issue("conversation_closed"));
    } else {
      if (!["running", "ready_to_send", "uncertain"].includes(a.status))
        result.push(issue("action_unclaimed"));
      if (!context.result || !context.evidence) result.push(issue("evidence_required", "input"));
      if (context.result === "blocked" && a.status !== "running")
        result.push(issue("uncertain_send"));
      if (
        context.result === "sent" &&
        (a.kind !== "send" ||
          !["ready_to_send", "uncertain"].includes(a.status) ||
          !a.draft ||
          !context.evidence?.includes(a.draft.text))
      )
        result.push(issue("evidence_required"));
      if (context.result === "checked" && a.kind !== "check")
        result.push(issue("evidence_required"));
      if (
        ["sent", "checked"].includes(context.result ?? "") ||
        (context.result === "not_sent" && a.kind === "send")
      ) {
        const identity =
          context.identity ?? (context.result === "sent" ? (a.identity ?? undefined) : undefined);
        result.push(
          ...sellerIdentityBlockers(c, a, identity),
          ...sellerRouteBlockers(c, a, { ...context, identity }),
        );
      }
    }
  }
  return result;
}
export function sellerWorkflow(c: Conversation, context: SellerContext) {
  c = { ...c, actions: c.actions.map((a) => expiredSellerAction(a, context.now)) };
  const saved = pendingAction(c) ?? c.actions.at(-1);
  const action = saved ? expiredSellerAction(saved, context.now) : undefined;
  const state = action?.status ?? "idle";
  const actions = Object.entries(sellerEvents).flatMap(([event, definition]) => {
    if (!definition.operation || !(definition.from as readonly string[]).includes(state)) return [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Entries are keys of the typed registry.
    const name = event as SellerEvent;
    return [
      describeAction(
        name,
        action?.kind === "check" && ["claim", "result"].includes(name)
          ? { ...definition, execution_profile: "collection" }
          : definition,
        sellerGuards,
        sellerBlockers(c, name, context, action),
      ),
    ];
  });
  return {
    ...workflow(state, actions),
    conversation_phase: c.phase,
    buying_outcome: c.outcome,
    action_id: action?.id ?? null,
  };
}
