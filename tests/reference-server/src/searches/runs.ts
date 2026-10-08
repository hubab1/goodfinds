import { SearchRunRepository } from "./repository.ts";
import type { SearchRunStorage } from "./repository.ts";
import { Clock, Context, Effect, Layer } from "effect";
import {
  ACTIVE_SEARCH_PHASES,
  RESUMABLE_SEARCH_PHASES,
  queryPlan,
  searchRunSchema,
} from "@goodfinds/contracts/search-workflow";
import {
  SEARCH_LEASE_MS,
  expiredSearchRun,
  searchBlockers,
  updateEvent,
  resumedSearchRun,
  stoppedSearchRun,
  claimedSearchPhase,
} from "@goodfinds/contracts/search-run-model";
import { assertWorkflow } from "@goodfinds/contracts/workflow-model";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { hash, iso } from "../workspace/model.ts";
import { validation } from "../workspace/errors.ts";

export { searchCommands } from "@goodfinds/contracts/search-workflow";
import { searchCommands } from "@goodfinds/contracts/search-workflow";

export { SEARCH_LEASE_MS } from "@goodfinds/contracts/search-run-model";
function touchWorker(run: SearchRun, now: number) {
  if (run.worker) {
    run.worker.last_heartbeat_at = iso(now);
    run.worker.lease_expires_at = iso(now + SEARCH_LEASE_MS);
  }
}
const runs = Effect.fnUntraced(function* (
  repository: SearchRunStorage,
  searchId?: string,
  reconcile = true,
) {
  const now = yield* Clock.currentTimeMillis;
  const parsed = yield* repository.list(searchId);
  for (const run of parsed) {
    const projected = expiredSearchRun(run, now);
    if (projected !== run) {
      const originalVersion = run.version;
      Object.assign(run, projected);
      if (!reconcile) continue;
      const current = yield* repository.saveIfVersion(run, originalVersion);
      if (current) Object.assign(run, current);
    }
  }
  return parsed;
});
const fulfilGoals = Effect.fnUntraced(function* (
  repository: SearchRunStorage,
  searchIds: string[],
  now: number,
) {
  const entries = yield* repository.list(undefined, null);
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const run = entry;
        if (searchIds.includes(run.search_id) && RESUMABLE_SEARCH_PHASES.has(run.phase)) {
          Object.assign(
            run,
            stoppedSearchRun(
              run,
              now,
              "Buying goal fulfilled. Saved listings and conversations are preserved.",
            ),
          );
          yield* repository.save(run);
        }
      }),
    { concurrency: 1, discard: true },
  );
});
const searchAction = Effect.fnUntraced(function* (
  repository: SearchRunStorage,
  action: string,
  input: unknown,
  searches: SavedSearch[],
  now: number,
  fulfilled: Set<string> = new Set(),
  feedback: FeedbackEvent[] = [],
) {
  if (action === "start") {
    const args = yield* validation(() => searchCommands.start.parse(input));
    const search = yield* validation(() => {
      const found = searches.find((item) => item.id === args.search_id);
      if (!found) throw new Error("Choose a saved search");
      return found;
    });
    yield* validation(() =>
      assertWorkflow(
        searchBlockers(null, "request", {
          now,
          search_exists: true,
          fulfilled: fulfilled.has(search.id),
          request_supplied: true,
        }),
      ),
    );
    const previous = yield* runs(repository, search.id);
    const sameRequest = yield* repository.find(args.request_id);
    if (sameRequest && sameRequest.search_id !== search.id)
      return yield* validation(() => {
        throw new Error("This request ID belongs to another search");
      });
    if (sameRequest) return sameRequest;
    const resumable = previous.find(
      (run) => RESUMABLE_SEARCH_PHASES.has(run.phase) && run.search_revision === hash(search),
    );
    if (resumable && (args.resume || ACTIVE_SEARCH_PHASES.has(resumable.phase))) {
      if (ACTIVE_SEARCH_PHASES.has(resumable.phase)) return resumable;
      const resumed = resumedSearchRun(resumable, now, args.trigger);
      yield* repository.save(resumed);
      return resumed;
    }
    const run = searchRunSchema.parse({
      id: args.request_id,
      search_id: search.id,
      search_revision: hash(search),
      trigger: args.trigger,
      scheduled_at: args.trigger === "scheduled" ? iso(now) : null,
      version: 0,
      phase: "requested",
      queries: queryPlan(search, feedback),
      listing_keys: [],
      verified_keys: [],
      created_at: iso(now),
      updated_at: iso(now),
      first_result_at: null,
      next_step: "Search the exact model and broad category queries before detailed verification.",
      interruption: null,
    });
    yield* repository.save(run);
    return run;
  }
  if (action === "cancel") {
    const args = yield* validation(() => searchCommands.cancel.parse(input));
    const savedRuns = yield* runs(repository);
    const run = yield* validation(() => {
      const found = savedRuns.find((item) => item.id === args.run_id);
      if (!found) throw new Error("Choose an existing search run");
      return found;
    });
    if (!["cancelled", "completed"].includes(run.phase)) {
      Object.assign(
        run,
        stoppedSearchRun(run, now, "Search stopped. Saved results are preserved."),
      );
      yield* repository.save(run);
    }
    return run;
  }
  if (action === "claim" || action === "heartbeat") {
    const claim =
      action === "claim" ? yield* validation(() => searchCommands.claim.parse(input)) : undefined;
    const args = claim ?? (yield* validation(() => searchCommands.heartbeat.parse(input)));
    // Reconcile first: a dead worker cannot revive its lease.
    const savedRuns = yield* runs(repository);
    const run = yield* validation(() => {
      const found = savedRuns.find((item) => item.id === args.run_id);
      if (!found) throw new Error("Choose an existing search run");
      const search = searches.find((item) => item.id === found.search_id);
      assertWorkflow(
        searchBlockers(found, action === "claim" ? "claim" : "renew", {
          now,
          worker_id: args.worker_id,
          agent_id: claim?.agent_id,
          expected_version: claim?.expected_version,
          search_current: !!search && hash(search) === found.search_revision,
        }),
      );
      return found;
    });
    if (claim && !run.worker)
      run.worker = {
        id: claim.worker_id,
        agent_id: claim.agent_id,
        parent_thread_id: claim.parent_thread_id ?? null,
        claimed_at: iso(now),
        last_heartbeat_at: iso(now),
        lease_expires_at: iso(now + SEARCH_LEASE_MS),
        ...(claim.execution ? { execution: claim.execution } : {}),
      };
    run.started_at ??= iso(now);
    touchWorker(run, now);
    run.phase = claimedSearchPhase(run.phase);
    run.updated_at = iso(now);
    run.version++;
    yield* repository.save(run);
    return run;
  }
  const args = yield* validation(() => searchCommands.update.parse(input));
  yield* runs(repository);
  const entry = yield* repository.find(args.run_id);
  const run = yield* validation(() => {
    if (!entry) throw new Error("That search run no longer exists");
    const found = entry;
    return found;
  });
  const updated = {
    ...run,
    version: run.version + 1,
    phase: args.phase ?? run.phase,
    updated_at: iso(now),
    next_step: args.next_step ?? run.next_step,
    interruption: args.interruption === undefined ? run.interruption : args.interruption,
  };
  if (args.query) {
    yield* validation(() => {
      const original = run.queries.find((query) => query.id === args.query?.id);
      if (
        !original ||
        original.text !== args.query?.text ||
        original.marketplace !== args.query.marketplace ||
        original.purpose !== args.query.purpose
      )
        throw new Error("Update an existing planned query with its original identity");
    });
    updated.queries = run.queries.map((query) =>
      query.id === args.query?.id ? args.query : query,
    );
  }
  if (args.add_queries?.length) {
    yield* validation(() => {
      const ids = new Set(updated.queries.map((query) => query.id));
      const terms = new Set(
        updated.queries.map((query) => `${query.marketplace}:${query.text.trim().toLowerCase()}`),
      );
      const search = searches.find((item) => item.id === run.search_id);
      for (const query of args.add_queries ?? []) {
        const term = `${query.marketplace}:${query.text.trim().toLowerCase()}`;
        if (
          ids.has(query.id) ||
          terms.has(term) ||
          query.status !== "planned" ||
          !(search?.marketplaces ?? ["facebook_marketplace"]).includes(query.marketplace)
        )
          throw new Error("Add unique planned queries on the selected marketplaces");
        ids.add(query.id);
        terms.add(term);
      }
      if (updated.queries.length + (args.add_queries?.length ?? 0) > 120)
        throw new Error("This query plan is full");
    });
    updated.queries = [...updated.queries, ...args.add_queries];
  }
  yield* validation(() => {
    const search = searches.find((item) => item.id === run.search_id);
    assertWorkflow(
      searchBlockers(run, updateEvent(args.phase), {
        now,
        worker_id: args.worker_id,
        expected_version: args.expected_version,
        search_current: !!search && hash(search) === run.search_revision,
        candidate: updated,
      }),
    );
  });
  touchWorker(updated, now);
  yield* repository.save(updated);
  return updated;
});
const stopScheduledRun = Effect.fnUntraced(function* (
  repository: SearchRunStorage,
  run: SearchRun,
  reason: string,
  now: number,
  defer: boolean = true,
) {
  if (run.trigger === "scheduled" && ACTIVE_SEARCH_PHASES.has(run.phase)) {
    Object.assign(run, stoppedSearchRun(run, now, reason, defer));
    run.interruption = null;
    yield* repository.save(run);
  }
  return run;
});
const recordSearchImport = Effect.fnUntraced(function* (
  repository: SearchRunStorage,
  runId: string,
  rows: {
    key: string;
    collection_stage?: "discovery" | "verification" | undefined;
    image_review?: { complete: boolean } | null | undefined;
    videos?: unknown[] | undefined;
    video_review?: { total_videos: number; complete: boolean } | null | undefined;
    media_capture?: { expected_videos?: number | undefined } | undefined;
  }[],
  now: number,
  workerId?: unknown,
) {
  yield* runs(repository);
  const entry = yield* repository.find(runId);
  const run = yield* validation(() => {
    if (!entry) throw new Error("Choose an existing search run");
    const found = entry;
    assertWorkflow(searchBlockers(found, "import", { now, worker_id: workerId, candidate: found }));
    return found;
  });
  run.listing_keys = [...new Set([...run.listing_keys, ...rows.map((row) => row.key)])];
  run.verified_keys = [
    ...new Set([
      ...run.verified_keys,
      ...rows
        .filter(
          (row) =>
            row.collection_stage === "verification" &&
            row.image_review?.complete &&
            (!(
              (row.videos?.length ?? 0) > 0 ||
              (row.video_review?.total_videos ?? 0) > 0 ||
              (row.media_capture?.expected_videos ?? 0) > 0
            ) ||
              row.video_review?.complete),
        )
        .map((row) => row.key),
    ]),
  ];
  if (rows.length) run.started_at ??= iso(now);
  if (rows.length && run.first_result_at === null) run.first_result_at = iso(now);
  run.updated_at = iso(now);
  run.version++;
  touchWorker(run, now);
  yield* validation(() => searchRunSchema.parse(run));
  yield* repository.save(run);
  yield* repository.recordDiscoveries(
    run,
    rows.map((row) => row.key),
    now,
  );
});

