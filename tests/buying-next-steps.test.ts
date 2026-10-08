import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { savedSearchSchema } from "@goodfinds/contracts/search-definition";
import { stateSchema } from "@goodfinds/contracts/state";
import {
  recommendations,
  fulfilledSearches,
  openingDraft,
  openingOfferPrice,
} from "@goodfinds/contracts/buying-next-steps";
import {
  openingQuestions,
  verificationChecks,
  unresolvedQuestions,
} from "@goodfinds/contracts/verification";
import { initialSellerMessageDraft } from "../apps/ui/src/lib/seller-conversation.ts";
import { collectionPlanSchema, sellerSummary } from "@goodfinds/contracts/seller-conversation";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";

const search = savedSearchSchema.parse({
  id: "coffee",
  name: "Coffee machine",
  product: "espresso_machine",
  enabled: true,
  definition: {
    schema_version: 1,
    version: 1,
    category: "espresso_machine",
    title: "Coffee machine",
    description: "Working manual espresso machine",
    price: { currency: "GBP", period: "once" },
    comparison_attributes: ["model"],
    fields: [
      {
        id: "budget",
        label: "Maximum setup price",
        type: "integer",
        required: true,
        match: { attribute: "price_minor", operator: "lte" },
      },
      { id: "target_price_minor", label: "Target offer", type: "integer", required: false },
    ],
  },
  values: { budget: 25000, target_price_minor: 20000 },
  discovery: {
    scope: "alternatives",
    reference_model: "Sage Barista Express",
    category_terms: ["coffee machine"],
    verification_checks: [
      { id: "portafilter", label: "Portafilter", question: "Does it include the portafilter?" },
    ],
  },
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-follow-through-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(dir));
  const run = (action: string, args: Record<string, unknown> = {}) =>
    stateSchema.parse(Effect.runSync(store.request(action, args)).state);
  const initial = run("get_workspace");
  run("save_search", {
    search,
    expected_entity_revision: revisionFor(initial, "save_search", { search }),
  });
  const importItem = (id: string, price = 22000) =>
    run("import_listing_observations", {
      observations: [
        {
          listing_id: id,
          title: "Sage Barista Express",
          url: `https://www.facebook.com/marketplace/item/${id}/`,
          source: "facebook_marketplace",
          provenance: "manual",
          product: "espresso_machine",
          price_minor: price,
          currency: "GBP",
          price_kind: "asking",
          price_period: "once",
          availability: "active",
          condition: "good",
          functional: true,
          observed_at: new Date().toISOString(),
          collection_stage: "verification",
          image_review: { total_images: 1, reviewed_positions: [1], complete: true },
          attributes: { model: "Sage Barista Express" },
          evidence: { model: "Photo 1 shows the Sage Barista Express label" },
        },
      ],
    });
  return { dir, run, store, importItem };
}

void test("opening enquiries omit an already acceptable asking price, including a free item", (t) => {
  const { importItem } = fixture(t);
  const listing = importItem("123456789", 15000).listings[0];
  assert.ok(listing);
  assert.equal(openingOfferPrice(listing, search), 15000);
  assert.equal(openingDraft(listing, search).price_minor, null);
  assert.equal(openingDraft(listing, search).intent, "message");
  assert.doesNotMatch(openingDraft(listing, search).text, /£|Sage|Barista/u);
  assert.equal(openingDraft({ ...listing, price_minor: 0 }, search).price_minor, null);
  assert.equal(openingDraft({ ...listing, price_minor: null }, search).price_minor, null);
  const offer = openingDraft({ ...listing, price_minor: 25000 }, search);
  assert.equal(offer.intent, "offer");
  assert.equal(offer.price_minor, 20000);
  assert.match(offer.text, /would you consider £200/u);
  assert.doesNotMatch(offer.text, /Sage|collect/u);
  assert.equal(
    openingDraft({ ...listing, price_minor: 25000, description: "No offers" }, search).price_minor,
    null,
  );
  assert.equal(openingOfferPrice({ ...listing, price_minor: 25000 }, search), 20000);
  assert.equal(openingOfferPrice({ ...listing, price_minor: 0 }, search), 0);
  assert.equal(openingOfferPrice({ ...listing, price_minor: null }, search), 20000);
  assert.equal(openingOfferPrice({ ...listing, currency: "USD" }, search), 15000);
});

