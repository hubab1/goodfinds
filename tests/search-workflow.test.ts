import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { savedSearchSchema, searchDefinitionSchema } from "@goodfinds/contracts/search-definition";
import { stateFromToolResult, stateSchema } from "@goodfinds/contracts/state";
import { queryPlan, searchProgress } from "@goodfinds/contracts/search-workflow";
import { SEARCH_LEASE_MS } from "./reference-server/src/searches/runs.ts";
import {
  verificationChecks,
  unresolvedQuestions,
  setupCostTotal,
  verificationCheckSchema,
} from "@goodfinds/contracts/verification";
import { sellerMessageDraftSchema, offerMessage } from "@goodfinds/contracts/seller-conversation";
import {
  workspaceConfigurationSchema,
  listingObservationSchema,
} from "./reference-server/src/workspace/model.ts";
import { evaluateListing, matchListing } from "./reference-server/src/listings/evaluation.ts";
import { learnedCriteria } from "./reference-server/src/searches/learning.ts";
import { searchCohort } from "./reference-server/src/searches/definition.ts";

const definition = searchDefinitionSchema.parse({
  schema_version: 1,
  version: 1,
  category: "espresso_machine",
  title: "Espresso machines",
  description: "Manual espresso",
  price: { currency: "GBP", period: "once" },
  comparison_attributes: ["model", "accessories"],
  fields: [
    {
      id: "budget",
      label: "Complete setup budget",
      type: "integer",
      required: true,
      match: { attribute: "price_minor", operator: "lte" },
    },
  ],
});
const expected = [
  { id: "portafilter", label: "Portafilter", question: "Does it include the portafilter?" },
  { id: "filter_baskets", label: "Filter baskets", question: "Which filter baskets are included?" },
];
const search = savedSearchSchema.parse({
  id: "coffee",
  name: "Coffee",
  product: "espresso_machine",
  enabled: true,
  definition,
  values: { budget: 25000 },
  discovery: {
    scope: "exact",
    reference_model: "Sage Barista Express",
    category_terms: ["coffee machine", "espresso machine"],
    model_aliases: [
      { canonical: "Sage Barista Express", aliases: ["Sage BES875", "Breville Barista Express"] },
    ],
    query_plan: [{ text: "Sage coffee machine", purpose: "brand" }],
    verification_checks: expected,
  },
});
const stamp = new Date().toISOString();
function observation(id = "123456789", stage = "discovery") {
  return {
    listing_id: id,
    title: "Coffee machine",
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    source: "facebook_marketplace",
    provenance: "manual",
    product: "espresso_machine",
    price_minor: 18000,
    price_kind: "asking",
    currency: "GBP",
    availability: "active",
    observed_at: stamp,
    collection_stage: stage,
    attributes: { model: "Sage BES875" },
    evidence: { model: "Photo label BES875" },
  };
}
function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}
function fixture(t: TestContext, controlled = false) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(dir));
  let now = Date.now();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const run = (action: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(
      controlled
        ? store.request(action, args).pipe(Effect.provideService(Clock.Clock, clock))
        : store.request(action, args),
    ).state;
  const initial = run("get_workspace");
  run("save_search", {
    search,
    expected_entity_revision: revisionFor(initial, "save_search", { search }),
  });
  return {
    store,
    run,
    dir,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

void test("one background worker owns a run across clicks, reconnects and progress writes", (t) => {
  const { run, dir, clock } = fixture(t, true);
  let searchRun = required(
    run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } })
      .search_runs[0],
  );
  assert.ok(searchRun);
  const id = searchRun.id,
    worker = randomUUID();
  const claim = {
    run_id: id,
    expected_version: searchRun.version,
    worker_id: worker,
    agent_id: "/test/search",
    parent_thread_id: "buying-chat",
  };
  searchRun = required(run("claim_search_run", { request: claim }).search_runs[0]);
  assert.ok(searchRun);
  assert.equal(searchRun.worker?.agent_id, "/test/search");
  assert.equal(searchRun.phase, "discovering");
  assert.equal(
    run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } })
      .search_runs[0]?.version,
    searchRun.version,
  );
  assert.equal(
    Effect.runSync(
      new WorkspaceStore(seedWorkspace(dir))
        .request("get_workspace")
        .pipe(Effect.provideService(Clock.Clock, clock)),
    ).state.search_runs[0]?.worker?.id,
    worker,
  );
  assert.throws(
    () => run("claim_search_run", { request: { ...claim, worker_id: randomUUID() } }),
    /another agent/,
  );
  assert.throws(
    () => run("renew_search_lease", { request: { run_id: id, worker_id: randomUUID() } }),
    /another agent/,
  );
  assert.throws(
    () =>
      run("update_search_run", {
        request: { run_id: id, expected_version: searchRun.version, phase: "partial" },
      }),
    /another agent/,
  );
  assert.throws(
    () => run("import_listing_observations", { run_id: id, observations: [observation()] }),
    /another agent/,
  );
  assert.equal(
    run("get_workspace").listings.length,
    0,
    "an unowned import rolls back listing writes",
  );
  searchRun = required(
    run("import_listing_observations", {
      run_id: id,
      worker_id: worker,
      observations: [observation()],
    }).search_runs[0],
  );
  assert.ok(searchRun);
  assert.equal(searchRun.listing_keys.length, 1);
  const query = searchRun.queries.find((q) => q.purpose === "category");
  assert.ok(query);
  searchRun = required(
    run("update_search_run", {
      request: {
        run_id: id,
        worker_id: worker,
        expected_version: searchRun.version,
        phase: "verifying",
        query: { ...query, status: "completed" },
      },
    }).search_runs[0],
  );
  assert.ok(searchRun);
  assert.equal(searchRun.phase, "verifying");
  const stopped = required(run("cancel_search_run", { request: { run_id: id } }).search_runs[0]);
  assert.ok(stopped);
  assert.equal(stopped.phase, "cancelled");
  assert.equal(
    run("cancel_search_run", { request: { run_id: id } }).search_runs[0]?.version,
    stopped.version,
  );
  assert.throws(
    () => run("renew_search_lease", { request: { run_id: id, worker_id: worker } }),
    /stopped/,
  );
  assert.throws(
    () =>
      run("import_listing_observations", {
        run_id: id,
        worker_id: worker,
        observations: [observation("987654321")],
      }),
    /finished/,
  );
  assert.equal(run("get_workspace").listings.length, 1);
});

