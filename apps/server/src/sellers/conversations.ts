import { SellerConversationRepository } from "./repository.ts";
import type { SellerConversationStorage } from "./repository.ts";
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import {
  sellerCommands,
  sellerSummary,
  EMPTY_FACETS,
  offerMessage,
} from "@goodfinds/contracts/seller-conversation";
import { openingDraft, buyingQuestions } from "@goodfinds/contracts/buying-next-steps";
import type { Conversation, SellerAction } from "@goodfinds/contracts/seller-conversation";
import { validation } from "../workspace/errors.ts";
import { iso } from "../workspace/model.ts";
import type { WorkspaceConfiguration, ListingObservation } from "../workspace/model.ts";
import {
  sellerBlockers,
  sellerDraftBlockers,
  sellerIdentityBlockers,
  sellerRouteBlockers,
  sellerLeaseBlockers,
  expiredSellerAction,
} from "@goodfinds/contracts/seller-action-model";
import { assertWorkflow } from "@goodfinds/contracts/workflow-model";

function classify(c: Conversation, m: Conversation["messages"][number]) {
  const f = m.facets;
  if (f.availability === "unavailable") c.outcome = "unavailable";
  if (f.unclear || ["counter", "firm", "decline"].includes(f.price)) c.agreed_price_minor = null;
  if (f.unclear) c.phase = "needs_review";
  else if (f.price === "counter" || f.price === "firm")
    c.phase = f.price_minor ? "counteroffer" : "needs_review";
  else if (f.price === "accept") {
    const agreed =
      f.price_minor ??
      c.messages.findLast(
        (x) =>
          x.direction === "outgoing" && x.draft && ["offer", "accept"].includes(x.draft.intent),
      )?.draft?.price_minor;
    if (agreed) {
      c.phase = "accepted";
      c.agreed_price_minor = agreed;
    } else c.phase = "needs_review";
  } else if (f.price === "decline") c.phase = "declined";
  else c.phase = f.collection !== "none" || f.information_request ? "question" : "needs_review";
}
function event(
  c: Conversation,
  now: number,
  kind: string,
  text: string,
  actor: "user" | "browser" | "assistant" = "user",
  action_id: string | null = null,
  message_id: string | null = null,
) {
  c.events.push({
    id: randomUUID(),
    kind,
    text,
    actor,
    action_id,
    message_id,
    observed_at: iso(now),
  });
}
function revision(c: Conversation, expected: number) {
  if (c.version !== expected)
    throw new Error("Conversation changed elsewhere. Refresh it before editing or sending.");
}
function facetsEvidence(message: {
  text: string;
  facets: Conversation["messages"][number]["facets"];
}) {
  if (
    !message.facets.unclear &&
    (!message.facets.supporting_text.trim() ||
      !message.text.includes(message.facets.supporting_text))
  )
    throw new Error("Classification needs supporting words from the seller's message");
}
function outgoing(
  c: Conversation,
  a: SellerAction,
  now: number,
  provenance: "browser" | "user_reported",
) {
  if (!a.draft) throw new Error("No reviewed message for this action");
  const m = {
    id: randomUUID(),
    external_id: a.id,
    text: a.draft.text,
    platform_at: null,
    facets: EMPTY_FACETS,
    direction: "outgoing" as const,
    observed_at: iso(now),
    provenance,
    action_id: a.id,
    draft: a.draft,
  };
  if (!c.messages.some((x) => x.action_id === a.id && x.direction === "outgoing"))
    c.messages.push(m);
  c.first_sent_at ??= iso(now);
  c.latest_sent_at = iso(now);
  if (a.draft.intent === "accept") {
    c.phase = "accepted";
    c.agreed_price_minor = a.draft.price_minor;
  } else if (a.draft.intent === "decline") {
    c.phase = "declined";
    c.agreed_price_minor = null;
  } else {
    c.phase = "awaiting_reply";
    if (a.draft.intent === "offer") c.agreed_price_minor = null;
  }
  a.status = "sent";
  if (a.draft.intent === "arrange" && c.collection_plan) {
    const plan = c.collection_plan;
    const purpose = a.draft.collection_purpose ?? plan.purpose;
    const changed =
      purpose !== plan.purpose || JSON.stringify(a.draft.collection) !== JSON.stringify(plan.when);
    plan.purpose = purpose;
    plan.when = structuredClone(a.draft.collection);
    if (changed || plan.status === "draft") plan.status = "proposed";
    if (changed) {
      plan.evidence = null;
      plan.seller_message_id = null;
      plan.provenance = "user_reported";
    }
  }
  a.confirmed_sent_at = iso(now);
  a.finished_at = iso(now);
  event(
    c,
    now,
    provenance === "browser" ? "Message confirmed sent" : "Message marked sent by you",
    a.draft.text,
    provenance === "browser" ? "browser" : "user",
    a.id,
    m.id,
  );
}
const summaries = Effect.fnUntraced(function* (repository: SellerConversationStorage, now: number) {
  const conversations = yield* repository.list();
  return yield* validation(() =>
    conversations.map((conversation) => sellerSummary(conversation, now)),
  );
});

