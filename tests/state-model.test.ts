import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Clock, Effect } from "effect";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { searchRunSchema } from "@goodfinds/contracts/search-workflow";
import {
  SEARCH_LEASE_MS,
  searchBlockers,
  searchWorkflow,
  expiredSearchRun,
} from "@goodfinds/contracts/search-run-model";
import {
  sellerBlockers,
  sellerWorkflow,
  expiredSellerAction,
} from "@goodfinds/contracts/seller-action-model";
import { conversationSchema, sellerActionSchema } from "@goodfinds/contracts/seller-conversation";
import { operations } from "@goodfinds/contracts/operations";
import { listingSchema } from "@goodfinds/contracts/state";
import { listingWorkflow, mediaState } from "@goodfinds/contracts/listing-model";
import { WorkspaceStore } from "../apps/server/src/platform/workspace-sqlite.ts";
import { errorDetails } from "../apps/server/src/workspace/errors.ts";
import { repairQueue } from "../apps/server/src/listings/media.ts";
import { createGoodfindsServer } from "../apps/server/src/entrypoints/mcp.ts";
import { backendLayer } from "../apps/server/src/entrypoints/backend.ts";
import {
  executionPolicy,
  executionPolicySchema,
  workerTasks,
  WORKER_ROUTING_GUIDANCE,
} from "@goodfinds/contracts/worker-execution";
import { hostRequest, QUIET_BROWSING_GUIDANCE } from "@goodfinds/contracts/host-request";
import {
  checkStateModelDocs,
  formattedStateModel,
  renderStateModel,
  validateStateModels,
  stateModelPath,
  models,
} from "../scripts/state-model-docs.ts";

const now = Date.parse("2026-10-06T12:00:00Z");
const stamp = new Date(now).toISOString();
function runRecord() {
  return searchRunSchema.parse({
    id: randomUUID(),
    search_id: "coffee",
    search_revision: "brief",
    version: 0,
    phase: "requested",
    queries: [
      {
        id: "category",
        text: "coffee machine",
        purpose: "category",
        marketplace: "facebook_marketplace",
      },
    ],
    listing_keys: [],
    verified_keys: [],
    created_at: stamp,
    updated_at: stamp,
    first_result_at: null,
    next_step: "Discover",
    interruption: null,
  });
}
function fixture(t: TestContext) {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-model-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(folder));
  let time = now;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time,
    currentTimeMillis: Effect.sync(() => time),
    currentTimeNanosUnsafe: () => BigInt(time) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const execute = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runSync(effect.pipe(Effect.provideService(Clock.Clock, clock)));
  const request = (action: string, args: Record<string, unknown> = {}) =>
    execute(store.request(action, args));
  const state = request("get_workspace").state;
  const search = state.config.searches[0];
  assert.ok(search);
  const started = request("request_search_run", {
    request: { search_id: search.id, request_id: randomUUID() },
  }).state.search_runs[0];
  assert.ok(started);
  return {
    folder,
    store,
    execute,
    request,
    search,
    started,
    advance: () => {
      time += SEARCH_LEASE_MS + 1;
    },
  };
}
function sql<A>(path: string, work: (db: Database) => A): A {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}
const observation = {
  listing_id: "123456789",
  url: "https://www.facebook.com/marketplace/item/123456789/",
  title: "Coffee machine",
  product: "espresso_machine",
  source: "facebook_marketplace",
  provenance: "manual",
  availability: "active",
  observed_at: stamp,
  collection_stage: "discovery",
  price_minor: 18000,
  price_kind: "asking",
  currency: "GBP",
  photos: [],
  videos: [],
};

void test("collection dispatch selects Luna xhigh while judgment preserves the chat settings", () => {
  const collection = executionPolicySchema.parse(executionPolicy("collection"));
  assert.deepEqual(collection.spawn, {
    model: "gpt-6-luna",
    reasoning_effort: "xhigh",
    fork_turns: "none",
  });
  assert.deepEqual(executionPolicySchema.parse(executionPolicy("chat")).spawn, {});
  for (const task of ["buying_judgment", "seller_message", "monitoring"] as const)
    assert.deepEqual(executionPolicy(workerTasks[task].profile).spawn, {});
  assert.equal(
    searchWorkflow(null, { now }).actions.find((a) => a.event === "request")?.execution.profile,
    "collection",
  );
  const prompt = hostRequest(`Collect listings ${QUIET_BROWSING_GUIDANCE}`);
  assert.equal(prompt.split(WORKER_ROUTING_GUIDANCE).length, 2);
  assert.equal(prompt.split(QUIET_BROWSING_GUIDANCE).length, 2);
  assert.equal(hostRequest(prompt), prompt);
});