void test("activity expires truthfully, preserves results and fences a replaced worker", (t) => {
  const { run, advance } = fixture(t, true);
  let searchRun = required(
    run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } })
      .search_runs[0],
  );
  assert.ok(searchRun);
  const worker = randomUUID();
  searchRun = required(
    run("claim_search_run", {
      request: {
        run_id: searchRun.id,
        expected_version: searchRun.version,
        worker_id: worker,
        agent_id: "/test/search",
      },
    }).search_runs[0],
  );
  assert.ok(searchRun);
  advance(SEARCH_LEASE_MS - 1);
  searchRun = required(
    run("renew_search_lease", { request: { run_id: searchRun.id, worker_id: worker } })
      .search_runs[0],
  );
  assert.ok(searchRun);
  advance(2);
  assert.equal(run("get_workspace").search_runs[0]?.phase, "discovering");
  searchRun = required(
    run("import_listing_observations", {
      run_id: searchRun.id,
      worker_id: worker,
      observations: [observation()],
    }).search_runs[0],
  );
  assert.ok(searchRun);
  advance(SEARCH_LEASE_MS);
  const stopped = required(run("get_workspace").search_runs[0]);
  assert.ok(stopped);
  assert.equal(stopped.phase, "partial");
  assert.match(stopped.interruption ?? "", /stopped reporting/);
  assert.equal(stopped.listing_keys.length, 1);
  assert.throws(
    () => run("renew_search_lease", { request: { run_id: searchRun.id, worker_id: worker } }),
    /stopped/,
  );
  const resumed = required(
    run("request_search_run", {
      request: { search_id: search.id, request_id: randomUUID() },
    }).search_runs[0],
  );
  assert.ok(resumed);
  assert.equal(resumed.id, searchRun.id);
  assert.equal(resumed.worker, null);
  assert.throws(
    () =>
      run("import_listing_observations", {
        run_id: searchRun.id,
        worker_id: worker,
        observations: [observation("987654321")],
      }),
    /Claim/,
  );
  assert.throws(
    () =>
      run("update_search_run", {
        request: {
          run_id: searchRun.id,
          worker_id: worker,
          expected_version: resumed.version,
          phase: "partial",
        },
      }),
    /Claim/,
  );
  const replacement = randomUUID();
  searchRun = required(
    run("claim_search_run", {
      request: {
        run_id: resumed.id,
        expected_version: resumed.version,
        worker_id: replacement,
        agent_id: "/test/replacement",
      },
    }).search_runs[0],
  );
  assert.ok(searchRun);
  assert.throws(
    () =>
      run("import_listing_observations", {
        run_id: searchRun.id,
        worker_id: worker,
        observations: [observation("987654321")],
      }),
    /another agent/,
  );
  assert.equal(run("get_workspace").listings.length, 1);
  advance(SEARCH_LEASE_MS);
  run("get_workspace");
  const before = required(
    run("request_search_run", {
      request: { search_id: search.id, request_id: randomUUID() },
    }).search_runs[0],
  );
  assert.ok(before);
  advance(SEARCH_LEASE_MS);
  const unclaimed = required(run("get_workspace").search_runs[0]);
  assert.ok(unclaimed);
  assert.equal(unclaimed.phase, "partial");
  assert.match(unclaimed.interruption ?? "", /did not start/);
  assert.equal(unclaimed.id, before.id);
});

