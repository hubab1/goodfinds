import { Clock, Effect } from "effect";
import {
  scheduledBatchSchema,
  dispatcherMatches,
  dispatcherPlan,
  dispatcherSummaries,
} from "@goodfinds/contracts/scheduled-dispatch";
import type { HostScheduleObservation } from "@goodfinds/contracts/monitoring";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { localSlot } from "@goodfinds/contracts/search-timing";
import { fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import { SearchRuns } from "../searches/runs.ts";
import { SellerConversations } from "../sellers/conversations.ts";
import { scheduledSearchCheck } from "../searches/scheduled-search.ts";
import { hash, iso } from "./model.ts";
import type { WorkspaceConfiguration } from "./model.ts";
import { validation } from "./errors.ts";

function occurrenceId(searchId: string, slot: string) {
  const digits = hash({ searchId, slot });
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-5${digits.slice(13, 16)}-a${digits.slice(17, 20)}-${digits.slice(20, 32)}`;
}
export const requestScheduledBatch = Effect.fnUntraced(function* (
  config: WorkspaceConfiguration,
  input: unknown,
  observations: Map<string, HostScheduleObservation>,
) {
  const request = yield* validation(() => scheduledBatchSchema.parse(input));
  const now = yield* Clock.currentTimeMillis;
  const searchRuns = yield* SearchRuns,
    sellers = yield* SellerConversations;
  const fulfilled = fulfilledSearches(yield* sellers.summaries(now));
  const dispatcher = yield* validation(() => {
    const d = config.dispatchers.find(
      (item) => item.id === request.dispatcher_id && item.thread_id === request.thread_id,
    );
    if (!d) throw new Error("Choose the shared schedule in its original buying chat");
    return d;
  });
  const summary = dispatcherSummaries(config, fulfilled, now, observations, () =>
    hash(config),
  ).find((s) => s.dispatcher.id === dispatcher.id);
  const result: {
    dispatcher_id: string;
    checked_at: string;
    reason: string;
    runs: {
      search_id: string;
      run_id: string;
      version: number;
      phase: string;
      worker_id: string | null;
      agent_id: string | null;
    }[];
    skipped: { search_id: string; reason: string }[];
  } = {
    dispatcher_id: dispatcher.id,
    checked_at: iso(now),
    reason: "ready",
    runs: [],
    skipped: [],
  };
  if (!summary || !dispatcherMatches(summary)) {
    result.reason = summary?.host_schedule?.status ?? dispatcher.schedule?.status ?? "unverified";
    if (result.reason === "active") result.reason = "schedule_update_needed";
    return result;
  }
  for (const searchId of dispatcher.search_ids) {
    const recent = yield* searchRuns.runs(searchId);
    const latest = yield* searchRuns.latestScheduled(searchId);
    const history = latest ? [...recent.filter((run) => run.id !== latest.id), latest] : recent;
    const check = scheduledSearchCheck(config, searchId, now, fulfilled, history);
    if (!check.allowed) {
      result.skipped.push({ search_id: searchId, reason: check.reason });
      continue;
    }
    const active = recent.find((run) => ACTIVE_SEARCH_PHASES.has(run.phase));
    const plan = dispatcherPlan(config, [searchId], fulfilled, now, hash(config));
    const slot = plan.times.length
      ? localSlot({ mode: "daily", times: plan.times }, plan.timezone, now)
      : `${latest?.id ?? "first"}:${request.request_id}`;
    const run =
      active ??
      (yield* searchRuns.searchAction(
        "start",
        {
          search_id: searchId,
          request_id: occurrenceId(searchId, slot ?? iso(now)),
          trigger: "scheduled",
          resume: true,
        },
        config.searches,
        now,
        fulfilled,
        config.feedback,
      ));
    result.runs.push({
      search_id: searchId,
      run_id: run.id,
      version: run.version,
      phase: run.phase,
      worker_id: run.worker?.id ?? null,
      agent_id: run.worker?.agent_id ?? null,
    });
  }
  if (!result.runs.length) result.reason = "nothing_due";
  return result;
});