void test("the Gaggia opening uses a short enquiry, retaining inspection details without sending them", (t) => {
  const { importItem } = fixture(t);
  const original = importItem("123456789", 2800).listings[0];
  assert.ok(original);
  const definitions = [
    [
      "functional",
      "Working condition",
      "Could you demonstrate it brewing and steaming without leaks or errors?",
    ],
    ["model_label", "Model label", "Could you share a clear photo of the model label?"],
    ["descaling", "Descaling", "When was it last cleaned and descaled?"],
    ["repairs", "Repairs", "Has it had any faults or repairs?"],
    ["portafilter", "Portafilter", "Is the pictured portafilter included and usable?"],
    ["filter_baskets", "Baskets", "Are all four baskets included and usable?"],
    ["tamper", "Tamper", "Is the tamper included and usable?"],
    ["water_tank", "Water tank", "Is the water tank complete?"],
  ].map(([id, label, question]) => ({
    id: id ?? "unknown",
    label: label ?? "Unknown",
    question: question ?? "Unknown?",
    state: "unknown" as const,
    evidence: null,
  }));
  const listing = {
    ...original,
    title: "Gaggia coffee machine",
    functional: null,
    verification_checks: definitions,
    attributes: { accessories: ["portafilter", "four baskets", "tamper", "water tank"] },
    evidence: {
      accessories: "Photo 2 clearly shows the portafilter, four baskets, tamper and water tank.",
    },
  };
  const checks = verificationChecks(listing, search.discovery?.verification_checks);
  assert.equal(checks.length, 8);
  assert.equal(checks.filter((check) => check.state === "confirmed").length, 4);
  assert.equal(unresolvedQuestions(checks).length, 4);
  const draft = openingDraft(listing, search, [
    "Travel to Example destination town needs checking",
  ]);
  assert.equal(draft.text, "Hi, is this still available? Does it all work okay?");
  assert.deepEqual(draft.verification_questions, ["Does it all work okay?"]);
  assert.equal(draft.intent, "message");
  assert.equal(draft.price_minor, null);
  assert.equal(draft.collection, null);
  assert.deepEqual(
    initialSellerMessageDraft(listing, 2800, openingQuestions(checks)).verification_questions,
    draft.verification_questions,
  );
  assert.equal(initialSellerMessageDraft(listing, 2800, openingQuestions(checks)).text, draft.text);
  const verified = {
    ...listing,
    functional: true,
    verification_checks: checks.filter((check) => check.state === "confirmed"),
  };
  assert.equal(
    openingDraft(verified, search, ["Conflicting travel estimates"]).text,
    "Hi, is this still available?",
  );
  const describedAsWorking = {
    ...verified,
    description: "Everything works well.",
    functional: null,
    verification_checks: [
      ...verified.verification_checks,
      {
        id: "functional",
        label: "Working condition",
        question: "Could you demonstrate it brewing and steaming?",
        state: "confirmed" as const,
        evidence: "Seller's description states everything works well.",
      },
    ],
  };
  assert.equal(openingDraft(describedAsWorking, search).text, "Hi, is this still available?");
  assert.deepEqual(openingDraft(describedAsWorking, search).verification_questions, []);
  const uncertainPortafilter = {
    ...describedAsWorking,
    attributes: {},
    evidence: {},
    verification_checks: describedAsWorking.verification_checks.map((check) =>
      check.id === "portafilter"
        ? Object.assign({}, check, { state: "unknown" as const, evidence: null })
        : check,
    ),
  };
  assert.equal(
    openingDraft(uncertainPortafilter, search).text,
    "Hi, is this still available? Does it include the portafilter?",
  );

  const unclear = { ...listing, attributes: {}, evidence: {} };
  const enquiry = openingDraft(unclear, search);
  assert.equal(
    enquiry.text,
    "Hi, is this still available? Does it all work okay? Are all the parts and accessories included?",
  );
  assert.equal(enquiry.verification_questions?.length, 2);
  assert.doesNotMatch(
    enquiry.text,
    /Gaggia|£|photo|demonstrat|leak|repair|descal|Ashby|collect|four/iu,
  );
});