void test("queued failures stay blocked and a changed buying brief rejects old workers", (t) => {
  const { run, advance } = fixture(t, true);
  const queued = required(
    run("request_search_run", {
      request: { search_id: search.id, request_id: randomUUID() },
    }).search_runs[0],
  );
  assert.ok(queued);
  advance(SEARCH_LEASE_MS);
  assert.equal(run("get_workspace").search_runs[0]?.phase, "blocked");
  let searchRun = required(
    run("request_search_run", { request: { search_id: search.id, request_id: randomUUID() } })
      .search_runs[0],
  );
  assert.ok(searchRun);
  assert.throws(
    () =>
      run("claim_search_run", {
        request: {
          run_id: searchRun.id,
          expected_version: queued.version,
          worker_id: randomUUID(),
          agent_id: "/test/late",
        },
      }),
    /progress changed/,
  );
  const worker = randomUUID();
  searchRun = required(
    run("claim_search_run", {
      request: {
        run_id: searchRun.id,
        expected_version: searchRun.version,
        worker_id: worker,
        agent_id: "/test/worker",
      },
    }).search_runs[0],
  );
  assert.ok(searchRun);
  const state = run("get_workspace");
  run("save_search", {
    search: { ...search, values: { budget: 20000 } },
    expected_entity_revision: revisionFor(state, "save_search", { search: { ...search } }),
  });
  assert.throws(
    () => run("renew_search_lease", { request: { run_id: searchRun.id, worker_id: worker } }),
    /brief changed/,
  );
  assert.throws(
    () =>
      run("import_listing_observations", {
        run_id: searchRun.id,
        worker_id: worker,
        observations: [observation()],
      }),
    /current search run/,
  );
  assert.equal(run("get_workspace").listings.length, 0);
});

void test("exact requirements discover category and aliases early without accepting unrelated models", () => {
  const plan = queryPlan(search);
  assert.deepEqual(
    plan.slice(0, 3).map((query) => query.text),
    ["Sage Barista Express", "coffee machine", "espresso machine"],
  );
  assert.ok(plan.some((query) => query.purpose === "alias" && query.text === "Sage BES875"));
  const config = workspaceConfigurationSchema.parse({
    origin: "London",
    baseline_days: 30,
    minimum_peer_listings: 3,
    alert_policy: "first_qualification_and_lower_price",
    searches: [search],
  });
  const row = listingObservationSchema.parse({ ...observation(), key: "manual:123456789" });
  assert.deepEqual(learnedCriteria(row, search, config, true)[0], []);
  assert.match(
    learnedCriteria({ ...row, attributes: { model: "Bambino" } }, search, config, true)[0].join(),
    /Different model/,
  );
  assert.equal(
    searchCohort(
      {
        ...row,
        attributes: { model: "Sage BES875", accessories: ["filter_baskets", "portafilter"] },
      },
      search,
    ),
    searchCohort(
      {
        ...row,
        attributes: {
          model: "Sage Barista Express",
          accessories: ["portafilter", "filter baskets"],
        },
      },
      search,
    ),
  );
});

