import { WorkspaceRepository } from "./repository.ts";
import { ListingRepository } from "../listings/repository.ts";
import { journeyQueue, journeyOriginKey } from "@goodfinds/contracts/journeys";
import { listingWorkflow } from "@goodfinds/contracts/listing-model";
import { listingSchema } from "@goodfinds/contracts/state";
import { excludedModels } from "@goodfinds/contracts/discovery";
import { z } from "zod";
import { fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import {
  listingQuerySchema,
  querySellerFilters,
  selectListings,
  sellerFilterError,
} from "@goodfinds/contracts/listing-query";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";
import { searchCoverFollowUp } from "@goodfinds/contracts/search-cover";
import { hash } from "./model.ts";
import { Clock, Effect } from "effect";
import { validation } from "./errors.ts";
import * as tracking from "../listings/tracking.ts";
import { SellerConversations } from "../sellers/conversations.ts";
import { SearchRuns } from "../searches/runs.ts";
import { searchProgress, queryPlan } from "@goodfinds/contracts/search-workflow";
import { appliesToSearch } from "@goodfinds/contracts/discovery";
import { monitoringSummary } from "@goodfinds/contracts/monitoring";
import { HostSchedules } from "../searches/host-schedules.ts";
import { scheduledSearchCheck } from "../searches/scheduled-search.ts";
import { repairQueue } from "../listings/media.ts";
import type { WorkspaceContext } from "./context.ts";
import { ACCESS_CONTEXT } from "./context.ts";
import { workspaceSnapshot } from "./snapshot.ts";
import { searchReadingSummary } from "./listing-reading.ts";
import { workflowViews } from "../searches/workflow-views.ts";
import {
  dispatcherContextInputSchema,
  dispatcherPlan,
  scheduleObservationRecords,
  dispatcherSummaries,
  sharedMonitoring,
  dispatcherForSearch,
} from "@goodfinds/contracts/scheduled-dispatch";
export const workspaceQuery = Effect.fn("WorkspaceStore.queryIn")(function* (
  context: WorkspaceContext,
  action: string,
  args: Partial<ListingQuery> & {
    listing_key?: string | undefined;
    progress_only?: boolean | undefined;
    thread_id?: string | undefined;
    dispatcher_id?: string | undefined;
    search_ids?: string[] | undefined;
  },
) {
  const hostSchedulesReader = yield* HostSchedules;
  const workspace = yield* WorkspaceRepository;
  const listingStore = yield* ListingRepository;
  const seller_conversation = yield* SellerConversations;
  const searchWorkflow = yield* SearchRuns;
  const config = yield* workspace.configuration;
  if (action === "get_dispatcher_context") {
    const input = yield* validation(() =>
      dispatcherContextInputSchema.parse({
        thread_id: args.thread_id,
        search_ids: args.search_ids,
        dispatcher_id: args.dispatcher_id,
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    const fulfilled = fulfilledSearches(yield* seller_conversation.summaries(now));
    const hosts = hostSchedulesReader.observe(
      scheduleObservationRecords(config.monitoring, config.dispatchers),
      now,
    );
    const dispatchers = dispatcherSummaries(config, fulfilled, now, hosts, () =>
      hash(config),
    ).filter((d) => d.dispatcher.thread_id === input.thread_id);
    const dispatcher =
      dispatchers.find((d) => d.dispatcher.id === input.dispatcher_id)?.dispatcher ?? null;
    if (input.dispatcher_id && !dispatcher)
      return yield* validation(() => {
        throw new Error("Choose a dispatcher in this buying chat");
      });
    const ids =
      input.search_ids ??
      dispatcher?.search_ids ??
      dispatchers.flatMap((d) => d.dispatcher.search_ids);
    yield* validation(() => {
      for (const id of ids) {
        const m = config.monitoring.find((item) => item.search_id === id);
        const owning = config.dispatchers.find((d) => d.search_ids.includes(id));
        if (
          !config.searches.some((s) => s.id === id) ||
          (m?.schedule && m.schedule.thread_id !== input.thread_id) ||
          (owning && owning.thread_id !== input.thread_id)
        )
          throw new Error("Choose saved searches from this buying chat");
      }
    });
    return {
      revision: hash(config),
      revisions: yield* workspace.revisions,
      mode: context.mode,
      plan: dispatcherPlan(config, ids, fulfilled, now, hash(config)),
      dispatcher,
      dispatchers,
      legacy_schedules: config.monitoring
        .filter((m) => ids.includes(m.search_id) && m.schedule)
        .map((m) => ({ search_id: m.search_id, schedule: m.schedule })),
    };
  }
  if (action === "get_settings")
    return {
      revision: hash(config),
      revisions: yield* workspace.revisions,
      access_context: ACCESS_CONTEXT,
      origin_confirmed: config.origin_confirmed ?? false,
      settings: {
        origin: config.origin,
        location: config.location,
        platforms: config.platforms,
        browser_preference: config.browser_preference,
        journey_checks_enabled: config.journey_checks_enabled,
        interval_minutes: config.schedule.interval_minutes,
        quiet_hours: config.schedule.quiet_hours,
        baseline_days: config.baseline_days,
        minimum_peer_listings: config.minimum_peer_listings,
      },
      browser_access: config.browser_access,
      platform_sessions: config.platform_sessions,
    };
  const searches = config.searches.filter(
    (search) => args.search_id === undefined || search.id === args.search_id,
  );
  if (args.search_id && !searches.length)
    return yield* validation(() => {
      throw new Error("Choose a saved search");
    });
  if (action === "list_journey_checks") {
    const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const checks = journeyQueue(
      rows,
      searches,
      config.feedback,
      config,
      yield* Clock.currentTimeMillis,
    );
    const end = (args.offset ?? 0) + (args.limit ?? 20);
    return {
      origin_key: journeyOriginKey(config),
      enabled: config.journey_checks_enabled,
      origin_confirmed: config.origin_confirmed ?? false,
      checks: checks.slice(args.offset ?? 0, end),
      total: checks.length,
      next_offset: end < checks.length ? end : null,
    };
  }
  if (action === "list_activity") {
    const state = yield* workspaceSnapshot(context, config);
    const offset = args.offset ?? 0;
    const end = offset + (args.limit ?? 20);
    return {
      activity: state.activity.slice(offset, end),
      total: state.activity.length,
      next_offset: end < state.activity.length ? end : null,
      monitor: state.monitor,
      monitoring: state.monitoring,
    };
  }
  const searchRuns = yield* searchWorkflow.runs(args.search_id, false);
  if (action === "check_scheduled_search") {
    const searchId = z.string().parse(args.search_id);
    const now = yield* Clock.currentTimeMillis;
    const latest = yield* searchWorkflow.latestScheduled(searchId);
    const hosts = hostSchedulesReader.observe(
      scheduleObservationRecords(config.monitoring, config.dispatchers),
      now,
    );
    const dispatcher = dispatcherForSearch(config, searchId);
    return scheduledSearchCheck(
      config,
      searchId,
      now,
      fulfilledSearches(yield* seller_conversation.summaries(now)),
      latest ? [...searchRuns, latest] : searchRuns,
      true,
      hosts.get(dispatcher ? `dispatcher:${dispatcher.id}` : searchId) ?? null,
    );
  }
  if (action === "list_media_repairs") {
    const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const queue = repairQueue(
      rows.filter(
        (row) => !args.search_id || searches.some((search) => search.product === row.product),
      ),
      yield* Clock.currentTimeMillis,
    );
    const end = (args.offset ?? 0) + (args.limit ?? 20);
    return {
      listings: queue.slice(args.offset ?? 0, end),
      total: queue.length,
      ready: queue.filter((row) => row.ready).length,
      next_offset: end < queue.length ? end : null,
    };
  }
  if (action === "list_next_steps") {
    const state = yield* workspaceSnapshot(context, config);
    const actions = state.next_steps.filter(
      (item) => !args.search_id || item.search_id === args.search_id,
    );
    const end = (args.offset ?? 0) + (args.limit ?? 20);
    return {
      actions: actions.slice(args.offset ?? 0, end),
      total: actions.length,
      next_offset: end < actions.length ? end : null,
      fulfilled_searches: [...fulfilledSearches(state.seller_conversations)],
      hint: "Messages are drafts for review. Read get_goodfinds_seller_conversation before reviewing an exact message; use save_goodfinds_collection_plan and prepare_goodfinds_collection_message after agreement. A recommendation with unresolved checks is conditional.",
      monitoring: state.monitoring.filter(
        (item) => !args.search_id || item.search_id === args.search_id,
      ),
    };
  }
  if (action === "get_search_context" || action === "get_monitoring") {
    const now = yield* Clock.currentTimeMillis;
    const fulfilled = fulfilledSearches(yield* seller_conversation.summaries(now));
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
    if (action === "get_monitoring")
      return {
        revision: hash(config),
        revisions: yield* workspace.revisions,
        monitoring,
        dispatchers,
      };
    const mediaRows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const discovery = yield* listingStore.discovery(
      context.mode === "sample" ? "synthetic" : "manual",
    );
    const reading = yield* listingStore.reading();
    for (const row of mediaRows) {
      row.first_found_runs = discovery.byListing.get(row.key) ?? [];
      row.seen_in_searches = reading.get(row.key) ?? [];
    }
    const mediaQueue = repairQueue(
      mediaRows.filter((row) => searches.some((search) => search.product === row.product)),
      now,
    );
    return {
      revision: hash(config),
      revisions: yield* workspace.revisions,
      access_context: ACCESS_CONTEXT,
      mode: context.mode,
      paths: { database: context.databasePath },
      configuration_storage: "SQLite entity rows; workspace_settings stores shared settings",
      monitoring,
      dispatchers,
      journeys: {
        provider: "google_maps_browser",
        enabled: config.journey_checks_enabled,
        pending_towns: journeyQueue(mediaRows, searches, config.feedback, config, now).length,
        next_step:
          "Read list_goodfinds_journey_checks, check each Google Maps driving route in the selected browser, and save record_goodfinds_journey_check. Reuse town-level estimates across listingStore. Report blocked routes without inventing a duration.",
      },
      media_repairs: {
        pending: mediaQueue.length,
        ready: mediaQueue.filter((row) => row.ready).length,
        next_step: mediaQueue.length
          ? "After provisional discovery, read list_goodfinds_media_repairs for this search and attach ready recovered galleries without changing old fact timestamps or review coverage."
          : null,
      },
      origin: config.origin,
      origin_confirmed: config.origin_confirmed ?? false,
      location: config.location,
      browser_preference: config.browser_preference,
      platforms: config.platforms,
      browser_access: config.browser_access,
      platform_sessions: config.platform_sessions,
      comparison: {
        baseline_days: config.baseline_days,
        minimum_peer_listings: config.minimum_peer_listings,
      },
      searches: searches.map((search) => ({
        ...search,
        ...searchReadingSummary(
          mediaRows,
          search,
          config,
          discovery.lastSearched.get(search.id) ?? null,
        ),
        found_count: discovery.counts.get(search.id) ?? null,
      })),
      cover_follow_ups: searches.flatMap((search) => {
        const followUp = searchCoverFollowUp(search);
        return followUp ? [followUp] : [];
      }),
      drafts: config.drafts,
      feedback: config.feedback.filter((event) =>
        searches.some((search) => appliesToSearch(event, search)),
      ),
      search_runs: searchRuns.map((run) =>
        Object.assign({}, run, { progress: searchProgress(run) }),
      ),
      ...workflowViews({ ...config, searches }, searchRuns, fulfilled, now),
      query_plans: searches.map((search) => ({
        search_id: search.id,
        queries: queryPlan(search, config.feedback),
        excluded_models: excludedModels(search, config.feedback),
      })),
      fulfilled_searches: [...fulfilled],
    };
  }
  if (action === "list_search_runs") {
    const now = yield* Clock.currentTimeMillis;
    const views = args.progress_only
      ? {}
      : workflowViews(
          config,
          searchRuns,
          fulfilledSearches(yield* seller_conversation.summaries(now)),
          now,
        ).search_run_workflows;
    return {
      search_run_workflows: views,
      search_runs: searchRuns.map((run) =>
        args.progress_only
          ? { id: run.id, version: run.version, phase: run.phase }
          : Object.assign({}, run, { progress: searchProgress(run) }),
      ),
    };
  }
  if (action === "get_listing") {
    const row = yield* listingStore.find(
      args.listing_key ?? "",
      context.mode === "sample" ? "synthetic" : "manual",
    );
    if (!row)
      return yield* validation(() => {
        throw new Error("Choose a saved listing");
      });
    yield* listingStore.applyCaptures([row]);
    yield* listingStore.applyJourneys([row]);
    yield* listingStore.historyDetails(row);
    const now = yield* Clock.currentTimeMillis;
    const state = yield* workspaceSnapshot(context, config, now);
    const saved = state.listings.find((listing) => listing.key === row.key);
    row.first_found_runs = saved?.first_found_runs ?? [];
    row.seen_in_searches = saved?.seen_in_searches ?? [];
    row.quality = tracking.quality(row, config, now);
    return {
      listing: row,
      workflow: listingWorkflow(listingSchema.parse(row), state, now, args.search_id),
    };
  }
  const query = yield* validation(() => listingQuerySchema.parse(args));
  const now = yield* Clock.currentTimeMillis;
  const filters = querySellerFilters(query);
  yield* validation(() => {
    const error = sellerFilterError(filters, new Date(now).getUTCFullYear());
    if (error) throw new Error(error);
  });
  const state = yield* workspaceSnapshot(context, config);
  const selected = selectListings(
    state,
    {
      search_id: query.search_id,
      sellerFilters: filters,
      result_type: query.result_type,
      include_dismissed: query.include_dismissed,
      include_excluded: query.include_excluded,
      sort: query.sort,
      seen: query.seen,
    },
    now,
  );
  const total = selected.length;
  const rows = selected.slice(query.offset, query.offset + query.limit);
  const listings = rows.map((row) => ({
    key: row.key,
    title: row.title,
    url: row.url,
    source: row.source,
    price_minor: row.price_minor,
    currency: row.currency,
    price_period: row.price_period,
    product: row.product,
    first_observed_at: row.first_observed_at ?? row.observed_at ?? null,
    first_found_runs: row.first_found_runs,
    seen_in_searches: row.seen_in_searches,
    location: row.location,
    drive_minutes: row.drive_minutes ?? null,
    travel_source: row.travel_source ?? null,
    travel_checked_at: row.travel_checked_at ?? null,
    journey_precision: row.journey_estimate?.precision ?? null,
    availability: row.availability,
    collection_stage: row.collection_stage ?? "verification",
    model: row.attributes?.["model"] ?? null,
    chip: row.chip ?? null,
    ram_gb: row.ram_gb ?? null,
    ssd_gb: row.ssd_gb ?? null,
    condition: row.condition,
    seller_name: row.seller_name ?? null,
    seller_account_joined_at: row.seller_account_joined_at ?? null,
    seller_listing_count: row.seller_listing_count ?? null,
    seller_listing_count_precision: row.seller_listing_count_precision ?? null,
    saved_photos: row.photos?.length ?? 0,
    saved_videos: row.videos?.length ?? 0,
    media_capture: row.media_capture ?? null,
    search_matches: state.decisions
      .filter(
        (item) =>
          item.listing.key === row.key && (!query.search_id || item.search_id === query.search_id),
      )
      .map((item) => ({
        search_id: item.search_id,
        status: item.status,
        suitability: item.suitability,
        verification: item.verification,
        value: item.value,
        reasons: item.reasons,
      })),
  }));
  return {
    listings,
    total,
    next_offset:
      (args.offset ?? 0) + listings.length < total ? (args.offset ?? 0) + listings.length : null,
  };
});