void test("known missing parts remain recorded without asking whether they are included", () => {
  const check = {
    id: "portafilter",
    label: "Portafilter",
    question: "Does it include the portafilter?",
    state: "missing" as const,
    evidence: "Seller states the portafilter is missing.",
  };
  assert.deepEqual(openingQuestions([check]), []);
  assert.deepEqual(unresolvedQuestions([check]), [check.question]);
  assert.deepEqual(openingQuestions([{ ...check, state: "conflicting" }]), [check.question]);
});

void test("sourced package contents resolve included essentials while unknown and conflicting details stay open", (t) => {
  const { importItem } = fixture(t);
  const listing = importItem("123456789").listings[0];
  assert.ok(listing);
  const confirmed = {
    ...listing,
    attributes: { package_contents: "machine; portafilter; baskets; tamper; milk jug" },
    evidence: {
      package_contents: "Photo 3 shows portafilter, three baskets and integrated tamper.",
    },
  };
  assert.equal(unresolvedQuestions(verificationChecks(confirmed)).length, 0);
  const unknown = { ...confirmed, evidence: {} };
  assert.ok(
    unresolvedQuestions(verificationChecks(unknown)).some((question) =>
      question.includes("portafilter"),
    ),
  );
  const expected = search.discovery?.verification_checks ?? [];
  const stale = {
    ...confirmed,
    verification_checks: [
      {
        ...expected[0],
        id: "portafilter",
        label: "Portafilter",
        question: "Does it include the portafilter?",
        state: "unknown" as const,
        evidence: null,
      },
    ],
  };
  assert.equal(verificationChecks(stale, expected)[0]?.state, "confirmed");
  assert.equal(
    verificationChecks(
      {
        ...stale,
        verification_checks: [
          {
            ...stale.verification_checks[0],
            id: "portafilter",
            label: "Portafilter",
            question: "Does it include the portafilter?",
            state: "conflicting" as const,
            evidence: "Description and photo disagree about inclusion.",
          },
        ],
      },
      expected,
    )[0]?.state,
    "conflicting",
  );
  assert.equal(
    verificationChecks(
      { ...confirmed, attributes: { package_contents: "machine; no portafilter" } },
      expected,
    )[0]?.state,
    "unknown",
  );
});

void test("search completion prepares a conditional reviewed draft without outreach and preserves edits on reruns", (t) => {
  const { run, dir } = fixture(t);
  let searchRun = run("request_search_run", {
    request: { search_id: search.id, request_id: randomUUID() },
  }).search_runs[0];
  assert.ok(searchRun);
  run("import_listing_observations", {
    run_id: searchRun.id,
    observations: [
      {
        listing_id: "123456789",
        title: "Sage Barista Express",
        url: "https://www.facebook.com/marketplace/item/123456789/",
        source: "facebook_marketplace",
        provenance: "manual",
        product: "espresso_machine",
        price_minor: 22000,
        price_kind: "asking",
        currency: "GBP",
        availability: "active",
        observed_at: new Date().toISOString(),
        attributes: { model: "Sage Barista Express" },
      },
    ],
  });
  searchRun = run("get_workspace").search_runs[0];
  assert.ok(searchRun);
  for (const query of searchRun.queries) {
    searchRun = run("update_search_run", {
      request: {
        run_id: searchRun.id,
        expected_version: searchRun.version,
        query: { ...query, status: "completed" },
      },
    }).search_runs[0];
    assert.ok(searchRun);
  }
  const completed = run("update_search_run", {
    request: { run_id: searchRun.id, expected_version: searchRun.version, phase: "completed" },
  });
  assert.equal(
    completed.seller_conversations.length,
    1,
    JSON.stringify({
      decisions: completed.decisions.map((item) => ({
        search: item.search_id,
        suitability: item.suitability,
        reasons: item.reasons,
      })),
      run: completed.search_runs[0]?.listing_keys,
    }),
  );
  const key = completed.listings[0]?.key;
  assert.ok(key);
  let conversation = run("get_seller_conversation", { listing_key: key }).seller_conversation;
  assert.ok(conversation?.draft);
  assert.match(conversation.draft.text, /£200/);
  assert.match(conversation.draft.text, /portafilter/);
  assert.equal(conversation.actions.length, 0);
  assert.equal(completed.next_steps[0]?.readiness, "verify_and_negotiate");
  assert.equal(completed.next_steps[0]?.draft_text, conversation.draft.text);
  run("save_seller_message_draft", {
    listing_key: key,
    expected_version: conversation.version,
    draft: { ...conversation.draft, text: "My edited message" },
  });
  run("prepare_next_steps", { search_id: search.id, run_id: searchRun.id });
  conversation = stateSchema.parse(
    Effect.runSync(
      new WorkspaceStore(seedWorkspace(dir)).request("get_seller_conversation", {
        listing_key: key,
      }),
    ).state,
  ).seller_conversation;
  assert.equal(conversation?.draft?.text, "My edited message");
  assert.equal(conversation?.actions.length, 0);
});