void test("unseen parts generate questions, confirmed parts do not, and offers stay conditional", () => {
  const checks = verificationChecks(
    {
      condition: "good",
      functional: true,
      verification_checks: [
        {
          ...expected[0],
          id: "portafilter",
          label: "Portafilter",
          question: "Does it include the portafilter?",
          state: "confirmed",
          evidence: "Photo 2 clearly shows the correct portafilter",
        },
      ],
    },
    expected,
  );
  assert.deepEqual(unresolvedQuestions(checks), ["Which filter baskets are included?"]);
  assert.deepEqual(
    unresolvedQuestions(
      verificationChecks(
        {
          condition: "good",
          functional: true,
          attributes: { accessories: ["portafilter", "filter_baskets"] },
          evidence: { accessories: "Photo 2 shows the portafilter and baskets" },
        },
        expected,
      ),
    ),
    [],
  );
  assert.equal(
    verificationCheckSchema.safeParse({ ...checks[0], state: "missing", evidence: null }).success,
    false,
  );
  const draft = sellerMessageDraftSchema.parse({
    price_minor: 16000,
    currency: "GBP",
    price_period: "once",
    collection: { date: "2026-10-06", time: null, end_time: null, timezone: "Europe/London" },
    intent: "offer",
    responds_to: null,
    verification_questions: unresolvedQuestions(checks),
    text: "placeholder",
  });
  const text = offerMessage(draft, "Coffee machine");
  assert.match(text, /£160/);
  assert.match(text, /Which filter baskets/);
  assert.doesNotMatch(text, /collect|Coffee machine/u);
  assert.match(
    offerMessage({ ...draft, intent: "accept" }, "Coffee machine"),
    /If those details check out/u,
  );
  assert.doesNotMatch(text, /portafilter/);
  assert.doesNotMatch(
    offerMessage(
      { ...draft, price_minor: null, intent: "message", collection: null },
      "Coffee machine",
    ),
    /asking price/,
  );
});

void test("unknown comparison details stay possible and discovery cannot become an alert", () => {
  const config = workspaceConfigurationSchema.parse({
    origin: "London",
    baseline_days: 30,
    minimum_peer_listings: 3,
    alert_policy: "first_qualification_and_lower_price",
    searches: [search],
  });
  const row = listingObservationSchema.parse({ ...observation(), key: "manual:123456789" });
  const decision = evaluateListing(row, [], search, config, Date.now(), false);
  assert.notEqual(decision.suitability, "unsuitable");
  assert.equal(decision.verification, "needs_check");
  assert.equal(decision.value, "unknown");
  assert.equal(decision.quality.eligibility["deal_alert"]?.eligible, false);
  assert.notEqual(matchListing(row, search, config, Date.now(), false)[0], "matched");
  assert.deepEqual(
    setupCostTotal({
      ...row,
      setup_costs: [
        {
          label: "Grinder",
          price_minor: 5000,
          currency: "GBP",
          basis: "estimate",
          evidence: "Manufacturer price",
        },
      ],
    }),
    { total_minor: 23000, basis: "estimate" },
  );
  assert.deepEqual(
    setupCostTotal({
      ...row,
      setup_costs: [
        { label: "Basket", price_minor: null, currency: "GBP", basis: "unknown", evidence: null },
      ],
    }),
    { total_minor: null, basis: "unknown" },
  );
  assert.equal(
    setupCostTotal({
      ...row,
      setup_costs: [
        {
          label: "Basket",
          price_minor: 1000,
          currency: "USD",
          basis: "observed",
          evidence: "Listing",
        },
      ],
    }).total_minor,
    null,
  );
});