void test("actual search executor settings survive reconnect and renewal without becoming a new run default", (t) => {
  const f = fixture(t);
  const execution = {
    profile: "collection" as const,
    model: "gpt-6-luna",
    reasoning_effort: "xhigh" as const,
  };
  const claimed = f.request("claim_search_run", {
    request: {
      run_id: f.started.id,
      expected_version: f.started.version,
      worker_id: randomUUID(),
      agent_id: "/collection",
      execution,
    },
  }).state.search_runs[0];
  assert.ok(claimed?.worker);
  const reopened = f.execute(new WorkspaceStore(seedWorkspace(f.folder)).request("get_workspace"))
    .state.search_runs[0];
  assert.deepEqual(reopened?.worker?.execution, execution);
  const renewed = f.request("renew_search_lease", {
    request: { run_id: claimed.id, worker_id: claimed.worker.id },
  }).state.search_runs[0];
  assert.deepEqual(renewed?.worker?.execution, execution);
  assert.deepEqual(
    f.request("request_search_run", {
      request: { search_id: f.search.id, request_id: randomUUID() },
    }).state.search_runs[0]?.worker?.execution,
    execution,
  );
  f.advance();
  const resumed = f.request("request_search_run", {
    request: { search_id: f.search.id, request_id: randomUUID() },
  }).state.search_runs[0];
  assert.ok(resumed);
  assert.equal(resumed.worker, null);
  const unknown = f.request("claim_search_run", {
    request: {
      run_id: resumed.id,
      expected_version: resumed.version,
      worker_id: randomUUID(),
      agent_id: "/fallback",
    },
  }).state.search_runs[0];
  assert.equal(unknown?.worker?.execution, undefined);
});

void test("proposed coverage is guarded atomically and unknown executor inputs never appear available", () => {
  const run = runRecord();
  const context = {
    now,
    expected_version: run.version,
    search_current: true,
    search_exists: true,
    fulfilled: false,
  };
  const initial = searchWorkflow(run, context);
  assert.equal(initial.actions.find((a) => a.event === "claim")?.availability, "requires_input");
  assert.equal(initial.actions.find((a) => a.event === "progress")?.availability, "requires_input");
  assert.equal(initial.actions.find((a) => a.event === "cancel")?.availability, "available");
  assert.deepEqual(
    searchBlockers(run, "verify", { ...context, candidate: { ...run, phase: "verifying" } }).map(
      (b) => b.code,
    ),
    ["category_query_unchecked"],
  );
  const candidate = searchRunSchema.parse({
    ...run,
    phase: "completed",
    queries: run.queries.map((q) => ({ ...q, status: "completed" })),
  });
  assert.deepEqual(searchBlockers(run, "complete", { ...context, candidate }), []);
  assert.equal(run.queries[0]?.status, "planned");
  assert.ok(
    searchBlockers({ ...run, trigger: "scheduled" }, "complete", {
      ...context,
      candidate,
      scheduled_allowed: false,
    }).some((b) => b.code === "scheduled_ineligible"),
  );

  assert.deepEqual(
    searchBlockers(run, "complete", { ...context, expected_version: 9, candidate }).map(
      (b) => b.code,
    ),
    ["revision_conflict"],
  );
});