void test("recommendations exclude rejected and withdrawn items while a missing price baseline remains actionable", (t) => {
  const { run, importItem } = fixture(t);
  const state = importItem("123456789");
  const item = recommendations(state, search.id)[0];
  assert.ok(item);
  assert.equal(
    state.decisions.find((decision) => decision.search_id === search.id)?.value,
    "unknown",
  );
  const rejected = {
    ...state,
    decisions: state.decisions.map((decision) =>
      Object.assign({}, decision, { suitability: "unsuitable" as const }),
    ),
  };
  assert.equal(recommendations(rejected, search.id).length, 0);
  run("set_buying_outcome", {
    listing_key: item.listing_key,
    expected_version: 0,
    outcome: "withdrawn",
  });
  assert.equal(recommendations(run("get_workspace"), search.id).length, 0);
});

void test("collection plans retain uncertainty, generate a reviewed message and require evidence for confirmation", (t) => {
  const { run, importItem, dir } = fixture(t);
  const key = importItem("123456789").listings[0]?.key;
  assert.ok(key);
  run("prepare_next_steps", { search_id: search.id });
  let conversation = run("get_seller_conversation", { listing_key: key }).seller_conversation;
  assert.ok(conversation);
  const plan = collectionPlanSchema.parse({
    purpose: "viewing",
    status: "draft",
    when: null,
    pickup_location: null,
    demonstration: "espresso extraction and the grinder",
    evidence: null,
    seller_message_id: null,
    provenance: "user_reported",
  });
  assert.equal(collectionPlanSchema.safeParse({ ...plan, status: "confirmed" }).success, false);
  conversation = run("save_collection_plan", {
    listing_key: key,
    expected_version: conversation.version,
    plan,
  }).seller_conversation;
  assert.ok(conversation);
  conversation = run("prepare_collection_message", {
    listing_key: key,
    expected_version: conversation.version,
  }).seller_conversation;
  assert.ok(conversation?.draft);
  assert.equal(conversation.draft.intent, "arrange");
  assert.match(conversation.draft.text, /arrange a viewing/u);
  assert.match(
    conversation.draft.text,
    /Could you demonstrate espresso extraction and the grinder when I view it/u,
  );
  assert.match(conversation.draft.text, /What date and time/);
  assert.match(conversation.draft.text, /Where would we meet/);
  assert.match(conversation.draft.text, /portafilter/);
  assert.doesNotMatch(conversation.draft.text, /I can collect/);
  assert.equal(conversation.actions.length, 0);
  assert.throws(
    () =>
      run("save_collection_plan", {
        listing_key: key,
        expected_version: conversation.version,
        plan: {
          ...plan,
          provenance: "seller_message",
          evidence: "Seller confirmed",
          seller_message_id: "missing",
        },
      }),
    /saved reply/,
  );
  const restored = stateSchema.parse(
    Effect.runSync(
      new WorkspaceStore(seedWorkspace(dir)).request("get_seller_conversation", {
        listing_key: key,
      }),
    ).state,
  ).seller_conversation;
  assert.deepEqual(restored?.collection_plan, plan);
});