void test("search runs resume, reject incomplete coverage and stale updates, and deduplicate imports", (t) => {
  const { run } = fixture(t);
  const requestId = randomUUID();
  let searchRun = run("request_search_run", {
    request: { search_id: search.id, request_id: requestId },
  }).search_runs[0];
  assert.ok(searchRun);
  const id = searchRun.id,
    initialVersion = searchRun.version;
  assert.equal(
    run("request_search_run", { request: { search_id: search.id, request_id: requestId } })
      .search_runs[0]?.version,
    searchRun.version,
  );
  assert.throws(
    () =>
      run("update_search_run", {
        request: { run_id: id, expected_version: initialVersion, phase: "completed" },
      }),
    /broad category/,
  );
  assert.throws(
    () =>
      run("update_search_run", {
        request: { run_id: id, expected_version: initialVersion, phase: "verifying" },
      }),
    /broad category/,
  );
  let next = run("import_listing_observations", { observations: [observation()], run_id: id });
  searchRun = next.search_runs[0];
  assert.ok(searchRun);
  assert.equal(searchRun.listing_keys.length, 1);
  assert.ok(searchRun.first_result_at);
  next = run("import_listing_observations", { observations: [observation()], run_id: id });
  searchRun = next.search_runs[0];
  assert.ok(searchRun);
  assert.equal(searchRun.listing_keys.length, 1);
  const query = searchRun.queries.find((item) => item.purpose === "category");
  assert.ok(query);
  const version = searchRun.version;
  searchRun = run("update_search_run", {
    request: {
      run_id: id,
      expected_version: version,
      query: { ...query, status: "completed", result_count: 20, unique_relevant_count: 1 },
      phase: "verifying",
      next_step: "Review shortlist",
    },
  }).search_runs[0];
  assert.ok(searchRun);
  assert.equal(searchProgress(searchRun).category_checked, true);
  assert.throws(
    () =>
      run("update_search_run", {
        request: { run_id: id, expected_version: version, phase: "partial" },
      }),
    /progress changed/,
  );
  searchRun = run("update_search_run", {
    request: {
      run_id: id,
      expected_version: searchRun.version,
      phase: "partial",
      interruption: "Browser closed",
    },
  }).search_runs[0];
  assert.ok(searchRun);
  const resumed = run("request_search_run", {
    request: { search_id: search.id, request_id: randomUUID() },
  }).search_runs[0];
  assert.ok(resumed);
  assert.equal(resumed.id, searchRun.id);
  assert.equal(resumed.queries.find((item) => item.id === query.id)?.status, "completed");
  run("update_search_run", {
    request: { run_id: resumed.id, expected_version: resumed.version, phase: "cancelled" },
  });
  assert.throws(
    () =>
      run("import_listing_observations", { observations: [observation("987654321")], run_id: id }),
    /finished/,
  );
  assert.equal(
    run("get_workspace").listings.length,
    1,
    "Rejected imports roll back the observation too",
  );
});

void test("description enrichment updates provisional specs and repeated cards retain them", (t) => {
  const { run, dir } = fixture(t);
  const start = Date.now() - 60000;
  const card = {
    ...observation(),
    title: "Macbook Pro M5",
    product: "macbook_pro",
    price_minor: 129900,
    attributes: {},
    evidence: { title: "Macbook Pro M5" },
    observed_at: new Date(start).toISOString(),
  };
  run("import_listing_observations", { observations: [card] });
  const description = "It is 512 GB storage and 16 GB ram. 100% battery health";
  const evidence = { state: "observed", raw_text: description };
  const enriched = run("import_listing_observations", {
    observations: [
      {
        ...card,
        observed_at: new Date(start + 1000).toISOString(),
        description,
        chip: "M5",
        ram_gb: 16,
        ssd_gb: 512,
        evidence: { chip: "Macbook Pro M5", ram_gb: description, ssd_gb: description },
        field_evidence: { ram_gb: evidence },
      },
    ],
  }).listings[0];
  assert.ok(enriched);
  assert.equal(enriched.description, description);
  assert.equal(enriched.chip, "M5");
  assert.equal(enriched.ram_gb, 16);
  assert.equal(enriched.ssd_gb, 512);
  assert.deepEqual(enriched["field_evidence"], { ram_gb: evidence });
  assert.equal(enriched.collection_stage, "discovery");
  assert.notEqual(enriched.image_review?.complete, true);
  run("import_listing_observations", {
    observations: [{ ...card, observed_at: new Date(start + 2000).toISOString() }],
  });
  const retained = Effect.runSync(new WorkspaceStore(seedWorkspace(dir)).request("get_workspace"))
    .state.listings[0];
  assert.equal(retained?.description, description);
  assert.equal(retained?.ram_gb, 16);
  assert.equal(retained?.ssd_gb, 512);
  const corrected = run("import_listing_observations", {
    observations: [
      {
        ...card,
        observed_at: new Date(start + 3000).toISOString(),
        ram_gb: 24,
      },
    ],
  }).listings[0];
  assert.equal(corrected?.ram_gb, 24);
  assert.equal(corrected?.evidence?.["ram_gb"], undefined);
  assert.equal(
    z.record(z.string(), z.unknown()).parse(corrected?.["field_evidence"])["ram_gb"],
    undefined,
  );
});

