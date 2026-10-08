import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { Clock, Effect } from "effect";
import { z } from "zod";
import { WorkspaceStore } from "./reference-server/src/platform/workspace-sqlite.ts";
import {
  initializeWorkspaceDatabase,
  WORKSPACE_SCHEMA_VERSION,
} from "./reference-server/src/platform/database-schema.ts";
import { discoverySummary } from "./reference-server/src/platform/listing-discovery-sqlite.ts";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { backendLayer } from "./reference-server/src/entrypoints/backend.ts";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { operations } from "@goodfinds/contracts/operations";
import { revisionFor } from "./helpers/revisions.ts";
import { mergeSeen } from "../apps/ui/src/features/listings/listing-seen.ts";
import { relativeTime, exactTime } from "../apps/ui/src/lib/relative-time.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-reading-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkspaceStore(seedWorkspace(dir));
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1000000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  };
  const request = (action: string, args: Record<string, unknown> = {}) =>
    Effect.runSync(store.request(action, args).pipe(Effect.provideService(Clock.Clock, clock)))
      .state;
  const state = () => request("get_workspace");
  const search = state().searches[0];
  assert.ok(search);
  const query = (seen: "all" | "seen" | "unseen", searchId = search.id) =>
    z
      .object({ listings: z.array(z.object({ key: z.string() })), total: z.number() })
      .parse(
        Effect.runSync(
          store
            .query("list_listings", { search_id: searchId, seen, limit: 1 })
            .pipe(Effect.provideService(Clock.Clock, clock)),
        ),
      );
  const start = (searchId = search.id) => {
    const run = request("request_search_run", {
      request: { search_id: searchId, request_id: randomUUID() },
    }).search_runs.find((item) => item.search_id === searchId);
    assert.ok(run);
    return run;
  };
  const ingest = (ids: string[], runId?: string) =>
    request("import_listing_observations", {
      ...(runId ? { run_id: runId } : {}),
      observations: ids.map((listing_id) => ({
        listing_id,
        source: "facebook_marketplace",
        provenance: "manual",
        title: `Laptop ${listing_id}`,
        product: search.product,
        url: `https://www.facebook.com/marketplace/item/${listing_id}/`,
        price_minor: 90000,
        price_kind: "asking",
        observed_at: new Date(now).toISOString(),
        collection_stage: "discovery",
      })),
    });
  return {
    dir,
    store,
    request,
    state,
    query,
    start,
    ingest,
    search,
    at: (value: string) => {
      now = Date.parse(value);
    },
    seen: (listing_key: string, search_id = search.id, seen = true) =>
      request("set_listing_seen", { listings: [{ listing_key, search_id }], seen }),
  };
}

void test("seen receipts persist independently for each search, and rechecks do not create new finds", (t) => {
  const f = fixture(t);
  const first = f.start();
  assert.equal(f.state().searches[0]?.last_searched_at, null, "Queuing does not mean searched");
  let state = f.ingest(["201", "202"], first.id);
  const initialFound = state.searches[0]?.latest_found_at;
  assert.equal(state.searches[0]?.unseen_count, 2);
  assert.equal(state.searches[0]?.last_searched_at, "2026-10-07T12:00:00.000Z");
  const other = {
    ...state.config.searches.find((s) => s.id === f.search.id),
    id: "another-search",
    name: "Another laptop",
  };
  state = f.request("save_search", {
    search: other,
    expected_entity_revision: revisionFor(state, "save_search", { search: other }),
  });
  const another = f.start(other.id);
  state = f.ingest(["201"], another.id);
  const revision = state.revision,
    revisions = state.revisions;
  state = f.seen("manual:201");
  assert.equal(state.searches.find((s) => s.id === f.search.id)?.unseen_count, 1);
  assert.equal(state.searches.find((s) => s.id === other.id)?.unseen_count, 1);
  assert.equal(state.revision, revision, "Read receipts never invalidate an editor");
  assert.deepEqual(state.revisions, revisions);
  const seenAt = state.listings.find((l) => l.key === "manual:201")?.seen_in_searches?.[0]?.seen_at;
  f.at("2026-10-07T13:00:00.000Z");
  state = f.seen("manual:201");
  assert.equal(
    state.listings.find((l) => l.key === "manual:201")?.seen_in_searches?.[0]?.seen_at,
    seenAt,
  );
  state = f.ingest(["201"], first.id);
  assert.equal(state.searches.find((s) => s.id === f.search.id)?.latest_found_at, initialFound);
  assert.equal(state.searches.find((s) => s.id === f.search.id)?.unseen_count, 1);
  state = f.ingest(["203"], first.id);
  assert.equal(
    state.searches.find((s) => s.id === f.search.id)?.latest_found_at,
    "2026-10-07T13:00:00.000Z",
  );
  assert.equal(state.searches.find((s) => s.id === f.search.id)?.unseen_count, 2);
  state = Effect.runSync(new WorkspaceStore(seedWorkspace(f.dir)).request("get_workspace")).state;
  assert.equal(
    state.listings.find((l) => l.key === "manual:201")?.seen_in_searches?.[0]?.seen_at,
    seenAt,
  );
  assert.equal(state.searches.find((s) => s.id === other.id)?.unseen_count, 1);
  state = f.seen("manual:201", f.search.id, false);
  assert.equal(state.searches.find((s) => s.id === f.search.id)?.unseen_count, 3);
  const sample = Effect.runSync(new WorkspaceStore(f.dir, "sample").request("get_workspace")).state;
  assert.equal(
    sample.listings.some((l) => l.key === "manual:201"),
    false,
  );
});