void test("a confirmed purchase fulfils linked goals, stops searches and new outreach, and can be reopened", (t) => {
  const { run, importItem } = fixture(t);
  const key = importItem("123456789").listings[0]?.key;
  assert.ok(key);
  run("prepare_next_steps", { search_id: search.id });
  const conversation = run("get_seller_conversation", { listing_key: key }).seller_conversation;
  assert.ok(conversation);
  run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } });
  const watchChoice = run("set_monitoring", {
    expected_entity_revision: revisionFor(run("get_workspace"), "set_monitoring", {
      monitoring: { search_id: search.id },
    }),
    monitoring: { search_id: search.id, preference: "recurring" },
  });
  const hostReceipt = {
    search_id: search.id,
    automation_id: "fixture-buying-search",
    thread_id: "00000000-0000-4000-8000-000000000001",
    status: "active",
    interval_minutes: 60,
    evidence: "Fictional host schedule in an isolated test",
  };
  run("report_host_schedule", {
    expected_entity_revision: revisionFor(watchChoice, "report_host_schedule", {
      report: hostReceipt,
    }),
    report: hostReceipt,
  });
  const bought = run("set_buying_outcome", {
    listing_key: key,
    expected_version: conversation.version,
    outcome: "bought",
  });
  assert.equal(fulfilledSearches(bought.seller_conversations).has(search.id), true);
  assert.equal(bought.next_steps.length, 0);
  assert.equal(
    bought.monitoring.find((item) => item.search_id === search.id)?.next_action,
    "pause",
  );
  assert.throws(
    () =>
      run("report_host_schedule", {
        expected_entity_revision: revisionFor(bought, "report_host_schedule", {
          report: hostReceipt,
        }),
        report: hostReceipt,
      }),
    /fulfilled/,
  );
  assert.equal(
    bought.search_runs.find((searchRun) => searchRun.search_id === search.id)?.phase,
    "cancelled",
  );
  assert.equal(
    bought.counts.active_searches,
    bought.searches.filter((item) => item.enabled && item.id !== search.id).length,
  );
  assert.throws(
    () =>
      run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } }),
    /fulfilled/,
  );
  const otherKey = importItem("987654321").listings.find(
    (item) => item.listing_id === "987654321",
  )?.key;
  assert.ok(otherKey);
  run("save_seller_message_draft", {
    listing_key: otherKey,
    expected_version: 0,
    draft: {
      ...conversation.draft,
      search_id: search.id,
      text: "Another offer",
      price_minor: 20000,
      currency: "GBP",
      price_period: "once",
      intent: "offer",
      collection: null,
      responds_to: null,
    },
  });
  const other = run("get_seller_conversation", { listing_key: otherKey }).seller_conversation;
  assert.ok(other);
  assert.throws(
    () =>
      run("request_seller_action", {
        listing_key: otherKey,
        expected_version: other.version,
        kind: "send",
        request_id: randomUUID(),
      }),
    /fulfilled/,
  );
  const closed = bought.seller_conversation;
  assert.ok(closed);
  const reopened = run("set_buying_outcome", {
    listing_key: key,
    expected_version: closed.version,
    outcome: "open",
  });
  assert.equal(fulfilledSearches(reopened.seller_conversations).has(search.id), false);
  assert.ok(
    run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } })
      .search_runs.length,
  );
});