void test("pure expiry preserves evidence and requires a replacement executor", () => {
  const run = {
    ...runRecord(),
    listing_keys: ["manual:123"],
    worker: {
      id: randomUUID(),
      agent_id: "/agent",
      parent_thread_id: null,
      claimed_at: stamp,
      last_heartbeat_at: stamp,
      lease_expires_at: new Date(now + SEARCH_LEASE_MS).toISOString(),
    },
  };
  const projected = expiredSearchRun(run, now + SEARCH_LEASE_MS + 1);
  assert.equal(projected.phase, "partial");
  assert.equal(run.phase, "requested");
  assert.deepEqual(projected.listing_keys, run.listing_keys);
  assert.equal(
    searchWorkflow(projected, {
      now: now + SEARCH_LEASE_MS + 1,
      search_exists: true,
      search_current: true,
      fulfilled: false,
    }).actions.find((a) => a.event === "resume")?.availability,
    "requires_input",
  );
  assert.ok(
    searchBlockers(projected, "renew", {
      now: now + SEARCH_LEASE_MS + 1,
      worker_id: run.worker.id,
      search_current: true,
    }).some((b) => b.code === "lease_expired"),
  );
});

void test("read projections do not persist workflow views or reconcile expired run records", (t) => {
  const f = fixture(t);
  f.advance();
  const before = sql(f.store.databasePath, (db) =>
    db.query<{ document_json: string }, []>("SELECT document_json FROM search_runs").all(),
  );
  const read = operations.list_search_runs.output.parse(
    f.execute(f.store.query("list_search_runs", {})),
  );
  assert.equal(read.search_runs[0]?.phase, "blocked");
  assert.equal(read.search_run_workflows[f.started.id]?.state, "blocked");
  const context = operations.get_search_context.output.parse(
    f.execute(f.store.query("get_search_context", { search_id: f.search.id })),
  );
  assert.equal(context.search_workflows[f.search.id]?.state, "blocked");
  assert.deepEqual(Object.keys(context.search_workflows), [f.search.id]);
  const after = sql(f.store.databasePath, (db) =>
    db.query<{ document_json: string }, []>("SELECT document_json FROM search_runs").all(),
  );
  assert.deepEqual(after, before);
  assert.equal(
    searchRunSchema.parse(JSON.parse(before[0]?.document_json ?? "null") as unknown).phase,
    "requested",
  );
});

void test("search introspection and mutation rejection share blockers, and a rejected import rolls back", (t) => {
  const f = fixture(t);
  const request = { run_id: f.started.id, expected_version: f.started.version, phase: "verifying" };
  const proposal = searchRunSchema.parse({ ...f.started, phase: request.phase });
  const view = searchWorkflow(f.started, {
    now,
    expected_version: f.started.version,
    search_current: true,
    candidate: proposal,
  });
  const expected = view.actions.find((a) => a.event === "verify")?.blockers.map((b) => b.code);
  const failed = f.execute(
    f.store
      .request("update_search_run", { request })
      .pipe(Effect.match({ onFailure: errorDetails, onSuccess: () => null })),
  );
  assert.deepEqual(
    failed?.blockers?.map((b) => b.code),
    expected,
  );
  const worker = randomUUID();
  f.request("claim_search_run", {
    request: { run_id: f.started.id, expected_version: 0, worker_id: worker, agent_id: "/agent" },
  });
  const imported = f.execute(
    f.store
      .request("import_listing_observations", {
        run_id: f.started.id,
        worker_id: randomUUID(),
        observations: [{ ...observation, product: f.search.product }],
      })
      .pipe(Effect.match({ onFailure: errorDetails, onSuccess: () => null })),
  );
  assert.ok(
    imported?.blockers?.some((b) => b.code === "worker_mismatch"),
    imported?.message ?? "An import from the wrong worker must reject",
  );
  assert.equal(
    sql(
      f.store.databasePath,
      (db) =>
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM listing_observations").get()
          ?.count,
    ),
    0,
  );
});