type Arguments<F> = F extends (repository: SearchRunStorage, ...args: infer A) => unknown
  ? A
  : never;
type Bound<F> = F extends (repository: SearchRunStorage, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;

export class SearchRuns extends Context.Service<
  SearchRuns,
  {
    readonly runs: Bound<typeof runs>;
    readonly find: SearchRunStorage["find"];
    readonly latestScheduled: SearchRunStorage["latestScheduled"];
    readonly fulfilGoals: Bound<typeof fulfilGoals>;
    readonly searchAction: Bound<typeof searchAction>;
    readonly stopScheduledRun: Bound<typeof stopScheduledRun>;
    readonly recordSearchImport: Bound<typeof recordSearchImport>;
  }
>()("goodfinds/SearchRuns", {
  make: Effect.gen(function* () {
    const repository = yield* SearchRunRepository;
    return {
      runs: (...args: Arguments<typeof runs>) => runs(repository, ...args),
      find: repository.find,
      latestScheduled: (searchId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const run = yield* repository.latestScheduled(searchId);
          return run ? expiredSearchRun(run, now) : undefined;
        }),
      fulfilGoals: (...args: Arguments<typeof fulfilGoals>) => fulfilGoals(repository, ...args),
      searchAction: (...args: Arguments<typeof searchAction>) => searchAction(repository, ...args),
      stopScheduledRun: (...args: Arguments<typeof stopScheduledRun>) =>
        stopScheduledRun(repository, ...args),
      recordSearchImport: (...args: Arguments<typeof recordSearchImport>) =>
        recordSearchImport(repository, ...args),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