void test("next actions distinguish replies, agreed deals, confirmed appointments and completed purchases", (t) => {
  const { run, importItem } = fixture(t);
  const key = importItem("123456789").listings[0]?.key;
  assert.ok(key);
  run("prepare_next_steps", { search_id: search.id });
  const conversation = run("get_seller_conversation", { listing_key: key }).seller_conversation;
  assert.ok(conversation);
  assert.equal(sellerSummary(conversation).action_label, "Review message");
  assert.equal(
    sellerSummary({ ...conversation, phase: "awaiting_reply" }).action_label,
    "Check replies",
  );
  assert.equal(
    sellerSummary({ ...conversation, phase: "counteroffer" }).action_label,
    "Review counteroffer",
  );
  assert.equal(
    sellerSummary({ ...conversation, phase: "accepted" }).action_label,
    "Arrange collection",
  );
  assert.equal(
    sellerSummary({
      ...conversation,
      phase: "accepted",
      collection_plan: {
        purpose: "collection",
        status: "confirmed",
        when: { date: "2026-10-10", time: null, end_time: null, timezone: "Europe/London" },
        pickup_location: "Seller's confirmed pickup location",
        demonstration: null,
        evidence: "Buyer reports agreement",
        seller_message_id: null,
        provenance: "user_reported",
      },
    }).action_label,
    "Confirm purchase",
  );
  assert.equal(sellerSummary({ ...conversation, outcome: "bought" }).action_label, "View history");
});

void test("accepted offers produce a collection plan and keep agreed and advertised prices separate", (t) => {
  const { run, importItem } = fixture(t);
  const key = importItem("123456789").listings[0]?.key;
  assert.ok(key);
  run("prepare_next_steps", { search_id: search.id });
  let conversation = run("get_seller_conversation", { listing_key: key }).seller_conversation;
  assert.ok(conversation);
  const agreed = run("record_user_reported_message", {
    listing_key: key,
    expected_version: conversation.version,
    direction: "incoming",
    message: {
      external_id: "seller-accepts",
      text: "Yes, £200 is fine.",
      platform_at: null,
      facets: {
        price: "accept",
        price_minor: 20000,
        availability: "available",
        collection: "none",
        information_request: false,
        unclear: false,
        supporting_text: "£200 is fine",
      },
    },
  });
  conversation = agreed.seller_conversation;
  assert.ok(conversation?.collection_plan);
  assert.equal(conversation.collection_plan.status, "draft");
  assert.equal(conversation.agreed_price_minor, 20000);
  assert.equal(agreed.listings[0]?.price_minor, 22000);
  assert.equal(agreed.next_steps[0]?.label, "Arrange collection");
  const when = { date: "2026-10-10", time: "10:00", end_time: null, timezone: "Europe/London" };
  conversation = run("save_collection_plan", {
    listing_key: key,
    expected_version: conversation.version,
    plan: {
      ...conversation.collection_plan,
      purpose: "viewing",
      status: "proposed",
      when,
      pickup_location: "Agreed pickup address",
    },
  }).seller_conversation;
  assert.ok(conversation);
  conversation = run("prepare_collection_message", {
    listing_key: key,
    expected_version: conversation.version,
  }).seller_conversation;
  assert.ok(conversation?.draft);
  assert.equal(conversation.draft.price_minor, 20000);
  assert.equal(conversation.draft.collection?.time, "10:00");
  assert.match(conversation.draft.text, /If those details check out/);
  assert.match(conversation.draft.text, /Is Agreed pickup address the right pickup location/);
  assert.doesNotMatch(conversation.draft.text, /would you consider/);
  assert.equal(conversation.actions.length, 0);
  assert.throws(
    () =>
      run("save_collection_plan", {
        listing_key: key,
        expected_version: conversation.version,
        plan: {
          ...conversation.collection_plan,
          status: "confirmed",
          provenance: "seller_message",
          seller_message_id: conversation.messages[0]?.id,
          evidence: "£200 is fine",
        },
      }),
    /must confirm the collection/,
  );
});

void test("chat-only tools expose prepared actions without sending or loading image bytes", async (t) => {
  const { run, importItem, dir } = fixture(t);
  importItem("123456789");
  run("prepare_next_steps", { search_id: search.id });
  const { server, calls } = createGoodfindsServer(seedWorkspace(dir));
  t.after(async () => server.close());
  const get = calls.get("list_goodfinds_next_steps");
  assert.ok(get);
  const result = await get({ search_id: search.id });
  assert.equal(result.isError, undefined);
  assert.ok(result.content.every((block) => block.type === "text"));
  assert.match(JSON.stringify(result.structuredContent), /portafilter/);
  assert.ok(calls.has("save_goodfinds_collection_plan"));
  assert.ok(calls.has("prepare_goodfinds_collection_message"));
});