void test("seen updates validate the whole batch; agent reads and listing queries never clear the inbox", (t) => {
  const f = fixture(t);
  const run = f.start();
  let state = f.ingest(["201", "202"], run.id);
  const other = {
    ...state.config.searches.find((s) => s.id === f.search.id),
    id: "unrelated",
    name: "Other search",
  };
  state = f.request("save_search", {
    search: other,
    expected_entity_revision: revisionFor(state, "save_search", { search: other }),
  });
  assert.throws(() =>
    f.request("set_listing_seen", {
      listings: [
        { search_id: f.search.id, listing_key: "manual:201" },
        { search_id: other.id, listing_key: "manual:202" },
      ],
    }),
  );
  assert.equal(
    f.state().listings.every((l) => l.seen_in_searches?.length === 0),
    true,
  );
  f.query("all");
  f.query("unseen");
  Effect.runSync(f.store.query("get_listing", { listing_key: "manual:201" }));
  const context = Effect.runSync(f.store.query("get_search_context", { search_id: f.search.id }));
  assert.ok("searches" in context);
  assert.equal(context.searches[0]?.unseen_count, 2);
  assert.equal(f.state().searches.find((s) => s.id === f.search.id)?.unseen_count, 2);
  f.seen("manual:201");
  const unseen = f.query("unseen"),
    seen = f.query("seen"),
    unrelated = f.query("seen", other.id);
  assert.ok("listings" in unseen && "listings" in seen && "listings" in unrelated);
  assert.deepEqual(
    unseen.listings.map((l) => l.key),
    ["manual:202"],
  );
  assert.equal(unseen.total, 1);
  assert.deepEqual(
    seen.listings.map((l) => l.key),
    ["manual:201"],
  );
  assert.equal(unrelated.total, 0);
});

void test("seen response merges preserve newer search edits and independently seen searches", (t) => {
  const f = fixture(t);
  const run = f.start();
  const old = f.ingest(["201"], run.id);
  const next = f.seen("manual:201");
  const latest = {
    ...old,
    revision: "latest",
    searches: old.searches.map((s) => Object.assign({}, s, { name: "New name" })),
  };
  const merged = mergeSeen(latest, next, [{ listing_key: "manual:201", search_id: f.search.id }]);
  assert.equal(merged.revision, "latest");
  assert.equal(merged.searches[0]?.name, "New name");
  assert.equal(merged.searches[0]?.unseen_count, 0);
  assert.equal(merged.searches[0]?.seen_count, 1);
  const sample = { ...latest, mode: "sample" as const };
  assert.equal(mergeSeen(sample, next, []), sample, "Different mode remains separate");
});

