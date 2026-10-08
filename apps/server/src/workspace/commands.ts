import { listingSeenInputSchema, listingSearchIds } from "@goodfinds/contracts/listing-reading";
import { WorkspaceRepository } from "./repository.ts";
import { ListingRepository } from "../listings/repository.ts";
import { searchCommands } from "@goodfinds/contracts/search-workflow";
import { sellerWorkflow as conversationWorkflow } from "@goodfinds/contracts/seller-action-model";
import { searchRunAction, sellerAction } from "@goodfinds/contracts/tool-names";
import { modelExclusionRule, feedbackInputSchema } from "@goodfinds/contracts/discovery";
import { z } from "zod";
import demoRows from "../../../../skills/marketplace-shopping/assets/demo-listings.json" with { type: "json" };
import { recommendations, fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import {
  listingContactReportSchema,
  sameListingUrl,
} from "@goodfinds/contracts/marketplace-actions";
import { DAY, hash, iso, time } from "./model.ts";
import type { WorkspaceConfiguration } from "./model.ts";
import { Clock, Effect } from "effect";
import { entityTarget, entityRevision } from "@goodfinds/contracts/revisions";
import { validation, ValidationError, RevisionConflict } from "./errors.ts";
import * as engine from "../listings/evaluation.ts";
import { SellerConversations } from "../sellers/conversations.ts";
import { SearchRuns } from "../searches/runs.ts";
import { normalizeSearch } from "../searches/definition.ts";
import { hostScheduleReportSchema } from "@goodfinds/contracts/monitoring";
import { scheduledSearchCheck } from "../searches/scheduled-search.ts";
import type { WorkspaceContext } from "./context.ts";
import { ACCESS_CONTEXT } from "./context.ts";
import { workspaceSnapshot } from "./snapshot.ts";
import { updateConfig } from "./configuration-commands.ts";
import { requestScheduledBatch } from "./scheduled-dispatch.ts";
import { HostSchedules } from "../searches/host-schedules.ts";
import {
  scheduleObservationRecords,
  dispatcherForSearch,
} from "@goodfinds/contracts/scheduled-dispatch";

export const workspaceCommand = Effect.fn("workspaceCommand")(function* (
  context: WorkspaceContext,
  action: string,
  args: Record<string, unknown>,
  guard?: (config: WorkspaceConfiguration) => void,
) {
  const workspace = yield* WorkspaceRepository;
  const listingStore = yield* ListingRepository;
  const seller_conversation = yield* SellerConversations;
  const searchWorkflow = yield* SearchRuns;
  let config = yield* workspace.configuration;
  const hostSchedulesReader = yield* HostSchedules;
  const observedSchedules = hostSchedulesReader.observe(
    scheduleObservationRecords(config.monitoring, config.dispatchers),
    yield* Clock.currentTimeMillis,
  );
  const hostFor = (searchId: string) =>
    observedSchedules.get(
      dispatcherForSearch(config, searchId)
        ? `dispatcher:${dispatcherForSearch(config, searchId)?.id}`
        : searchId,
    ) ?? null;
  if (guard) yield* validation(() => guard(config));
  if (action === "request_scheduled_batch") {
    if (context.mode !== "live")
      return yield* validation(() => {
        throw new Error("Scheduled dispatch is only available in the live workspace");
      });
    const batch = yield* requestScheduledBatch(
      config,
      {
        dispatcher_id: args["dispatcher_id"],
        thread_id: args["thread_id"],
        request_id: args["request_id"],
      },
      observedSchedules,
    );
    return { state: yield* workspaceSnapshot(context, config), batch };
  }
  if (action === "set_listing_seen") {
    const input = yield* validation(() =>
      listingSeenInputSchema.parse({
        listings: args["listings"],
        seen: args["seen"],
      }),
    );
    const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const discoveries = yield* listingStore.discovery(
      context.mode === "sample" ? "synthetic" : "manual",
    );
    for (const row of rows) row.first_found_runs = discoveries.byListing.get(row.key) ?? [];
    yield* validation(() => {
      for (const entry of input.listings) {
        const search = config.searches.find((item) => item.id === entry.search_id);
        const row = rows.find((item) => item.key === entry.listing_key);
        if (!search || !row || !listingSearchIds(row, [search]).includes(search.id))
          throw new Error("Choose a listing from this saved search");
      }
    });
    yield* listingStore.setSeen(input, yield* Clock.currentTimeMillis);
    return { state: yield* workspaceSnapshot(context, config) };
  }
  if (action === "attach_listing_media") {
    const { mode: _mode, ...capture } = args;
    yield* listingStore.attachCapture(capture, context.mode, yield* Clock.currentTimeMillis);
    return { state: yield* workspaceSnapshot(context, config) };
  }
  if (action === "prepare_next_steps") {
    const selected = yield* validation(() =>
      z.object({ search_id: z.string(), run_id: z.uuid().optional() }).parse(args),
    );
    if (!config.searches.some((search) => search.id === selected.search_id))
      return yield* validation(() => {
        throw new Error("Choose a saved search");
      });
    const state = yield* workspaceSnapshot(context, config);
    const run = state.search_runs.find((item) =>
      selected.run_id
        ? item.id === selected.run_id && item.search_id === selected.search_id
        : item.search_id === selected.search_id,
    );
    if (selected.run_id && !run)
      return yield* validation(() => {
        throw new Error("Choose this search's saved run");
      });
    const candidate = recommendations(
      state,
      selected.search_id,
      selected.run_id ? run?.listing_keys : undefined,
    )[0];
    if (candidate) {
      const row = state.listings.find((item) => item.key === candidate.listing_key);
      if (row)
        yield* seller_conversation.handle(
          "prepare_opening",
          { search_id: selected.search_id, reasons: candidate.reasons },
          row,
          config,
          context.mode,
          ACCESS_CONTEXT,
          yield* Clock.currentTimeMillis,
        );
    }
    return { state: yield* workspaceSnapshot(context, config) };
  }
  if (searchRunAction(action) !== undefined) {
    const now = yield* Clock.currentTimeMillis;
    const fulfilled = fulfilledSearches(yield* seller_conversation.summaries(now));
    const runs = yield* searchWorkflow.runs();
    if (action === "request_search_run") {
      const request = searchCommands.start.parse(args["request"]);
      const searchId = request.search_id;
      if (request.trigger === "scheduled") {
        const latest = yield* searchWorkflow.latestScheduled(searchId);
        const check = scheduledSearchCheck(
          config,
          searchId,
          now,
          fulfilled,
          latest ? [...runs, latest] : runs,
          true,
          hostFor(searchId),
        );
        if (!check.allowed)
          return { state: yield* workspaceSnapshot(context, config), scheduled_check: check };
      } else {
        for (const searchRun of runs.filter(
          (item) => item.search_id === searchId && item.trigger === "scheduled",
        )) {
          const check = scheduledSearchCheck(
            config,
            searchId,
            now,
            fulfilled,
            [],
            false,
            hostFor(searchId),
          );
          if (!check.allowed)
            yield* searchWorkflow.stopScheduledRun(
              searchRun,
              check.explanation,
              now,
              check.reason === "quiet_hours",
            );
        }
      }
    } else if (action !== "cancel_search_run") {
      const request = z.object({ run_id: z.string() }).loose().parse(args["request"]);
      const searchRun = runs.find((item) => item.id === request.run_id);
      if (searchRun?.trigger === "scheduled") {
        const check = scheduledSearchCheck(
          config,
          searchRun.search_id,
          now,
          fulfilled,
          [],
          false,
          hostFor(searchRun.search_id),
        );
        if (!check.allowed) {
          yield* searchWorkflow.stopScheduledRun(
            searchRun,
            check.explanation,
            now,
            check.reason === "quiet_hours",
          );
          return { state: yield* workspaceSnapshot(context, config), scheduled_check: check };
        }
      }
    }
    const run = yield* searchWorkflow.searchAction(
      searchRunAction(action) ?? "",
      args["request"],
      config.searches,
      yield* Clock.currentTimeMillis,
      fulfilled,
      config.feedback,
    );
    if (["completed", "partial"].includes(run.phase)) {
      if (run.phase === "completed" && run.trigger === "scheduled") {
        const m = config.monitoring.find((item) => item.search_id === run.search_id);
        if (m && m.last_scheduled_run_at !== run.updated_at) {
          m.last_scheduled_run_at = run.updated_at;
          yield* workspace.saveConfiguration(config);
        }
      }
      const state = yield* workspaceSnapshot(context, config);
      const candidate = recommendations(state, run.search_id, run.listing_keys)[0];
      const row = candidate && state.listings.find((item) => item.key === candidate.listing_key);
      if (candidate && row)
        yield* seller_conversation.handle(
          "prepare_opening",
          { search_id: run.search_id, reasons: candidate.reasons },
          row,
          config,
          context.mode,
          ACCESS_CONTEXT,
          yield* Clock.currentTimeMillis,
        );
    }
    return { state: yield* workspaceSnapshot(context, config) };
  }
  if (sellerAction(action) !== undefined) {
    if (
      ["request_seller_action", "claim_seller_action", "issue_message_send_permit"].includes(action)
    ) {
      const summaries = yield* seller_conversation.summaries(yield* Clock.currentTimeMillis);
      const current = summaries.find((item) => item.listing_key === args["listing_key"]);
      const fulfilled = fulfilledSearches(summaries);
      const reconciliation =
        action === "claim_seller_action" && current?.pending_action?.status === "uncertain";
      const replyCheck = action === "request_seller_action" && args["kind"] === "check";
      if (
        current?.search_ids.some((id) => fulfilled.has(id)) &&
        current.outcome !== "bought" &&
        !reconciliation &&
        !replyCheck
      )
        return yield* validation(() => {
          throw new Error(
            "This buying goal has been fulfilled. Reopen the purchased conversation before further outreach.",
          );
        });
    }
    const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const row = rows.find((item) => item.key === args["listing_key"]);
    if (!row)
      return yield* validation(() => {
        throw new Error("Choose a saved listing in this workspace");
      });
    const result = yield* seller_conversation.handle(
      sellerAction(action) ?? "",
      args,
      row,
      config,
      context.mode,
      ACCESS_CONTEXT,
      yield* Clock.currentTimeMillis,
    );
    if (action === "set_buying_outcome" && result.conversation.outcome === "bought")
      yield* searchWorkflow.fulfilGoals(
        result.conversation.search_ids,
        yield* Clock.currentTimeMillis,
      );
    return {
      state: {
        ...(yield* workspaceSnapshot(context, config)),
        seller_conversation: result.conversation,
        seller_workflow: conversationWorkflow(result.conversation, {
          now: yield* Clock.currentTimeMillis,
          config,
          context_id: ACCESS_CONTEXT,
          mode: context.mode,
          availability: row.availability,
          expected_version: result.conversation.version,
        }),
      },
      ...(result.execution ? { execution: result.execution } : {}),
    };
  }
  if (
    [
      "save_search",
      "set_search_cover",
      "save_search_draft",
      "discard_search_draft",
      "set_search_enabled",
      "remove_search",
      "save_settings",
      "set_monitoring",
      "report_host_schedule",
      "report_dispatcher_schedule",
      "report_browser_access",
      "report_marketplace_session",
      "report_connections",
      "report_listing_contact",
      "record_listing_feedback",
      "undo_listing_feedback",
    ].includes(action)
  ) {
    if (
      action === "save_search" &&
      !z.object({ id: z.string().optional() }).parse(args["search"]).id
    )
      args["search"] = yield* normalizeSearch(args["search"]);
    const revisions = yield* workspace.revisions;
    const target = entityTarget(action, args);
    const current = target ? entityRevision(revisions, target) : revisions.evidence;
    if (args["expected_entity_revision"] !== current)
      return yield* Effect.fail(
        new RevisionConflict({
          message: "This resource changed elsewhere. Refresh it and reconcile your edit.",
          current_revision: current,
          resource: target ? `${target.kind}:${target.id ?? "workspace"}` : "workspace",
        }),
      );
    if (
      action === "save_search" &&
      typeof args["draft_id"] === "string" &&
      args["expected_draft_revision"] !== (revisions.drafts[args["draft_id"]] ?? revisions.absent)
    )
      return yield* Effect.fail(
        new RevisionConflict({
          message: "The unfinished search changed. Refresh it before saving.",
          current_revision: revisions.drafts[args["draft_id"]] ?? revisions.absent,
          resource: `drafts:${args["draft_id"]}`,
        }),
      );
    if (
      (action === "set_monitoring" ||
        action === "report_host_schedule" ||
        action === "report_dispatcher_schedule") &&
      context.mode === "sample"
    )
      return yield* Effect.fail(
        new ValidationError({ message: "Manage real monitoring in the live workspace" }),
      );
    if (action === "report_host_schedule") {
      const report = yield* validation(() => hostScheduleReportSchema.parse(args["report"]));
      if (
        report.status === "active" &&
        fulfilledSearches(yield* seller_conversation.summaries(yield* Clock.currentTimeMillis)).has(
          report.search_id,
        )
      )
        return yield* Effect.fail(
          new ValidationError({
            message: "This buying goal is fulfilled. Pause its host schedule.",
          }),
        );
    }
    let configurationArgs = args;
    if (action === "record_listing_feedback") {
      const feedback = yield* validation(() => feedbackInputSchema.parse(args["feedback"]));
      const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
      const search = config.searches.find((item) => item.id === feedback.search_id);
      if (
        !search ||
        !rows.some((row) => row.key === feedback.listing_key && row.product === search.product)
      )
        return yield* Effect.fail(
          new ValidationError({ message: "Choose a listing belonging to this search" }),
        );
      if (
        feedback.exclude_model === true ||
        (feedback.exclude_model === undefined && feedback.reason === "Not interested in this model")
      ) {
        const row = rows.find((item) => item.key === feedback.listing_key);
        const rule = row && search ? modelExclusionRule(row, search) : undefined;
        if (!rule)
          return yield* Effect.fail(
            new ValidationError({
              message:
                "The model is not verified. Dismiss just this listing or identify the model before excluding it.",
            }),
          );
        configurationArgs = {
          ...args,
          feedback: { ...feedback, exclude_model: true, rule },
        };
      }
    }
    if (action === "report_listing_contact") {
      const report = yield* validation(() => listingContactReportSchema.parse(args["report"]));
      const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
      if (
        !rows.some(
          (row) =>
            row.key === report.listing_key &&
            row.source === report.marketplace &&
            sameListingUrl(row.url, report.listing_url),
        )
      )
        return yield* Effect.fail(
          new ValidationError({
            message: "Contact evidence must match the saved listing and marketplace",
          }),
        );
    }
    const nowForConfig = yield* Clock.currentTimeMillis;
    const hostReader = yield* HostSchedules;
    const candidate = yield* updateConfig(
      action,
      configurationArgs,
      config,
      fulfilledSearches(yield* seller_conversation.summaries(nowForConfig)),
      hostReader.observe(
        scheduleObservationRecords(config.monitoring, config.dispatchers),
        nowForConfig,
      ),
    );
    config = yield* engine.validateConfiguration(candidate);
    yield* workspace.saveConfiguration(config);
    // Changed requirements or dismissals must also withdraw queued alerts immediately.
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual");
    const pending = yield* listingStore.pendingAlerts();
    for (const alert of [
      "set_search_cover",
      "save_search_draft",
      "discard_search_draft",
      "report_browser_access",
      "report_marketplace_session",
      "report_connections",
      "report_listing_contact",
      "set_monitoring",
      "report_host_schedule",
      "report_dispatcher_schedule",
    ].includes(action)
      ? []
      : pending) {
      const search = config.searches.find((item) => item.id === alert.search_id && item.enabled);
      const row = rows.find((item) => item.key === alert.listing_key);
      if (
        !search ||
        !row ||
        engine.evaluateListing(
          row,
          engine.comparisonPool(
            rows.filter(
              (item) =>
                time(item.last_observed_at) >= now - config.baseline_days * DAY &&
                time(item.last_observed_at) <= now,
            ),
            search,
            config,
            now,
            context.mode === "sample",
          ),
          search,
          config,
          now,
          context.mode === "sample",
        ).status !== "qualifies"
      )
        yield* listingStore.withdrawAlert(alert.id);
    }
  } else if (action === "record_journey_check") {
    yield* listingStore.recordJourney(
      args["report"],
      config,
      yield* listingStore.load(context.mode === "sample" ? "synthetic" : "manual"),
      yield* Clock.currentTimeMillis,
    );
  } else if (action === "load_sample_workspace") {
    if (context.mode !== "sample")
      return yield* validation(() => {
        throw new Error("Sample data must be loaded in sample mode");
      });
    yield* workspace.saveConfiguration(config);
    const now = yield* Clock.currentTimeMillis;
    const rows = demoRows.map((row) =>
      Object.assign({}, row, {
        drive_origin: config.origin,
        travel_checked_at: iso(now),
      }),
    );
    yield* listingStore.evaluate(config, rows, true, now);
  } else if (action === "import_listing_observations") {
    if (context.mode !== "live")
      return yield* validation(() => {
        throw new Error("Manual observations must be imported in live mode");
      });
    if (typeof args["run_id"] === "string") {
      const now = yield* Clock.currentTimeMillis;
      const searchRun = (yield* searchWorkflow.runs()).find((item) => item.id === args["run_id"]);
      if (searchRun?.trigger === "scheduled") {
        const check = scheduledSearchCheck(
          config,
          searchRun.search_id,
          now,
          fulfilledSearches(yield* seller_conversation.summaries(now)),
          [],
          false,
          hostFor(searchRun.search_id),
        );
        if (!check.allowed) {
          yield* searchWorkflow.stopScheduledRun(
            searchRun,
            check.explanation,
            now,
            check.reason === "quiet_hours",
          );
          return { state: yield* workspaceSnapshot(context, config), scheduled_check: check };
        }
      }
    }
    const rows = yield* validation(() => z.array(z.unknown()).max(500).parse(args["observations"]));
    const evaluationResult = yield* listingStore.evaluate(
      config,
      rows,
      false,
      yield* Clock.currentTimeMillis,
      args["search_coverage"],
    );
    if (typeof args["run_id"] === "string") {
      const now = yield* Clock.currentTimeMillis;
      const normalized = yield* engine.normalizeObservations(rows, false, now);
      const run = yield* searchWorkflow.find(args["run_id"]);
      const search = config.searches.find((item) => item.id === run?.search_id);
      yield* validation(() => {
        if (
          !run ||
          !search ||
          hash(search) !== run.search_revision ||
          normalized.some((row) => row.product !== search.product)
        )
          throw new Error("Import observations for the current search run and buying brief");
      });
      yield* searchWorkflow.recordSearchImport(args["run_id"], normalized, now, args["worker_id"]);
    }
    return {
      state: yield* workspaceSnapshot(context, config),
      import_receipt: {
        evaluation_id: evaluationResult.evaluation_id,
        observed_count: evaluationResult.observed_count,
      },
    };
  } else if (action === "search_now")
    return yield* validation(() => {
      throw new Error(
        "Live Marketplace searching is not connected. You can refresh saved listings or use sample data.",
      );
    });
  else if (action !== "get_workspace")
    return yield* validation(() => {
      throw new Error("Unsupported action");
    });
  return { state: yield* workspaceSnapshot(context, config) };
});