function sellerRecord() {
  const action = sellerActionSchema.parse({
    id: randomUUID(),
    kind: "send",
    status: "ready_to_send",
    requested_at: stamp,
    started_at: stamp,
    confirmed_sent_at: null,
    finished_at: null,
    browser: "in_app",
    worker_id: "executor",
    lease_token: randomUUID(),
    lease_expires_at: new Date(now + SEARCH_LEASE_MS).toISOString(),
    draft: {
      text: "Hi, does it work?",
      currency: "GBP",
      price_period: "once",
      price_minor: null,
      intent: "message",
      collection: null,
      responds_to: null,
    },
    identity: null,
    evidence: null,
    reason: null,
  });
  return conversationSchema.parse({
    id: randomUUID(),
    listing_key: "manual:123",
    version: 2,
    created_at: stamp,
    updated_at: stamp,
    target: {
      listing_id: "123",
      url: "https://www.facebook.com/marketplace/item/123/",
      source: "facebook_marketplace",
      title: "Coffee machine",
      seller_profile_url: null,
      currency: "GBP",
      price_period: "once",
    },
    draft: action.draft,
    actions: [action],
    messages: [],
    events: [],
    phase: "accepted",
    outcome: "open",
    agreed_price_minor: 18000,
    first_sent_at: null,
    latest_sent_at: null,
    latest_incoming_at: null,
    last_checked_at: null,
  });
}
void test("seller descriptors never grant a permit and distinguish accepted offers, purchases and uncertain sends", () => {
  const conversation = sellerRecord();
  const view = sellerWorkflow(conversation, { now });
  assert.equal(view.conversation_phase, "accepted");
  assert.equal(view.buying_outcome, "open");
  assert.equal("execution" in view, false);
  assert.deepEqual(view.actions.find((a) => a.event === "permit")?.execution.spawn, {});
  assert.ok(
    view.actions
      .find((a) => a.event === "permit")
      ?.blockers.some((b) => b.code === "permit_already_issued"),
  );
  const action = conversation.actions[0];
  assert.ok(action);
  assert.ok(
    sellerBlockers(
      conversation,
      "permit",
      { now, lease_token: action.lease_token ?? undefined },
      action,
    ).some((b) => b.code === "permit_already_issued"),
  );
  const later = now + SEARCH_LEASE_MS + 1;
  assert.equal(expiredSellerAction(action, later).status, "uncertain");
  assert.equal(expiredSellerAction({ ...action, kind: "check" }, later).status, "blocked");
  const uncertain = sellerWorkflow(conversation, { now: later });
  assert.equal(uncertain.state, "uncertain");
  assert.equal(
    uncertain.actions.some((a) => a.event === "cancel"),
    false,
  );
  assert.equal(action.status, "ready_to_send");
});

void test("listing dimensions reuse scoped evaluation, conflict checks and independent media readiness", (t) => {
  const f = fixture(t);
  const row = listingSchema.parse({
    ...observation,
    key: "manual:123456789",
    media_capture: {
      status: "partial",
      expected_photos: 1,
      expected_videos: 0,
      captured_at: stamp,
    },
    verification_checks: [
      {
        id: "functional",
        label: "Working",
        question: "Does it work?",
        state: "conflicting",
        evidence: "Seller and photos disagree",
      },
    ],
  });
  const second = { ...f.search, id: "other", name: "Other" };
  const context = {
    config: {
      ...f.request("get_workspace").state.config,
      searches: [
        { ...f.search, product: row.product },
        { ...second, product: row.product },
      ],
      feedback: [
        {
          id: "dismiss",
          search_id: f.search.id,
          category: row.product,
          listing_key: row.key,
          action: "dismiss" as const,
          scope: "search" as const,
          created_at: stamp,
          undone: false,
        },
      ],
    },
    decisions: [
      {
        search_id: f.search.id,
        listing: row,
        suitability: "unsuitable" as const,
        verification: "needs_check" as const,
        value: "unknown" as const,
        reasons: ["Over budget"],
      },
      {
        search_id: second.id,
        listing: row,
        suitability: "suitable" as const,
        verification: "needs_check" as const,
        value: "unknown" as const,
        reasons: [],
      },
    ],
    next_steps: [],
    seller_conversations: [],
  };
  const view = listingWorkflow(row, context, now);
  assert.equal(view.evidence.state, "conflicting");
  assert.deepEqual(view.actions.find((a) => a.event === "observe")?.execution.spawn, {});
  assert.equal(
    view.actions.find((a) => a.event === "recover_media")?.execution.profile,
    "collection",
  );
  assert.equal(
    listingWorkflow({ ...row, verification_checks: [] }, context, now).actions.find(
      (a) => a.event === "observe",
    )?.execution.profile,
    "collection",
  );
  assert.equal(view.media.state, "pending");
  assert.equal(view.media.image_reviewed, false);
  assert.deepEqual(
    view.assessments.map((a) => [a.search_id, a.suitability, a.dismissed]),
    [
      [f.search.id, "unsuitable", true],
      [second.id, "suitable", false],
    ],
  );
  assert.equal(listingWorkflow(row, context, now, second.id).assessments.length, 1);
  const queue = repairQueue([row], now)[0];
  assert.equal(queue?.retry_at, mediaState(row, now).retry_at);
  assert.equal(queue?.ready, view.media.ready);
  assert.equal(view.media.ready, false);
  assert.equal(
    mediaState(
      {
        ...row,
        photos: [{}],
        media_capture: { status: "complete", expected_photos: 1, expected_videos: 0 },
      },
      now,
    ).state,
    "complete",
  );
  assert.equal(view.evidence.state, "conflicting");
});