// WorkspaceStore.request owns the immediate SQLite transaction. Each action and immutable payload
// is part of the durable conversation; a lease grants one executor a single send permit.
const handle = Effect.fn("seller_conversation.handle")(function* (
  repository: SellerConversationStorage,
  operation: string,
  input: Record<string, unknown>,
  row: ListingObservation,
  config: WorkspaceConfiguration,
  mode: "live" | "sample",
  context: string,
  now: number,
) {
  const stored = yield* repository.find(row.key);
  const c: Conversation = stored
    ? stored
    : {
        search_ids: [],
        collection_plan: null,
        id: randomUUID(),
        listing_key: row.key,
        version: 0,
        created_at: iso(now),
        updated_at: iso(now),
        target: {
          listing_id: row.listing_id,
          url: row.url,
          source: row.source ?? "facebook_marketplace",
          title: row.title,
          seller_profile_url: row.seller_profile_url ?? null,
          currency: row.currency ?? "GBP",
          price_period: row.price_period ?? "once",
        },
        draft: null,
        actions: [],
        messages: [],
        events: [],
        phase: "not_contacted",
        outcome: "open",
        agreed_price_minor: null,
        first_sent_at: null,
        latest_sent_at: null,
        latest_incoming_at: null,
        last_checked_at: null,
      };
  let changed = false;
  let execution:
    | {
        action_id: string;
        lease_token: string | null;
        send_permitted: boolean;
        reconcile_required: boolean;
      }
    | undefined;
  const guardContext = { now, config, mode, context_id: context, availability: row.availability };
  yield* validation(() => {
    const expire = c.actions.find(
      (a) =>
        ["running", "ready_to_send"].includes(a.status) &&
        a.lease_expires_at &&
        Date.parse(a.lease_expires_at) <= now,
    );
    if (expire) {
      Object.assign(expire, expiredSellerAction(expire, now));
      changed = true;
      event(
        c,
        now,
        "Action interrupted",
        expire.reason ?? "Execution interrupted",
        "browser",
        expire.id,
      );
    }
    if (operation === "get") sellerCommands.get.parse(input);
    else if (operation === "prepare_opening") {
      const search = config.searches.find((item) => item.id === input["search_id"]);
      if (!search || search.product !== row.product)
        throw new Error("Choose this listing's saved search");
      if (c.draft || c.messages.length || c.actions.length || c.outcome !== "open") return;
      const reasons = Array.isArray(input["reasons"])
        ? input["reasons"].filter((item): item is string => typeof item === "string")
        : [];
      c.draft = openingDraft(row, search, reasons);
      c.search_ids = [...new Set([...c.search_ids, search.id])];
      changed = true;
      event(c, now, "Opening message prepared", c.draft.text, "assistant");
    } else if (operation === "plan") {
      const args = sellerCommands.plan.parse(input);
      assertWorkflow(
        sellerBlockers(c, "collection_plan", {
          ...guardContext,
          expected_version: args.expected_version,
          proposed: true,
        }),
      );
      if (args.plan.provenance === "seller_message") {
        const message = c.messages.find(
          (item) => item.direction === "incoming" && item.id === args.plan.seller_message_id,
        );
        if (!message || !args.plan.evidence || !message.text.includes(args.plan.evidence))
          throw new Error("A seller-confirmed plan needs an exact excerpt from the saved reply");
        if (
          args.plan.status === "confirmed" &&
          (message.facets.unclear || message.facets.collection !== "confirmed")
        )
          throw new Error("The saved reply must confirm the collection arrangement");
      }
      c.collection_plan = args.plan;
      changed = true;
      event(c, now, "Collection plan saved", JSON.stringify(args.plan));
    } else if (operation === "arrange") {
      const args = sellerCommands.arrange.parse(input);
      assertWorkflow(
        sellerBlockers(c, "arrange", { ...guardContext, expected_version: args.expected_version }),
      );
      const plan = c.collection_plan;
      const search = config.searches.find((item) => c.search_ids.includes(item.id));
      const questions = search ? buyingQuestions(row, search) : [];
      if (!plan?.when) questions.push("What date and time would suit you?");
      if (!plan?.pickup_location)
        questions.push("Where would we meet for the viewing or collection?");
      else if (plan.status !== "confirmed")
        questions.push(`Is ${plan.pickup_location} the right pickup location?`);
      if (plan?.demonstration)
        questions.push(`Could you demonstrate ${plan.demonstration} when I view it?`);
      c.draft = {
        search_id: search?.id ?? null,
        price_minor: c.agreed_price_minor,
        currency: c.target.currency,
        price_period: c.target.price_period,
        intent: "arrange",
        collection: plan?.when ?? null,
        collection_purpose: plan?.purpose ?? "collection",
        verification_questions: [...new Set(questions)].slice(0, 30),
        responds_to: c.messages.findLast((item) => item.direction === "incoming")?.id ?? null,
        text: "Draft",
      };
      c.draft.text = offerMessage(c.draft, c.target.title);
      if (plan?.status === "confirmed" && plan.pickup_location)
        c.draft.text += ` The agreed pickup location is ${plan.pickup_location}.`;
      changed = true;
      event(c, now, "Collection message prepared", c.draft.text, "assistant");
    } else if (operation === "save") {
      const args = sellerCommands.save.parse(input);
      assertWorkflow(
        sellerBlockers(c, "save_draft", {
          ...guardContext,
          expected_version: args.expected_version,
          proposed: true,
        }),
      );
      if (
        args.draft.currency !== c.target.currency ||
        args.draft.price_period !== c.target.price_period
      )
        throw new Error("Use this listing's currency and price period");
      if (
        args.draft.responds_to &&
        !c.messages.some((m) => m.id === args.draft.responds_to && m.direction === "incoming")
      )
        throw new Error("The reply being answered no longer exists");
      c.draft = args.draft;
      if (args.draft.search_id) {
        if (
          !config.searches.some(
            (search) => search.id === args.draft.search_id && search.product === row.product,
          )
        )
          throw new Error("Choose a saved search for this item");
        c.search_ids = [...new Set([...c.search_ids, args.draft.search_id])];
      }
      changed = true;
      event(c, now, "Draft saved", args.draft.text);
    } else if (operation === "request") {
      const args = sellerCommands.request.parse(input);
      const existing = c.actions.find((a) => a.id === args.request_id);
      if (existing) {
        if (existing.kind !== args.kind)
          throw new Error("Action ID already belongs to another operation");
        return;
      }
      assertWorkflow(
        sellerBlockers(c, args.kind === "send" ? "request_send" : "request_check", {
          ...guardContext,
          expected_version: args.expected_version,
          // Request snapshots caller-reviewed wording. User authorization is a host/caller boundary.
          reviewed: true,
          proposed: true,
        }),
      );
      const platform = config.platforms[row.source ?? "facebook_marketplace"];
      const browser =
        platform?.browser && platform.browser !== "default"
          ? platform.browser
          : config.browser_preference;
      c.actions.push({
        id: args.request_id,
        kind: args.kind,
        status: "awaiting_handoff",
        requested_at: iso(now),
        started_at: null,
        confirmed_sent_at: null,
        finished_at: null,
        browser,
        manual_only: mode === "sample" || c.target.source !== "facebook_marketplace",
        worker_id: null,
        lease_token: null,
        lease_expires_at: null,
        draft: args.kind === "send" ? structuredClone(c.draft) : null,
        identity: null,
        evidence: null,
        reason: null,
      });
      changed = true;
      event(
        c,
        now,
        args.kind === "send" ? "Message requested" : "Reply check requested",
        args.kind === "send" ? (c.draft?.text ?? "") : "Check this conversation",
        "user",
        args.request_id,
      );
    } else if (operation === "manual" || operation === "correct" || operation === "outcome") {
      if (operation === "outcome") {
        const args = sellerCommands.outcome.parse(input);
        assertWorkflow(
          sellerBlockers(c, "outcome", {
            ...guardContext,
            expected_version: args.expected_version,
            proposed: true,
          }),
        );
        c.outcome = args.outcome;
        if (args.outcome === "bought" && args.search_ids) {
          if (
            args.search_ids.some(
              (id) =>
                !config.searches.some(
                  (search) => search.id === id && search.product === row.product,
                ),
            )
          )
            throw new Error("Choose related buying goals to fulfil");
          c.search_ids = [...new Set([...c.search_ids, ...args.search_ids])];
        }
        event(c, now, "Outcome recorded", args.outcome);
        changed = true;
      } else if (operation === "correct") {
        const args = sellerCommands.correct.parse(input);
        revision(c, args.expected_version);
        const message = c.messages.find(
          (m) => m.id === args.message_id && m.direction === "incoming",
        );
        if (!message) throw new Error("Choose a seller message");
        facetsEvidence({ text: message.text, facets: args.facets });
        const autoUnavailable =
          message.facets.availability === "unavailable" &&
          args.facets.availability !== "unavailable" &&
          c.outcome === "unavailable" &&
          c.events.findLastIndex((e) => e.kind === "Outcome recorded") <
            c.events.findIndex((e) => e.message_id === message.id);
        event(
          c,
          now,
          "Classification corrected",
          JSON.stringify({ previous: message.facets, next: args.facets }),
          "user",
          null,
          message.id,
        );
        message.facets = args.facets;
        const latest = c.messages.findLast((m) => m.direction === "incoming");
        if (latest?.id === message.id) {
          if (autoUnavailable) c.outcome = "open";
          c.agreed_price_minor = null;
          classify(c, message);
        }
        changed = true;
      } else {
        const args = sellerCommands.manual.parse(input);
        revision(c, args.expected_version);
        if (
          c.messages.some(
            (m) => m.external_id === args.message.external_id && m.provenance === "user_reported",
          )
        )
          return;
        if (args.direction === "outgoing") {
          const a = c.actions.find((x) => x.id === args.action_id && x.kind === "send");
          if (
            !a ||
            !["awaiting_handoff", "requested", "uncertain"].includes(a.status) ||
            a.draft?.text !== args.message.text
          )
            throw new Error(
              "Confirm the exact pending message after the browser action has stopped",
            );
          outgoing(c, a, now, "user_reported");
        } else {
          facetsEvidence(args.message);
          const m = {
            ...args.message,
            id: randomUUID(),
            direction: "incoming" as const,
            observed_at: iso(now),
            provenance: "user_reported" as const,
            action_id: null,
            draft: null,
          };
          c.messages.push(m);
          c.latest_incoming_at = iso(now);
          classify(c, m);
          event(c, now, "Seller reply recorded by you", m.text, "user", null, m.id);
        }
        changed = true;
      }
    } else {
      const id = input["action_id"];
      const a = c.actions.find((x) => x.id === id);
      if (!a) throw new Error("This action no longer exists");
      if (operation === "handoff") {
        sellerCommands.handoff.parse(input);
        if (a.status === "awaiting_handoff") {
          a.status = "requested";
          changed = true;
          event(c, now, "Request handed to chat", "Awaiting browser execution", "user", a.id);
        }
      } else if (operation === "cancel") {
        sellerCommands.cancel.parse(input);
        assertWorkflow(sellerBlockers(c, "cancel", guardContext, a));
        a.status = "cancelled";
        a.finished_at = iso(now);
        changed = true;
        event(c, now, "Action cancelled", "Cancelled before sending", "user", a.id);
      } else if (operation === "claim") {
        const args = sellerCommands.claim.parse(input);
        if (["sent", "checked", "not_sent", "cancelled"].includes(a.status)) {
          execution = {
            action_id: a.id,
            lease_token: null,
            send_permitted: false,
            reconcile_required: false,
          };
          return;
        }
        assertWorkflow(
          sellerBlockers(c, "claim", { ...guardContext, worker_id: args.worker_id }, a),
        );
        const reconcile = a.status === "uncertain" || a.status === "ready_to_send";
        a.worker_id = args.worker_id;
        if (args.execution) a.execution = args.execution;
        else delete a.execution;
        a.lease_token = randomUUID();
        a.lease_expires_at = iso(now + 5 * 60_000);
        a.started_at ??= iso(now);
        a.status = reconcile ? "uncertain" : "running";
        a.reason = null;
        changed = true;
        execution = {
          action_id: a.id,
          lease_token: a.lease_token,
          send_permitted: false,
          reconcile_required: reconcile,
        };
        event(
          c,
          now,
          reconcile ? "Reconciliation started" : "Browser action started",
          "Thread must be verified before proceeding",
          "browser",
          a.id,
        );
      } else if (operation === "prepare") {
        const args = sellerCommands.prepare.parse(input);
        assertWorkflow(sellerLeaseBlockers(a, { ...guardContext, lease_token: args.lease_token }));
        // Draft changes pause before sending; route, identity and one-time permit failures reject.
        const readiness = sellerDraftBlockers(c, a.draft, guardContext);
        const guards = sellerBlockers(
          c,
          "permit",
          { ...guardContext, lease_token: args.lease_token, identity: args.identity },
          a,
        );
        assertWorkflow(
          guards.filter(
            (item) =>
              !readiness.some((issue) => issue.code === item.code) &&
              !(readiness.length && item.code === "conversation_closed"),
          ),
        );
        if (readiness.length) {
          a.status = "blocked";
          a.reason =
            "Update collection time, review the latest reply or recheck availability before sending";
          a.finished_at = iso(now);
          changed = true;
          event(c, now, "Action paused", a.reason, "browser", a.id);
          return;
        }
        a.identity = args.identity;
        a.status = "ready_to_send";
        changed = true;
        execution = {
          action_id: a.id,
          lease_token: a.lease_token,
          send_permitted: true,
          reconcile_required: false,
        };
        event(c, now, "Send permitted", "Approved text and conversation verified", "browser", a.id);
      } else if (operation === "complete") {
        const args = sellerCommands.complete.parse(input);
        if (["sent", "checked", "not_sent"].includes(a.status)) {
          if (a.status !== args.result) throw new Error("Action already has a different result");
          return;
        }
        assertWorkflow(sellerBlockers(c, "result", { ...guardContext, ...args }, a));
        if (args.result === "sent") {
          if (
            a.kind !== "send" ||
            !["ready_to_send", "uncertain"].includes(a.status) ||
            !a.draft ||
            !args.evidence.includes(a.draft.text)
          )
            throw new Error("Confirm the exact outgoing message in the verified thread");
          const identity = args.identity ?? a.identity;
          if (!identity) throw new Error("Verify the seller and thread before confirming");
          assertWorkflow(sellerIdentityBlockers(c, a, identity));
          assertWorkflow(sellerRouteBlockers(c, a, { ...guardContext, identity }));
          a.identity = identity;
          outgoing(c, a, now, "browser");
        } else if (args.result === "checked") {
          if (a.kind !== "check" || !args.identity)
            throw new Error("Confirm a reply check in its verified thread");
          assertWorkflow(sellerIdentityBlockers(c, a, args.identity));
          assertWorkflow(sellerRouteBlockers(c, a, { ...guardContext, identity: args.identity }));
          a.identity = args.identity;
          for (const message of args.messages) {
            facetsEvidence(message);
            const duplicate = c.messages.find(
              (m) =>
                m.direction === "incoming" &&
                m.provenance === "browser" &&
                m.external_id === message.external_id,
            );
            if (duplicate) {
              if (duplicate.text !== message.text)
                throw new Error("Conflicting message identity; inspect the thread again");
              continue;
            }
            const m = {
              ...message,
              id: randomUUID(),
              direction: "incoming" as const,
              observed_at: iso(now),
              provenance: "browser" as const,
              action_id: a.id,
              draft: null,
            };
            c.messages.push(m);
            c.latest_incoming_at = iso(now);
            classify(c, m);
            event(c, now, "Seller reply observed", m.text, "browser", a.id, m.id);
          }
          c.last_checked_at = iso(now);
          a.status = "checked";
          event(
            c,
            now,
            "Reply check completed",
            args.messages.length ? "Seller messages inspected" : "No new seller reply observed",
            "browser",
            a.id,
          );
        } else {
          if (args.result === "blocked" && a.status !== "running")
            throw new Error("A potentially sent message must remain uncertain until reconciled");
          if (args.result === "not_sent" && a.kind === "send") {
            if (!args.identity)
              throw new Error(
                "Provide verified thread identity when recording no outgoing message",
              );
            assertWorkflow(sellerIdentityBlockers(c, a, args.identity));
            assertWorkflow(sellerRouteBlockers(c, a, { ...guardContext, identity: args.identity }));
            a.identity = args.identity;
          }
          a.status = args.result;
          a.reason = args.evidence;
          event(
            c,
            now,
            args.result === "uncertain" ? "Send needs verification" : "Action stopped",
            args.evidence,
            "browser",
            a.id,
          );
        }
        a.evidence = args.evidence;
        a.finished_at = iso(now);
        a.lease_expires_at = null;
        a.lease_token = null;
        changed = true;
      } else throw new Error("Unsupported seller_conversation action");
    }
  });
  if (changed) {
    if (c.phase === "accepted" && !c.collection_plan) {
      const proposed = c.messages.findLast(
        (message) => message.direction === "outgoing" && message.draft?.collection,
      )?.draft;
      c.collection_plan = {
        purpose: proposed?.collection_purpose ?? "collection",
        status: proposed?.collection ? "proposed" : "draft",
        when: proposed?.collection ?? null,
        pickup_location: null,
        demonstration:
          row.product === "espresso_machine"
            ? "espresso extraction and, if included, the grinder"
            : null,
        evidence: null,
        seller_message_id: null,
        provenance: "user_reported",
      };
    }
    c.version++;
    c.updated_at = iso(now);
    yield* repository.save(c);
  }
  return { conversation: c, ...(execution ? { execution } : {}) };
});

type Arguments<F> = F extends (repository: SellerConversationStorage, ...args: infer A) => unknown
  ? A
  : never;
type Bound<F> = F extends (repository: SellerConversationStorage, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;

export class SellerConversations extends Context.Service<
  SellerConversations,
  {
    readonly summaries: Bound<typeof summaries>;
    readonly handle: Bound<typeof handle>;
  }
>()("goodfinds/SellerConversations", {
  make: Effect.gen(function* () {
    const repository = yield* SellerConversationRepository;
    return {
      summaries: (...args: Arguments<typeof summaries>) => summaries(repository, ...args),
      handle: (...args: Arguments<typeof handle>) => handle(repository, ...args),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
