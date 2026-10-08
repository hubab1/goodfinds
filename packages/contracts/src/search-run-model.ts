import type { SearchRun } from "./search-workflow.ts";
import { blocker, describeAction, workflow } from "./workflow-model.ts";
import type {
  Blocker,
  EventDefinition,
  GuardDefinition,
  StateDefinition,
} from "./workflow-model.ts";

export const SEARCH_LEASE_MS = 5 * 60_000;
export const searchPhases = [
  "requested",
  "discovering",
  "verifying",
  "partial",
  "completed",
  "blocked",
  "cancelled",
  "deferred",
] as const;
export type SearchPhase = (typeof searchPhases)[number];
export const searchStates = {
  requested: {
    meaning: "A durable query plan awaits execution.",
    invariant: "Saved results and query identities survive reconnects.",
    recovery: "Claim with the actual spawned agent_id, a new worker_id and current run version.",
  },
  discovering: {
    meaning: "Query discovery is in progress.",
    invariant: "A worker, when present, owns an unexpired lease.",
    recovery: "Import discoveries in batches and report query coverage.",
  },
  verifying: {
    meaning: "The broad category has been checked; shortlist evidence is being collected.",
    invariant: "At least one broad category query is completed.",
    recovery: "Record gallery reviews separately from saved media.",
  },
  partial: {
    meaning: "Execution stopped with saved results or incomplete coverage.",
    invariant: "Completion is not claimed; saved evidence remains available.",
    recovery: "Resume with a new real background agent after resolving the interruption.",
  },
  completed: {
    meaning: "Query coverage is accounted for.",
    invariant:
      "A category query is completed and no query is planned, running or failed. This does not prove listing verification or a purchase.",
    recovery: "Read saved listings and buying next steps, or request a new run.",
  },
  blocked: {
    meaning: "Execution cannot proceed.",
    invariant: "An interruption explains the blocker.",
    recovery: "Resolve the interruption, then resume with a new worker.",
  },
  cancelled: {
    meaning: "The run was stopped deliberately or its buying goal was fulfilled.",
    invariant: "Results remain saved; this run accepts no further progress or imports.",
    recovery: "Request a new run for an unfulfilled buying goal.",
  },
  deferred: {
    meaning: "Scheduled execution waits for eligibility or active hours.",
    invariant: "Monitoring preference and observed host schedule remain separate from run phase.",
    recovery: "Recheck scheduled-search eligibility before resuming.",
  },
} as const satisfies Record<SearchPhase, StateDefinition>;
export const activeSearchPhases = new Set<SearchPhase>(["requested", "discovering", "verifying"]);
export const resumableSearchPhases = new Set<SearchPhase>([
  ...activeSearchPhases,
  "partial",
  "blocked",
  "deferred",
]);
const mutable = [...resumableSearchPhases];
const active = [...activeSearchPhases];
export const searchGuards = {
  run_stopped: {
    message: "This search is stopped. Start or resume a run first.",
    recovery: "Read the run and resume with a new worker before worker activity.",
  },
  run_finished: {
    message: "This run has finished and stopped. Start a new run.",
    recovery: "Read saved results or request a new run.",
  },
  revision_conflict: {
    message: "Search progress changed. Read the run before updating or claiming it.",
    recovery: "Use the returned run version for progress updates and new claims.",
  },
  search_changed: {
    message: "The buying brief changed. Start a new search run.",
    recovery: "Read the saved search and request a run for its current brief.",
  },
  search_missing: { message: "Choose a saved search.", recovery: "Read the saved searches." },
  goal_fulfilled: {
    message: "This buying goal is fulfilled.",
    recovery: "Reopen the purchased conversation before searching again.",
  },
  scheduled_ineligible: {
    message: "Scheduled execution is not currently eligible.",
    recovery: "Read check_goodfinds_scheduled_search before scheduled execution.",
  },
  worker_required: {
    message: "Claim this search before reporting activity.",
    recovery: "Claim with the actual spawned agent identity and current version.",
  },
  worker_mismatch: {
    message:
      "This background search is owned by another agent or has stopped. Read the run before continuing.",
    recovery: "Use the current worker_id, unexpired lease and unchanged search brief.",
  },
  lease_expired: {
    message: "The background search lease expired.",
    recovery: "Read the run, resolve the interruption and resume with a new worker.",
  },
  execution_input: {
    message: "Supply the proposed progress or observation evidence.",
    recovery: "Use original query identities and a stable request_id for each import batch.",
  },
  request_input: {
    message: "Supply a search request and fresh request_id.",
    recovery:
      "Use the saved search_id, a fresh request_id and the intended manual or scheduled trigger.",
  },
  claim_input: {
    message: "Supply the real spawned agent_id and worker_id.",
    recovery: "The parent cannot claim for the worker; pass the spawned agent's identity.",
  },
  category_query_unchecked: {
    message: "Check a broad category query before shortlist verification.",
    recovery: "Complete a broad category query; query and phase may be updated together.",
  },
  query_coverage_incomplete: {
    message:
      "Complete a broad category query and account for remaining queries, or mark this run partial.",
    recovery:
      "Complete queries or skip them with reasons. Failed queries require recovery or a partial run.",
  },
  interruption_required: {
    message: "Explain the search interruption.",
    recovery: "Provide an interruption when marking a run blocked.",
  },
  transition_invalid: {
    message: "This event does not allow that search phase.",
    recovery: "Read the run's action descriptors and choose an applicable event.",
  },
} as const satisfies Record<string, GuardDefinition>;
const progressGuards = [
  "scheduled_ineligible",
  "revision_conflict",
  "search_changed",
  "run_finished",
  "worker_required",
  "worker_mismatch",
  "lease_expired",
  "run_stopped",
  "execution_input",
];
export const searchEvents = {
  request: {
    execution_profile: "collection",
    operation: "request_search_run",
    from: ["absent", "completed", "cancelled"],
    to: ["requested"],
    inputs: ["request.search_id", "request.request_id"],
    guards: ["search_missing", "goal_fulfilled", "scheduled_ineligible", "request_input"],
    meaning: "Create a query plan; repeated requests return the saved run.",
  },
  resume: {
    execution_profile: "collection",
    diagram: [
      { from: "partial", to: "requested" },
      { from: "blocked", to: "requested" },
      { from: "deferred", to: "requested" },
    ],
    operation: "request_search_run",
    from: ["partial", "blocked", "deferred"],
    to: ["requested"],
    inputs: ["request.search_id", "request.request_id", "request.resume"],
    guards: ["search_changed", "goal_fulfilled", "scheduled_ineligible", "request_input"],
    meaning: "Preserve queries/results and clear the previous worker and interruption.",
  },
  claim: {
    execution_profile: "collection",
    diagram: [
      { from: "requested", to: "discovering" },
      { from: "discovering", to: "discovering" },
      { from: "verifying", to: "verifying" },
    ],
    operation: "claim_search_run",
    from: active,
    to: ["discovering", "verifying"],
    inputs: ["request.run_id", "request.expected_version", "request.worker_id", "request.agent_id"],
    guards: [
      "run_stopped",
      "search_changed",
      "worker_mismatch",
      "lease_expired",
      "revision_conflict",
      "claim_input",
      "scheduled_ineligible",
    ],
    meaning: "Claim or renew an active run; requested becomes discovering.",
  },
  renew: {
    execution_profile: "collection",
    operation: "renew_search_lease",
    from: active,
    to: ["discovering", "verifying"],
    inputs: ["request.run_id", "request.worker_id"],
    guards: [
      "run_stopped",
      "search_changed",
      "worker_required",
      "worker_mismatch",
      "lease_expired",
      "scheduled_ineligible",
    ],
    meaning: "Renew the current worker lease.",
  },
  progress: {
    execution_profile: "collection",
    operation: "update_search_run",
    from: mutable,
    to: mutable,
    inputs: [
      "request.run_id",
      "request.expected_version",
      "request.worker_id (when claimed)",
      "request.query or request.phase",
    ],
    guards: [...progressGuards, "category_query_unchecked", "interruption_required"],
    meaning:
      "Update the candidate query plan and phase atomically. Existing workerless execution remains supported.",
  },
  verify: {
    execution_profile: "collection",
    diagram: [{ from: "discovering", to: "verifying", label: "category checked" }],
    operation: "update_search_run",
    from: mutable,
    to: ["verifying"],
    inputs: [
      "request.run_id",
      "request.expected_version",
      "request.phase=verifying",
      "request.worker_id (when claimed)",
    ],
    guards: [...progressGuards, "category_query_unchecked"],
    meaning: "Begin shortlist verification after category coverage.",
  },
  complete: {
    execution_profile: "collection",
    diagram: [
      { from: "verifying", to: "completed", label: "coverage accounted for" },
      { from: "requested", to: "completed", label: "workerless coverage accounted for" },
    ],
    operation: "update_search_run",
    from: mutable,
    to: ["completed"],
    inputs: [
      "request.run_id",
      "request.expected_version",
      "request.phase=completed",
      "request.worker_id (when claimed)",
    ],
    guards: [...progressGuards, "category_query_unchecked", "query_coverage_incomplete"],
    meaning: "Complete coverage, independently of listing evidence and buying outcome.",
  },
  interrupt: {
    execution_profile: "collection",
    diagram: [
      { from: "discovering", to: "partial" },
      { from: "discovering", to: "blocked", label: "interruption required" },
    ],
    operation: "update_search_run",
    from: mutable,
    to: ["partial", "blocked", "deferred"],
    inputs: [
      "request.run_id",
      "request.expected_version",
      "request.phase",
      "request.interruption (for blocked)",
      "request.worker_id (when claimed)",
    ],
    guards: [...progressGuards, "interruption_required"],
    meaning: "Save partial progress or explain an interruption.",
  },
  import: {
    execution_profile: "collection",
    operation: "import_listing_observations",
    from: mutable,
    to: mutable,
    inputs: ["run_id", "observations", "request_id", "worker_id (when claimed)"],
    guards: [
      "run_finished",
      "scheduled_ineligible",
      "worker_required",
      "worker_mismatch",
      "lease_expired",
      "run_stopped",
      "execution_input",
    ],
    meaning:
      "Save observations and run keys in the same transaction; failed guards roll back the batch.",
  },
  cancel: {
    diagram: [
      { from: "requested", to: "cancelled" },
      { from: "discovering", to: "cancelled" },
      { from: "verifying", to: "cancelled" },
    ],
    operation: "cancel_search_run",
    from: mutable,
    to: ["cancelled"],
    inputs: ["request.run_id"],
    guards: ["revision_conflict", "search_changed"],
    meaning: "Stop execution without discarding results. Repeated cancellation is harmless.",
  },
  expire: {
    diagram: [
      { from: "discovering", to: "partial", label: "saved results" },
      { from: "discovering", to: "blocked", label: "no results" },
    ],
    operation: null,
    from: active,
    to: ["partial", "blocked"],
    inputs: [],
    guards: ["lease_expired"],
    meaning:
      "Expired execution becomes partial with results, otherwise blocked. Reads project this without writing.",
  },
  defer: {
    diagram: [{ from: "discovering", to: "deferred", label: "scheduled" }],
    operation: null,
    from: active,
    to: ["deferred", "cancelled"],
    inputs: [],
    guards: ["scheduled_ineligible"],
    meaning: "Stop scheduled execution when eligibility changes.",
  },
  fulfil: {
    operation: null,
    from: mutable,
    to: ["cancelled"],
    inputs: [],
    guards: ["goal_fulfilled"],
    meaning: "A recorded purchase fences linked buying goals and their runs.",
  },
  inspect: {
    operation: "list_search_runs",
    from: ["absent", ...searchPhases],
    to: [],
    inputs: [],
    guards: [],
    meaning: "Read progress and available actions without advancing a run.",
  },
} as const satisfies Record<string, EventDefinition>;
export type SearchEvent = keyof typeof searchEvents;
export type SearchContext = {
  now: number;
  worker_id?: unknown;
  agent_id?: string | undefined;
  expected_version?: number | undefined;
  search_current?: boolean | undefined;
  search_exists?: boolean | undefined;
  fulfilled?: boolean | undefined;
  scheduled_allowed?: boolean | undefined;
  request_supplied?: boolean | undefined;
  candidate?: SearchRun | undefined;
};
function ownership(run: SearchRun, context: SearchContext, requireWorker = false): Blocker[] {
  if (!run.worker) {
    return requireWorker || context.worker_id !== undefined
      ? [blocker(searchGuards, "worker_required")]
      : [];
  }
  if (Date.parse(run.worker.lease_expires_at) <= context.now)
    return [blocker(searchGuards, "lease_expired")];
  if (context.worker_id === undefined) return [blocker(searchGuards, "worker_mismatch", "input")];
  if (context.worker_id !== run.worker.id) return [blocker(searchGuards, "worker_mismatch")];
  return [];
}
/** Guards evaluate proposed data, never an implicit clock or a partially-mutated stored run. */
export function searchBlockers(
  run: SearchRun | null,
  event: SearchEvent,
  context: SearchContext,
): Blocker[] {
  const result: Blocker[] = [];
  const add = (code: keyof typeof searchGuards, kind: Blocker["kind"] = "blocked") =>
    result.push(blocker(searchGuards, code, kind));
  if (event === "inspect") return result;
  if (event === "request" || event === "resume") {
    if (!context.request_supplied) add("request_input", "input");
    if (context.search_exists === false) add("search_missing");
    else if (context.search_exists === undefined) add("search_missing", "input");
    if (context.fulfilled === true) add("goal_fulfilled");
    else if (context.fulfilled === undefined) add("goal_fulfilled", "input");
    if (context.scheduled_allowed === false) add("scheduled_ineligible");
    if (event === "resume" && context.search_current === false) add("search_changed");
    return result;
  }
  if (!run) {
    add("run_finished");
    return result;
  }
  const definition = searchEvents[event];
  if (!(definition.from as readonly string[]).includes(run.phase)) {
    add(
      activeSearchPhases.has(run.phase)
        ? "transition_invalid"
        : ["completed", "cancelled"].includes(run.phase)
          ? "run_finished"
          : "run_stopped",
    );
  }
  if (event === "cancel") {
    // Dedicated cancellation needs only the run ID; an update that cancels still uses version/brief fencing.
    if (context.candidate) {
      if (context.expected_version !== run.version) add("revision_conflict");
      if (context.search_current === false) add("search_changed");
    }
    return result;
  }
  if (event === "fulfil" || event === "defer" || event === "expire") return result;
  if (run.trigger === "scheduled" && context.scheduled_allowed === false)
    add("scheduled_ineligible");
  if (event !== "import") {
    if (context.search_current === false) add("search_changed");
    else if (context.search_current === undefined) add("search_changed", "input");
  }
  if (!["renew", "import"].includes(event) && !(event === "claim" && run.worker)) {
    if (context.expected_version === undefined) add("revision_conflict", "input");
    else if (run.version !== context.expected_version) add("revision_conflict");
  }
  if (event === "claim" && (!context.agent_id || context.worker_id === undefined))
    add("claim_input", "input");
  const cancelling = context.candidate?.phase === "cancelled";
  if (!cancelling) {
    if (event !== "claim" || run.worker) result.push(...ownership(run, context, event === "renew"));
    if (run.worker && !activeSearchPhases.has(run.phase)) add("run_stopped");
  }
  if (["progress", "verify", "complete", "interrupt"].includes(event)) {
    const candidate = context.candidate;
    if (!candidate) add("execution_input", "input");
    else {
      if (!(definition.to as readonly string[]).includes(candidate.phase))
        add("transition_invalid");
      const category = candidate.queries.some(
        (q) => q.purpose === "category" && q.status === "completed",
      );
      if (["verifying", "completed"].includes(candidate.phase) && !category)
        add("category_query_unchecked");
      if (
        candidate.phase === "completed" &&
        candidate.queries.some((q) => ["planned", "running", "failed"].includes(q.status))
      )
        add("query_coverage_incomplete");
      if (candidate.phase === "blocked" && !candidate.interruption) add("interruption_required");
    }
  }
  if (event === "import" && !context.candidate) add("execution_input", "input");
  return result;
}
export function updateEvent(phase?: SearchPhase): SearchEvent {
  if (phase === "cancelled") return "cancel";
  if (phase === "completed") return "complete";
  if (phase === "verifying") return "verify";
  if (phase && ["partial", "blocked", "deferred"].includes(phase)) return "interrupt";
  return "progress";
}
export function expiredSearchRun(run: SearchRun, now: number): SearchRun {
  const expires =
    run.worker?.lease_expires_at ??
    new Date(Date.parse(run.updated_at) + SEARCH_LEASE_MS).toISOString();
  if (!activeSearchPhases.has(run.phase) || Date.parse(expires) > now) return run;
  return {
    ...run,
    phase: run.listing_keys.length ? searchEvents.expire.to[0] : searchEvents.expire.to[1],
    version: run.version + 1,
    updated_at: new Date(now).toISOString(),
    interruption: run.worker
      ? "The background agent stopped reporting progress. Saved results are preserved."
      : "The search did not start or stopped reporting progress. Saved results are preserved.",
    next_step: "Resume this search with a new background agent.",
  };
}
export function searchWorkflow(run: SearchRun | null, context: SearchContext) {
  const projected = run ? expiredSearchRun(run, context.now) : null;
  const state = projected?.phase ?? "absent";
  const actions = Object.entries(searchEvents).flatMap(([event, definition]) => {
    if (!definition.operation || !(definition.from as readonly string[]).includes(state)) return [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Entries come from the statically typed event registry.
    const name = event as SearchEvent;
    return [
      describeAction(name, definition, searchGuards, searchBlockers(projected, name, context)),
    ];
  });
  return workflow(state, actions);
}

export function resumedSearchRun(
  run: SearchRun,
  now: number,
  trigger: SearchRun["trigger"],
): SearchRun {
  return {
    ...run,
    phase: searchEvents.resume.to[0],
    version: run.version + 1,
    updated_at: new Date(now).toISOString(),
    interruption: null,
    worker: null,
    trigger,
    scheduled_at: trigger === "scheduled" ? new Date(now).toISOString() : run.scheduled_at,
  };
}
export function stoppedSearchRun(
  run: SearchRun,
  now: number,
  reason: string,
  defer = false,
): SearchRun {
  if (!resumableSearchPhases.has(run.phase)) return run;
  return {
    ...run,
    phase: defer ? searchEvents.defer.to[0] : searchEvents.cancel.to[0],
    version: run.version + 1,
    updated_at: new Date(now).toISOString(),
    next_step: reason,
    interruption: defer ? null : run.interruption,
  };
}
export function claimedSearchPhase(phase: SearchPhase): SearchPhase {
  return searchEvents.claim.diagram.find((edge) => edge.from === phase)?.to ?? phase;
}