void test("repeated discovery retains detailed evidence and selected draft questions survive restart", (t) => {
  const { run, dir } = fixture(t);
  const verified = {
    ...observation(),
    collection_stage: "verification",
    observed_at: new Date(Date.now() - 60000).toISOString(),
    attributes: { model: "Sage BES875", accessories: ["portafilter"] },
    verification_checks: [{ ...expected[0], state: "confirmed", evidence: "Photo 1" }],
    image_review: { total_images: 1, reviewed_positions: [1], complete: true },
  };
  run("import_listing_observations", { observations: [verified] });
  run("import_listing_observations", {
    observations: [{ ...observation(), observed_at: new Date(Date.now() - 30000).toISOString() }],
  });
  const state = run("import_listing_observations", {
    observations: [{ ...observation(), observed_at: new Date().toISOString() }],
  });
  const listing = state.listings[0];
  assert.ok(listing);
  assert.equal(listing.verification_checks?.[0]?.state, "confirmed");
  assert.equal(listing.image_review?.complete, true);
  assert.equal(listing.collection_stage, "discovery");
  assert.equal(
    state.decisions.find((decision) => decision.search_id === search.id)?.verification,
    "needs_check",
  );
  const conversation = run("get_seller_conversation", {
    listing_key: listing.key,
  }).seller_conversation;
  assert.ok(conversation);
  const draft = {
    price_minor: 16000,
    currency: "GBP",
    price_period: "once",
    intent: "offer",
    collection: null,
    responds_to: null,
    text: "Hi, could you confirm which baskets are included before I offer £160?",
    verification_questions: ["Which filter baskets are included?"],
  };
  run("save_seller_message_draft", {
    listing_key: listing.key,
    expected_version: conversation.version,
    draft,
  });
  const restored = Effect.runSync(
    new WorkspaceStore(seedWorkspace(dir)).request("get_seller_conversation", {
      listing_key: listing.key,
    }),
  ).state.seller_conversation;
  assert.equal(restored?.draft?.text, draft.text);
  assert.deepEqual(restored?.draft?.verification_questions, draft.verification_questions);
  assert.equal(
    restored?.actions.length,
    0,
    "Saving verification questions does not authorize contact",
  );
});

void test("MCP model results stay compact while app metadata and paginated evidence remain complete", async (t) => {
  const { dir } = fixture(t);
  const { server, calls } = createGoodfindsServer(seedWorkspace(dir));
  t.after(async () => server.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = calls.get(name);
    assert.ok(tool);
    return tool(args);
  };
  const imported = await call("import_goodfinds_listing_observations", {
    observations: [observation(), observation("987654321")],
  });
  const full = stateFromToolResult(imported);
  assert.equal(full.listings.length, 2);
  assert.equal(stateSchema.safeParse(imported.structuredContent?.["state"]).success, false);
  assert.ok(JSON.stringify(imported.structuredContent).length < JSON.stringify(full).length / 2);
  const context = await call("get_goodfinds_search_context", { search_id: search.id });
  assert.equal(context.isError, undefined);
  assert.equal("listings" in (context.structuredContent ?? {}), false);
  const page = z
    .object({
      listings: z.array(z.object({ key: z.string() })),
      next_offset: z.number().nullable(),
    })
    .parse(
      (await call("list_goodfinds_listings", { search_id: search.id, limit: 1 })).structuredContent,
    );
  assert.equal(page.listings.length, 1);
  assert.equal(page.next_offset, 1);
  const detail = await call("get_goodfinds_listing", { listing_key: page.listings[0]?.key });
  assert.equal(detail.isError, undefined);
  assert.ok(detail.structuredContent?.["listing"]);
});
