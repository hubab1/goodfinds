import { seedWorkspace } from "./helpers/workspace.ts";
import { errorDetails } from "../apps/server/src/workspace/errors.ts";
import { revisionFor } from "./helpers/revisions.ts";
import { sellerActions } from "@goodfinds/contracts/tool-names";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import {
  collectionExpired,
  EMPTY_FACETS,
  currencyDivisor,
  sellerSummary,
  offerMessage,
} from "@goodfinds/contracts/seller-conversation";
import type { SellerMessageDraft } from "@goodfinds/contracts/seller-conversation";
import { sellerRequest, offerDefaults } from "../apps/ui/src/lib/seller-conversation.ts";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { stateFromToolResult, stateSchema } from "@goodfinds/contracts/state";
import { QUIET_BROWSING_GUIDANCE } from "@goodfinds/contracts/host-request";

function fixture(t: TestContext, mode: "live" | "sample" = "live") {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-seller_conversation-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let now = Date.parse("2026-10-04T14:00:00Z");
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const store = new WorkspaceStore(seedWorkspace(folder, mode), mode);
  const run = (operation: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(store.request(operation, args).pipe(Effect.provideService(Clock.Clock, clock)));
  const imported =
    mode === "sample"
      ? run("load_sample_workspace")
      : run("import_listing_observations", {
          observations: [
            {
              listing_id: "123456789012345",
              title: "Fictional monitor",
              url: "https://www.facebook.com/marketplace/item/123456789012345/",
              product: "mac_mini",
              price_minor: 20000,
              price_kind: "asking",
              currency: "GBP",
              source: "facebook_marketplace",
              seller_name: "Maya",
              seller_profile_url: "https://www.facebook.com/marketplace/profile/12345/",
              provenance: "manual",
              observed_at: new Date(now).toISOString(),
              availability: "active",
              condition: "good",
              chip: "M4",
              ram_gb: 16,
              ssd_gb: 512,
            },
          ],
        }).state;
  const state = "state" in imported ? imported.state : imported;
  const first = state.listings[0];
  assert.ok(first);
  const listing = first;
  function contact(profile = "Test profile") {
    const current = run("get_workspace").state;
    run("report_listing_contact", {
      expected_entity_revision: revisionFor(current, "report_listing_contact", { report: {} }),
      context_id: current.access_context,
      report: {
        listing_key: listing.key,
        listing_url: listing.url,
        marketplace: listing.source ?? "facebook_marketplace",
        browser: "in_app",
        host: "Codex",
        profile,
        message: "available",
        offer: "unavailable",
        external_contact: false,
        evidence: "Simulated listing exposes a message interface",
      },
    });
  }
  if (mode === "live") contact();
  const command = (operation: string, args: Record<string, unknown> = {}) => {
    const result = run(
      Object.entries(sellerActions).find(([, value]) => value === operation)?.[0] ?? "",
      { mode, listing_key: listing.key, ...args },
    );
    return { ...result, execution: "execution" in result ? result.execution : undefined };
  };
  const conversation = () => {
    const c = command("get").state.seller_conversation;
    assert.ok(c);
    return c;
  };
  const draft: SellerMessageDraft = {
    price_minor: 18000,
    currency: "GBP",
    price_period: listing.price_period ?? "once",
    collection: null,
    text: "Hi, would you consider £180 for the monitor?",
    intent: "offer",
    responds_to: null,
  };
  function access(profile = "Test profile") {
    let current = run("get_workspace").state;
    current = run("report_browser_access", {
      expected_entity_revision: revisionFor(current, "report_browser_access", { report: {} }),
      context_id: current.access_context,
      report: {
        browser: "in_app",
        status: "available",
        host: "Codex",
        profile,
        evidence: "Test host lists the browser",
      },
    }).state;
    run("report_marketplace_session", {
      expected_entity_revision: revisionFor(current, "report_marketplace_session", { report: {} }),
      context_id: current.access_context,
      report: {
        marketplace: "facebook_marketplace",
        browser: "in_app",
        host: "Codex",
        profile,
        status: "signed_in",
        evidence: "Test buyer is visibly signed in",
      },
    });
    contact(profile);
  }
  const identity = {
    listing_url: listing.url,
    listing_id: listing.listing_id,
    seller_profile_url:
      listing.seller_profile_url ?? "https://www.facebook.com/marketplace/profile/12345/",
    buyer_identity: "Test buyer",
    thread_url: "https://www.facebook.com/messages/t/123456/",
    host: "Codex",
    profile: "Test profile",
    evidence: "Test listing, seller and thread visibly match",
  };
  function request(kind: "send" | "check" = "send", value: SellerMessageDraft = draft) {
    let c = conversation();
    if (kind === "send") {
      const saved = command("save", { expected_version: c.version, draft: value }).state
        .seller_conversation;
      assert.ok(saved);
      c = saved;
    }
    const result = command("request", {
      expected_version: c.version,
      request_id: randomUUID(),
      kind,
    });
    const a = result.state.seller_conversation?.actions.at(-1);
    assert.ok(a);
    return a;
  }
  function claim(id: string) {
    const r = command("claim", { action_id: id, worker_id: randomUUID() });
    assert.ok(r.execution?.lease_token);
    return r.execution.lease_token;
  }
  function sent() {
    access();
    const a = request();
    const token = claim(a.id);
    const ready = command("prepare", { action_id: a.id, lease_token: token, identity });
    assert.equal(ready.execution?.send_permitted, true);
    command("complete", {
      action_id: a.id,
      lease_token: token,
      result: "sent",
      evidence: `Outgoing bubble: ${draft.text}`,
    });
    return conversation();
  }
  return {
    folder,
    listing,
    run,
    command,
    conversation,
    draft,
    access,
    identity,
    request,
    claim,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test("drafts persist without outreach or changing search revisions", (t) => {
  const f = fixture(t);
  const before = f.run("get_workspace").state;
  const c = f.conversation();
  assert.equal(c.first_sent_at, null);
  assert.equal(c.version, 0);
  f.command("save", { expected_version: 0, draft: f.draft });
  const restored = Effect.runSync(
    new WorkspaceStore(seedWorkspace(f.folder)).request("get_seller_conversation", {
      listing_key: f.listing.key,
    }),
  );
  assert.equal(restored.state.seller_conversation?.draft?.text, f.draft.text);
  assert.equal(restored.state.seller_conversation?.first_sent_at, null);
  assert.equal(restored.state.revision, before.revision);
  assert.equal(restored.state.seller_conversations[0]?.label, "Draft");
  assert.throws(
    () => f.command("save", { expected_version: 0, draft: f.draft }),
    /changed elsewhere/u,
  );
});

void test("reply workers record actual model settings without gaining send permission", (t) => {
  const f = fixture(t);
  f.access();
  const action = f.request("check");
  const execution = {
    profile: "collection" as const,
    model: "gpt-6-luna",
    reasoning_effort: "xhigh" as const,
  };
  const claimed = f.command("claim", { action_id: action.id, worker_id: randomUUID(), execution });
  assert.equal(claimed.execution?.send_permitted, false);
  assert.deepEqual(claimed.state.seller_conversation?.actions.at(-1)?.execution, execution);
  assert.equal(
    claimed.state.seller_workflow?.actions.find((a) => a.event === "result")?.execution.profile,
    "collection",
  );
  const restored = Effect.runSync(
    new WorkspaceStore(seedWorkspace(f.folder)).request("get_seller_conversation", {
      listing_key: f.listing.key,
    }),
  ).state.seller_conversation;
  assert.deepEqual(restored?.actions.at(-1)?.execution, execution);
  f.advance(5 * 60_000 + 1);
  const replacement = f.command("claim", { action_id: action.id, worker_id: randomUUID() });
  assert.equal(replacement.state.seller_conversation?.actions.at(-1)?.execution, undefined);
  assert.equal(replacement.execution?.send_permitted, false);
});

void test("request IDs are idempotent and duplicate outreach is blocked", (t) => {
  const f = fixture(t);
  const a = f.request();
  const c = f.conversation();
  f.command("request", { expected_version: 0, request_id: a.id, kind: "send" });
  assert.equal(f.conversation().actions.length, 1);
  assert.equal(f.conversation().first_sent_at, null);
  assert.throws(
    () =>
      f.command("request", { expected_version: c.version, request_id: randomUUID(), kind: "send" }),
    /already exists/u,
  );
  assert.throws(
    () =>
      f.command("save", {
        expected_version: c.version,
        draft: { ...f.draft, text: "Different offer" },
      }),
    /pending send/u,
  );
  f.command("cancel", { action_id: a.id });
  assert.equal(f.conversation().actions[0]?.status, "cancelled");
});

void test("browser execution requires fresh matching access and sign-in", (t) => {
  const f = fixture(t);
  const a = f.request();
  assert.throws(() => f.claim(a.id), /browser access/u);
  f.access("Different profile");
  const token = f.claim(a.id);
  assert.throws(
    () => f.command("prepare", { action_id: a.id, lease_token: token, identity: f.identity }),
    /sign-in/u,
  );
  assert.equal(f.conversation().first_sent_at, null);
});

void test("a lease permits one verified send and confirmation needs the exact text", (t) => {
  const f = fixture(t);
  f.access();
  const a = f.request();
  const token = f.claim(a.id);
  assert.throws(() => f.claim(a.id), /active executor/u);
  assert.throws(
    () =>
      f.command("complete", {
        action_id: a.id,
        lease_token: token,
        result: "sent",
        evidence: f.draft.text,
        identity: f.identity,
      }),
    /exact outgoing/u,
  );
  assert.throws(
    () =>
      f.command("prepare", {
        action_id: a.id,
        lease_token: token,
        identity: { ...f.identity, listing_id: "999" },
      }),
    /approved item/u,
  );
  assert.throws(
    () =>
      f.command("prepare", {
        action_id: a.id,
        lease_token: token,
        identity: {
          ...f.identity,
          seller_profile_url: "https://www.facebook.com/marketplace/profile/999/",
        },
      }),
    /seller/u,
  );
  const prepared = f.command("prepare", {
    action_id: a.id,
    lease_token: token,
    identity: f.identity,
  });
  assert.equal(prepared.execution?.send_permitted, true);
  const descriptor = prepared.state.seller_workflow?.actions.find(
    (item) => item.event === "permit",
  );
  assert.equal(descriptor?.availability, "blocked");
  assert.ok(descriptor?.blockers.some((item) => item.code === "permit_already_issued"));
  assert.throws(
    () => f.command("prepare", { action_id: a.id, lease_token: token, identity: f.identity }),
    (error: unknown) => {
      assert.ok(
        errorDetails(error).blockers?.some((item) => item.code === "permit_already_issued"),
      );
      return true;
    },
  );
  assert.throws(() => f.command("cancel", { action_id: a.id }), /interrupted send/u);
  assert.throws(
    () =>
      f.command("complete", {
        action_id: a.id,
        lease_token: token,
        result: "sent",
        evidence: "Clicked send",
      }),
    /exact outgoing/u,
  );
  assert.equal(f.conversation().first_sent_at, null);
  f.command("complete", {
    action_id: a.id,
    lease_token: token,
    result: "sent",
    evidence: f.draft.text,
  });
  const c = f.conversation();
  assert.equal(c.messages.length, 1);
  assert.equal(c.phase, "awaiting_reply");
  assert.ok(c.first_sent_at);
  f.command("complete", {
    action_id: a.id,
    lease_token: token,
    result: "sent",
    evidence: f.draft.text,
  });
  assert.equal(f.conversation().messages.length, 1);
  assert.equal(f.run("get_workspace").state.listings[0]?.price_minor, 20000);
});

void test("an expired executor requires reconciliation and cannot issue another send permit", (t) => {
  const f = fixture(t);
  f.access();
  const a = f.request();
  const token = f.claim(a.id);
  f.command("prepare", { action_id: a.id, lease_token: token, identity: f.identity });
  f.advance(6 * 60_000);
  assert.equal(f.run("get_workspace").state.seller_conversations[0]?.label, "Check send");
  assert.throws(
    () =>
      f.command("complete", {
        action_id: a.id,
        lease_token: token,
        result: "sent",
        evidence: f.draft.text,
      }),
    /expired/u,
  );
  const uncertain = f.conversation();
  assert.equal(uncertain.actions[0]?.status, "uncertain");
  const reclaimed = f.command("claim", { action_id: a.id, worker_id: "replacement" });
  assert.ok(reclaimed.execution?.lease_token);
  assert.equal(reclaimed.execution.reconcile_required, true);
  const replacement = reclaimed.execution.lease_token;
  assert.throws(
    () => f.command("prepare", { action_id: a.id, lease_token: replacement, identity: f.identity }),
    /another send permit/u,
  );
  f.command("complete", {
    action_id: a.id,
    lease_token: replacement,
    result: "sent",
    identity: f.identity,
    evidence: `Found existing bubble: ${f.draft.text}`,
  });
  assert.equal(f.conversation().messages.length, 1);
  assert.equal(f.conversation().actions.length, 1);
});

void test("verified not-sent evidence permits a new separately approved action", (t) => {
  const f = fixture(t);
  f.access();
  const a = f.request();
  const token = f.claim(a.id);
  f.command("complete", {
    action_id: a.id,
    lease_token: token,
    result: "uncertain",
    evidence: "Interrupted before confirmation",
  });
  assert.throws(() => f.request(), /pending send/u);
  const retry = f.claim(a.id);
  f.command("complete", {
    action_id: a.id,
    lease_token: retry,
    result: "not_sent",
    identity: f.identity,
    evidence: "Full verified thread contains no outgoing message for this attempt",
  });
  assert.equal(f.conversation().first_sent_at, null);
  assert.notEqual(f.request().id, a.id);
});

void test("collection commitments are checked at request and immediately before send", (t) => {
  const f = fixture(t);
  f.access();
  const value = {
    ...f.draft,
    collection: { date: "2026-10-04", time: "19:00", end_time: null, timezone: "Europe/London" },
  };
  const a = f.request("send", value);
  f.advance(26 * 60 * 60_000);
  f.access();
  const token = f.claim(a.id);
  const blocked = f.command("prepare", {
    action_id: a.id,
    lease_token: token,
    identity: f.identity,
  });
  assert.notEqual(blocked.execution?.send_permitted, true);
  assert.equal(f.conversation().actions[0]?.status, "blocked");
  assert.equal(f.conversation().first_sent_at, null);
  assert.throws(() => f.request("send", value), /expired collection/u);
});

void test("mixed replies retain price and collection facets, deduplicate and preserve no-reply state", (t) => {
  const f = fixture(t);
  f.sent();
  const a = f.request("check"),
    token = f.claim(a.id);
  const message = {
    external_id: "seller-1",
    text: "£190. Can you collect tomorrow?",
    platform_at: null,
    facets: {
      ...EMPTY_FACETS,
      unclear: false,
      price: "counter",
      price_minor: 19000,
      collection: "question",
      supporting_text: "£190. Can you collect tomorrow?",
    },
  };
  f.command("complete", {
    action_id: a.id,
    lease_token: token,
    result: "checked",
    identity: f.identity,
    evidence: "Verified full thread",
    messages: [message],
  });
  let c = f.conversation();
  assert.equal(c.phase, "counteroffer");
  assert.equal(c.messages.at(-1)?.facets.collection, "question");
  assert.equal(c.messages.at(-1)?.platform_at, null);
  const replyTime = c.latest_incoming_at;
  f.advance(60_000);
  const b = f.request("check"),
    other = f.claim(b.id);
  f.command("complete", {
    action_id: b.id,
    lease_token: other,
    result: "checked",
    identity: f.identity,
    evidence: "No additional message",
    messages: [message],
  });
  c = f.conversation();
  assert.equal(c.messages.length, 2);
  assert.equal(c.phase, "counteroffer");
  assert.equal(c.latest_incoming_at, replyTime);
  assert.notEqual(c.last_checked_at, replyTime);
  assert.throws(() => f.request(), /latest seller reply/u);
});

void test("a seller reply arriving during execution blocks the old approved message", (t) => {
  const f = fixture(t);
  f.access();
  const a = f.request();
  const token = f.claim(a.id);
  const c = f.conversation();
  f.command("manual", {
    expected_version: c.version,
    direction: "incoming",
    message: {
      external_id: "manual-1",
      text: "It is sold",
      platform_at: null,
      facets: {
        ...EMPTY_FACETS,
        unclear: false,
        availability: "unavailable",
        supporting_text: "sold",
      },
    },
  });
  const result = f.command("prepare", {
    action_id: a.id,
    lease_token: token,
    identity: f.identity,
  });
  assert.notEqual(result.execution?.send_permitted, true);
  assert.equal(f.conversation().first_sent_at, null);
});

void test("manual provenance, acceptance and purchase outcome remain distinct; corrections retain audit history", (t) => {
  const f = fixture(t);
  const a = f.request();
  let c = f.conversation();
  f.command("manual", {
    expected_version: c.version,
    direction: "outgoing",
    action_id: a.id,
    message: { external_id: a.id, text: f.draft.text, platform_at: null, facets: EMPTY_FACETS },
  });
  c = f.conversation();
  assert.equal(c.messages[0]?.provenance, "user_reported");
  f.command("manual", {
    expected_version: c.version,
    direction: "incoming",
    message: {
      external_id: "manual-accept",
      text: "Yes £180 works",
      platform_at: null,
      facets: { ...EMPTY_FACETS, unclear: false, price: "accept", supporting_text: "£180 works" },
    },
  });
  c = f.conversation();
  assert.equal(c.phase, "accepted");
  assert.equal(c.outcome, "open");
  assert.equal(c.agreed_price_minor, 18000);
  assert.equal(f.run("get_workspace").state.listings[0]?.price_minor, 20000);
  const message = c.messages.at(-1);
  assert.ok(message);
  f.command("correct", {
    expected_version: c.version,
    message_id: message.id,
    facets: { ...EMPTY_FACETS, supporting_text: message.text },
  });
  c = f.conversation();
  assert.equal(c.phase, "needs_review");
  assert.equal(c.agreed_price_minor, null);
  assert.ok(
    c.events.some((e) => e.kind === "Classification corrected" && e.text.includes('"accept"')),
  );
  f.command("outcome", { expected_version: c.version, outcome: "bought" });
  assert.equal(f.conversation().outcome, "bought");
});

void test("sample conversations stay isolated and never grant browser execution", (t) => {
  const f = fixture(t, "sample");
  const a = f.request();
  f.access();
  assert.throws(() => f.claim(a.id), /Sample conversations/u);
  assert.equal(a.manual_only, true);
  assert.equal(sellerSummary(f.conversation()).label, "Message ready");
  const live = Effect.runSync(
    new WorkspaceStore(seedWorkspace(f.folder)).request("get_workspace"),
  ).state;
  assert.equal(live.seller_conversations.length, 0);
  assert.equal(live.listings.length, 0);
});

void test("later counters clear old agreements and availability corrections preserve explicit outcomes", (t) => {
  const f = fixture(t);
  f.sent();
  const reply = (
    id: string,
    price: "accept" | "counter" | "none",
    amount: number | null,
    availability: "unknown" | "unavailable" = "unknown",
  ) => {
    const c = f.conversation();
    f.command("manual", {
      expected_version: c.version,
      direction: "incoming",
      message: {
        external_id: id,
        text: id,
        platform_at: null,
        facets: {
          ...EMPTY_FACETS,
          unclear: false,
          price,
          price_minor: amount,
          availability,
          supporting_text: id,
        },
      },
    });
  };
  reply("£180 works", "accept", 18000);
  assert.equal(f.conversation().agreed_price_minor, 18000);
  reply("Actually £190", "counter", 19000);
  assert.equal(f.conversation().agreed_price_minor, null);
  assert.equal(sellerSummary(f.conversation()).price_minor, 19000);
  reply("Sold?", "none", null, "unavailable");
  let c = f.conversation();
  const message = c.messages.at(-1);
  assert.ok(message);
  f.command("correct", {
    expected_version: c.version,
    message_id: message.id,
    facets: { ...EMPTY_FACETS, supporting_text: message.text },
  });
  c = f.conversation();
  assert.equal(c.outcome, "open");
  f.command("outcome", { expected_version: c.version, outcome: "unavailable" });
  c = f.conversation();
  f.command("correct", {
    expected_version: c.version,
    message_id: message.id,
    facets: {
      ...EMPTY_FACETS,
      unclear: false,
      availability: "available",
      supporting_text: message.text,
    },
  });
  assert.equal(f.conversation().outcome, "unavailable");
});

void test("reconciliation cannot confirm messages from a different browser profile", (t) => {
  const f = fixture(t);
  f.access();
  const a = f.request();
  const token = f.claim(a.id);
  f.command("complete", {
    action_id: a.id,
    lease_token: token,
    result: "uncertain",
    evidence: "Interrupted before thread identity was established",
  });
  const reconcile = f.claim(a.id);
  assert.throws(
    () =>
      f.command("complete", {
        action_id: a.id,
        lease_token: reconcile,
        result: "sent",
        identity: { ...f.identity, profile: "Different buyer profile" },
        evidence: f.draft.text,
      }),
    /sign-in/u,
  );
  assert.equal(f.conversation().first_sent_at, null);
  f.command("complete", {
    action_id: a.id,
    lease_token: reconcile,
    result: "sent",
    identity: f.identity,
    evidence: f.draft.text,
  });
  assert.equal(f.conversation().actions.at(-1)?.status, "sent");
});

void test("message text uses actual dates, listing currency and price periods", () => {
  assert.equal(currencyDivisor("JPY"), 1);
  assert.equal(currencyDivisor("GBP"), 100);
  const terms = {
    price_minor: null,
    currency: "GBP",
    price_period: "once",
    collection: null,
    intent: "message" as const,
    responds_to: null,
  };
  assert.equal(offerMessage(terms, "monitor"), "Hi, is this still available?");
  assert.equal(
    offerMessage({ ...terms, price_minor: 2800 }, "Gaggia"),
    "Hi, is this still available?",
  );
  assert.doesNotMatch(
    offerMessage(
      {
        ...terms,
        intent: "decline",
        collection: {
          date: "2026-10-05",
          time: "19:00",
          end_time: null,
          timezone: "Europe/London",
        },
      },
      "monitor",
    ),
    /collect/u,
  );
  const collection = {
    date: "2026-10-25",
    time: "19:00",
    end_time: "20:00",
    timezone: "Europe/London",
  };
  assert.equal(collectionExpired(collection, Date.parse("2026-10-25T19:30:00Z")), false);
  assert.equal(collectionExpired(collection, Date.parse("2026-10-25T20:00:00Z")), true);
  assert.match(
    offerMessage(
      {
        price_minor: 180000,
        currency: "GBP",
        price_period: "month",
        collection: null,
        intent: "offer",
        responds_to: null,
      },
      "the flat",
    ),
    /£1,800.00 per month/u,
  );
  assert.match(
    offerMessage(
      {
        price_minor: 18000,
        currency: "GBP",
        price_period: "once",
        collection,
        intent: "accept",
        responds_to: null,
      },
      "monitor",
    ),
    /Sunday,? 25 October between 19:00 and 20:00/u,
  );
  assert.doesNotMatch(
    offerMessage({ ...terms, intent: "offer", price_minor: 18000, collection }, "monitor"),
    /monitor|collect|October/u,
  );
  assert.equal(
    offerMessage({ ...terms, intent: "arrange", collection_purpose: "viewing" }, "monitor"),
    "Thanks, could we arrange a viewing?",
  );
});

void test("opening offers use the associated search threshold with explicit handling of overlapping budgets and units", (t) => {
  const f = fixture(t, "sample");
  const state = stateSchema.parse(f.run("get_workspace").state);
  const original = state.listings.find((row) => row.product === "mac_mini");
  assert.ok(original);
  assert.equal(
    offerDefaults(original, state).price_minor,
    Math.min(original.price_minor ?? Infinity, 125000),
  );
  const listing = { ...original, price_minor: 150000 };
  const decision = state.decisions.find((d) => d.listing.key === listing.key);
  assert.ok(decision);
  const search = state.searches.find((w) => w.id === decision.search_id);
  assert.ok(search);
  assert.equal(offerDefaults(listing, state).price_minor, 125000);
  const lower = {
    ...search,
    id: "lower-mini",
    name: "Lower mini budget",
    max_price_minor: 50000,
    values: { ...search.values, max_price_minor: 90000 },
  };
  const unrelated = {
    ...lower,
    id: "unrelated-mini",
    name: "Unrelated mini search",
    values: { ...lower.values, max_price_minor: 60000 },
  };
  const context = {
    searches: [search, lower, unrelated],
    decisions: [decision, { ...decision, search_id: lower.id }],
  };
  const ambiguous = offerDefaults(listing, context);
  assert.equal(ambiguous.price_minor, null);
  assert.equal(ambiguous.choices.length, 2);
  assert.equal(offerDefaults(listing, context, lower.id).price_minor, 90000);
  assert.equal(offerDefaults(listing, context, search.id).price_minor, 125000);
  assert.equal(
    offerDefaults({ ...listing, currency: "USD" }, context).price_minor,
    listing.price_minor,
  );
  assert.equal(offerDefaults({ ...listing, price_period: "week" }, context).choices.length, 0);
  assert.equal(
    offerDefaults(listing, { searches: [], decisions: [] }).price_minor,
    listing.price_minor,
  );
});

void test("MCP exposes the durable protocol and copy handoff references one action", async (t) => {
  const f = fixture(t);
  const a = f.request();
  const c = f.conversation();
  assert.equal(sellerSummary(c).label, "Continue in chat");
  const prompt = sellerRequest(c, a, "live");
  assert.ok(prompt.includes(a.id));
  assert.ok(prompt.includes("execution.send_permitted true"));
  assert.ok(prompt.endsWith(QUIET_BROWSING_GUIDANCE));
  const { server, calls } = createGoodfindsServer(seedWorkspace(f.folder));
  t.after(() => server.close());
  const read = calls.get("get_goodfinds_seller_conversation");
  assert.ok(read);
  const result = stateFromToolResult(await read({ listing_key: f.listing.key }));
  assert.equal(result.seller_conversation?.actions.length, 1);
  const save = calls.get("save_goodfinds_seller_message_draft");
  assert.ok(save);
  assert.equal(
    (await save({ listing_key: f.listing.key, expected_version: 0, draft: f.draft })).isError,
    true,
  );
});

void test("sending changed collection terms preserves the proposal without retaining an old confirmation", (t) => {
  const f = fixture(t, "sample");
  const when = { date: "2026-10-10", time: "10:00", end_time: null, timezone: "Europe/London" };
  f.command("plan", {
    expected_version: f.conversation().version,
    plan: {
      purpose: "collection",
      status: "confirmed",
      when,
      pickup_location: "Fictional pickup address",
      demonstration: null,
      evidence: "Buyer reported the agreed appointment",
      seller_message_id: null,
      provenance: "user_reported",
    },
  });
  const arranged = f.command("arrange", { expected_version: f.conversation().version }).state
    .seller_conversation;
  assert.ok(arranged?.draft);
  assert.match(arranged.draft.text, /agreed pickup location is Fictional pickup address/);
  const edited = { ...arranged.draft, collection: { ...when, time: "11:00" } };
  edited.text = offerMessage(edited, f.listing.title);
  const a = f.request("send", edited);
  f.command("manual", {
    expected_version: f.conversation().version,
    direction: "outgoing",
    action_id: a.id,
    message: { external_id: a.id, text: edited.text, platform_at: null, facets: EMPTY_FACETS },
  });
  const plan = f.conversation().collection_plan;
  assert.equal(plan?.status, "proposed");
  assert.equal(plan?.when?.time, "11:00");
  assert.equal(plan?.evidence, null);
  assert.equal(plan?.seller_message_id, null);
});