void test("MCP read views are schema-validated and guard failures retain blocker codes", async (t) => {
  const f = fixture(t);
  const { calls, server } = createGoodfindsServer(
    f.folder,
    backendLayer(f.folder, null, async () => null),
  );
  t.after(() => server.close());
  const list = calls.get("list_goodfinds_search_runs"),
    update = calls.get("update_goodfinds_search_run");
  assert.ok(list);
  assert.ok(update);
  const read = operations.list_search_runs.output.parse(
    (await list({ progress_only: false })).structuredContent,
  );
  const run = read.search_runs[0];
  assert.ok(run);
  assert.ok(read.search_run_workflows[run.id]?.actions.length);
  const compact = operations.list_search_runs.output.parse(
    (await list({ progress_only: true })).structuredContent,
  );
  assert.deepEqual(compact.search_run_workflows, {});

  const failed = await update({
    request: { run_id: run.id, expected_version: run.version, phase: "verifying" },
  });
  assert.equal(failed.isError, true);
  const result = operations.update_search_run.wire.parse(failed.structuredContent);
  assert.ok(result.error?.blockers?.some((b) => b.code === "category_query_unchecked"));
});

void test("generated documentation is deterministic, validates references and detects stale content", async (t) => {
  validateStateModels();
  const expected = await formattedStateModel();
  assert.equal(readFileSync(stateModelPath, "utf8"), expected);
  assert.ok(renderStateModel().includes("category_query_unchecked"));
  assert.ok(expected.includes("```mermaid"));
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-docs-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = resolve(folder, "state-model.md");
  writeFileSync(path, expected + "\nStale content\n");
  await assert.rejects(checkStateModelDocs(path), /documentation is stale/u);
  writeFileSync(path, expected);
  await checkStateModelDocs(path);
});

void test("scoped listing reads expose derived guidance without persisting it", (t) => {
  const f = fixture(t);
  const state = f.request("import_listing_observations", {
    observations: [{ ...observation, product: f.search.product }],
  }).state;
  const row = state.listings[0];
  assert.ok(row);
  const read = operations.get_listing.output.parse(
    f.execute(f.store.query("get_listing", { listing_key: row.key, search_id: f.search.id })),
  );
  assert.equal(read.workflow.assessments[0]?.search_id, f.search.id);
  assert.equal(read.workflow.media.image_reviewed, false);
  const stored = sql(
    f.store.databasePath,
    (db) =>
      db.query<{ data: string }, []>("SELECT document_json AS data FROM listings").get()?.data,
  );
  assert.ok(stored);
  const document = listingSchema.parse(JSON.parse(stored) as unknown);
  assert.equal("workflow" in document, false);
  assert.equal("assessments" in document, false);
});

void test("documentation validation rejects dangling input, guard and diagram references", () => {
  const first = models[0];
  assert.ok(first);
  const event = {
    operation: "get_listing" as const,
    from: ["absent"],
    to: [],
    inputs: ["missing_input"],
    guards: [],
    meaning: "A deliberately invalid test entry",
  };
  assert.throws(
    () => validateStateModels([{ ...first, events: { invalid: event } }]),
    /unknown input/u,
  );
  assert.throws(
    () =>
      validateStateModels([
        { ...first, events: { invalid: { ...event, inputs: [], guards: ["missing_guard"] } } },
      ]),
    /unknown guard/u,
  );
  assert.throws(
    () =>
      validateStateModels([
        {
          ...first,
          events: {
            invalid: { ...event, inputs: [], diagram: [{ from: "absent", to: "requested" }] },
          },
        },
      ]),
    /invalid diagram/u,
  );
});
