import { searchReadingSummary } from "./listing-reading.ts";
import { WorkspaceRepository } from "./repository.ts";
import { ListingRepository } from "../listings/repository.ts";
import type { DeviceBrowser } from "@goodfinds/contracts/integrations";
import { buyingNextSteps, fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import { DAY, hash, iso, time } from "./model.ts";
import type { WorkspaceConfiguration } from "./model.ts";
import { Clock, Effect } from "effect";
import * as engine from "../listings/evaluation.ts";
import * as tracking from "../listings/tracking.ts";
import { SellerConversations } from "../sellers/conversations.ts";
import { SearchRuns } from "../searches/runs.ts";
import { monitoringSummary, scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { HostSchedules } from "../searches/host-schedules.ts";
import {
  scheduleObservationRecords,
  dispatcherSummaries,
  sharedMonitoring,
} from "@goodfinds/contracts/scheduled-dispatch";
import type { WorkspaceContext } from "./context.ts";
import { ACCESS_CONTEXT } from "./context.ts";
import { workflowViews } from "../searches/workflow-views.ts";
export const workspaceSnapshot = Effect.fn("WorkspaceStore.snapshot")(function* (
  context: WorkspaceContext,
  suppliedConfig?: WorkspaceConfiguration,
  suppliedNow?: number,
) {
  const hostSchedulesReader = yield* HostSchedules;
  const workspace = yield* WorkspaceRepository;
  const listingStore = yield* ListingRepository;
  const seller_conversation = yield* SellerConversations;
  const searchWorkflow = yield* SearchRuns;
  const config = suppliedConfig ?? (yield* workspace.configuration);
  const now = suppliedNow ?? (yield* Clock.currentTimeMillis);
  const rows = (yield* listingStore.load(
    context.mode === "sample" ? "synthetic" : "manual",
  )).toSorted(
    (a, b) => time(b.last_observed_at) - time(a.last_observed_at) || b.key.localeCompare(a.key),
  );
  const discovery = yield* listingStore.discovery(
    context.mode === "sample" ? "synthetic" : "manual",
  );
  const reading = yield* listingStore.reading();
  for (const row of rows) {
    row.first_found_runs = discovery.byListing.get(row.key) ?? [];
    row.seen_in_searches = reading.get(row.key) ?? [];
  }
  const current = rows.filter(
    (row) =>
      time(row.last_observed_at) >= now - config.baseline_days * DAY &&
      time(row.last_observed_at) <= now,
  );
  const decisions: (engine.Evaluation & { search_id: string; search_name: string })[] = [];
  const searchRuns = yield* searchWorkflow.runs(undefined, false);
  const seller_conversations = yield* seller_conversation.summaries(now);
  const fulfilled = fulfilledSearches(seller_conversations);
  yield* listingStore.historyBatch(rows);
  const searches = yield* Effect.forEach(config.searches, (search) =>
    Effect.gen(function* () {
      const evaluate =
        !fulfilled.has(search.id) &&
        (search.enabled ||
          searchRuns.some(
            (run) =>
              run.search_id === search.id &&
              run.search_revision === hash(search) &&
              run.phase !== "cancelled",
          ));
      const pool = evaluate
        ? engine.comparisonPool(current, search, config, now, context.mode === "sample")
        : [];
      const matched = evaluate
        ? current
            .filter((row) => row.product === search.product)
            .map((row) =>
              Object.assign(
                engine.evaluateListing(row, pool, search, config, now, context.mode === "sample"),
                { search_id: search.id, search_name: search.name },
              ),
            )
        : [];
      decisions.push(...matched);
      return {
        ...search,
        ...searchReadingSummary(
          rows,
          search,
          config,
          discovery.lastSearched.get(search.id) ?? null,
        ),
        qualified_count: matched.filter((decision) => decision.status === "qualifies").length,
        tracked_count: rows.filter((row) => row.product === search.product).length,
        found_count: discovery.counts.get(search.id) ?? null,
        market_history: yield* listingStore.insights(
          rows,
          search,
          config,
          now,
          engine.historyCohort,
          pool,
        ),
      };
    }),
  );
  for (const row of rows) {
    row.quality = tracking.quality(row, config, now);
  }
  const activity = (yield* listingStore.evaluations()).map((evaluation) => {
    const { observations, search_coverage: runs, ...entry } = evaluation;
    const failed =
      (runs.length > 0 && runs.every((run) => run.status === "failed")) ||
      (observations.length > 0 &&
        observations.every((row) => (row.check_outcome ?? "success") !== "success"));
    const partial =
      runs.some((run) => run.status !== "success" || !run.pagination_complete) ||
      observations.some((row) => (row.check_outcome ?? "success") !== "success");
    return Object.assign(entry, {
      collection_method:
        observations.length &&
        observations.every((row) => row.collection_method === "user_requested_browser")
          ? "user_requested_browser"
          : "supplied",
      search_coverage: runs,
      status: failed ? "failed" : partial ? "partial" : "recorded",
    });
  });
  const qualifying = new Set(
    decisions
      .filter(
        (d) =>
          d.status === "qualifies" &&
          config.searches.some((search) => search.id === d.search_id && search.enabled),
      )
      .map((d) => `${d.search_id}:${d.listing.key}:${d.listing.price_minor}`),
  );
  const pending = (yield* listingStore.pendingAlerts()).filter((item) =>
    qualifying.has(`${item.search_id}:${item.listing_key}:${item.price_minor}`),
  ).length;
  const hostSchedules = hostSchedulesReader.observe(
    scheduleObservationRecords(config.monitoring, config.dispatchers),
    now,
  );
  const dispatchers =
    context.mode === "sample"
      ? []
      : dispatcherSummaries(config, fulfilled, now, hostSchedules, () => hash(config));
  const monitoring = searches.map((search) =>
    monitoringSummary(
      search,
      config.monitoring,
      config.schedule.interval_minutes,
      fulfilled.has(search.id),
      context.mode === "sample",
      hostSchedules.get(search.id) ?? null,
      config.schedule.quiet_hours,
      now,
      sharedMonitoring(dispatchers, search.id),
    ),
  );
  const activeSchedules = monitoring.filter(scheduleIsActive);
  const nextRuns = activeSchedules
    .flatMap((item) => (item.schedule?.next_run_at ? [item.schedule.next_run_at] : []))
    .toSorted((a, b) => time(a) - time(b));
  const snapshot = {
    device_browser: null as DeviceBrowser | null,
    monitoring,
    dispatchers,
    search_runs: searchRuns,
    ...workflowViews(config, searchRuns, fulfilled, now),
    seller_workflow: null,
    seller_conversations,
    seller_conversation: null,
    api_connections: {
      ebay_credentials_configured: workspace.ebayCredentialsConfigured,
    },
    access_context: ACCESS_CONTEXT,
    revision: hash(config),
    revisions: yield* workspace.revisions,
    mode: context.mode,
    config,
    searches,
    drafts: config.drafts,
    deals: decisions
      .filter((d) => d.status === "qualifies")
      .toSorted(
        (a, b) =>
          (b.preference_score ?? 0) - (a.preference_score ?? 0) ||
          (b.percent_below_average ?? 0) - (a.percent_below_average ?? 0),
      ),
    decisions,
    listings: rows,
    activity,
    counts: {
      listings: rows.length,
      deals: decisions.filter((d) => d.status === "qualifies").length,
      active_searches: searches.filter((search) => search.enabled && !fulfilled.has(search.id))
        .length,
      pending_alerts: pending,
    },
    monitor: {
      collector_available: false,
      scheduler_available: activeSchedules.length > 0,
      notification_delivery_available: false,
      next_run_at: nextRuns[0] ?? null,
      last_run_at: activity[0]?.evaluated_at ?? null,
      message: activeSchedules.length
        ? `${activeSchedules.length} saved searches have verified host schedules. The device must be awake with the host app running.`
        : "Searches are saved. Recurring monitoring needs a verified host schedule.",
    },
    generated_at: iso(now),
  };
  return { ...snapshot, next_steps: buyingNextSteps(snapshot) };
});