void test("claiming sets the actual start time once; renewing and queued runs cannot move it", (t) => {
  const f = fixture(t);
  let run = f.start();
  f.at("2026-10-07T12:00:30.000Z");
  const worker_id = randomUUID();
  const claimed = f.request("claim_search_run", {
    request: {
      run_id: run.id,
      expected_version: run.version,
      worker_id,
      agent_id: "/test/search",
      parent_thread_id: "buyer",
    },
  }).search_runs[0];
  assert.ok(claimed);
  run = claimed;
  assert.equal(run.started_at, "2026-10-07T12:00:30.000Z");
  f.at("2026-10-07T12:01:00.000Z");
  const renewed = f.request("renew_search_lease", { request: { run_id: run.id, worker_id } });
  assert.equal(renewed.search_runs[0]?.started_at, run.started_at);
  assert.equal(renewed.searches[0]?.last_searched_at, run.started_at);
});

void test("version 3 upgrade preserves discoveries and finds actual runs beyond the progress limit", () => {
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE listings(listing_key TEXT, provenance TEXT); CREATE TABLE search_runs(id TEXT, search_id TEXT, document_json TEXT); CREATE TABLE listing_search_discoveries(listing_key TEXT,search_id TEXT,run_id TEXT,run_started_at TEXT,recorded_at TEXT); PRAGMA user_version=3;",
    );
    const at = "2026-10-01T09:00:00.000Z";
    db.run("INSERT INTO search_runs VALUES(?,?,?)", [
      randomUUID(),
      "coffee",
      JSON.stringify({ phase: "completed", created_at: at }),
    ]);
    for (let i = 0; i < 60; i++)
      db.run("INSERT INTO search_runs VALUES(?,?,?)", [
        randomUUID(),
        "coffee",
        JSON.stringify({ phase: "cancelled", created_at: "2026-10-07T11:00:00.000Z" }),
      ]);
    const key = randomUUID();
    db.run("INSERT INTO listings VALUES(?,?)", ["manual:1", "manual"]);
    db.run("INSERT INTO listing_search_discoveries VALUES(?,?,?,?,?)", [
      "manual:1",
      "coffee",
      key,
      at,
      at,
    ]);
    initializeWorkspaceDatabase(db);
    initializeWorkspaceDatabase(db);
    assert.equal(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      WORKSPACE_SCHEMA_VERSION,
    );
    assert.equal(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM listing_seen").get()?.count,
      0,
    );
    const summary = Effect.runSync(discoverySummary(db, "manual"));
    assert.equal(summary.lastSearched.get("coffee"), at);
    assert.equal(summary.byListing.get("manual:1")?.[0]?.run_id, key);
  } finally {
    db.close();
  }
});

void test("MCP exposes seen status and filters to agents with the same durable panel behavior", async (t) => {
  const f = fixture(t);
  f.ingest(["201"]);
  const { server, calls } = createGoodfindsServer(
    f.dir,
    backendLayer(f.dir, null, () => Promise.resolve(null)),
  );
  t.after(() => server.close());
  const mark = calls.get("set_goodfinds_listing_seen");
  assert.ok(mark);
  const result = await mark({ listings: [{ listing_key: "manual:201", search_id: f.search.id }] });
  assert.equal(result.isError, undefined);
  const updated = operations.set_listing_seen.output.parse(result.structuredContent);
  assert.equal(updated.searches.find((s) => s.id === f.search.id)?.unseen_count, 0);
  assert.equal(updated.listings[0]?.seen_in_searches?.length, 1);
  assert.equal(stateFromToolResult(result).listings[0]?.seen_in_searches?.length, 1);
});

void test("relative timestamps cover past, future, missing and historical dates with exact hover text", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  assert.equal(relativeTime("2026-10-07T11:59:40.000Z", now), "just now");
  assert.equal(relativeTime("2026-10-07T11:58:00.000Z", now), "2 minutes ago");
  assert.equal(relativeTime("2026-10-07T09:00:00.000Z", now), "3 hours ago");
  assert.equal(relativeTime("2026-10-05T12:00:00.000Z", now), "2 days ago");
  assert.equal(relativeTime("2026-10-07T14:00:00.000Z", now), "in 2 hours");
  assert.equal(relativeTime(null, now), "Not checked yet");
  assert.equal(relativeTime("broken", now), "Unknown date");
  assert.match(exactTime("2025-10-07T12:00:00.000Z"), /2025/);
});
