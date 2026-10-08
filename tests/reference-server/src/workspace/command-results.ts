import { searchRunAction, sellerAction } from "@goodfinds/contracts/tool-names";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import type { CommandName } from "@goodfinds/contracts/operations";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { pendingAction } from "@goodfinds/contracts/seller-conversation";
import { entityTarget } from "@goodfinds/contracts/revisions";
import { searchCoverFollowUp } from "@goodfinds/contracts/search-cover";
import { searchWorkflow } from "@goodfinds/contracts/search-run-model";
import { sellerWorkflow } from "@goodfinds/contracts/seller-action-model";

const object = (value: unknown) =>
  value !== null && typeof value === "object" ? z.record(z.string(), z.unknown()).parse(value) : {};

export function commandResult(
  action: CommandName,
  args: Record<string, unknown>,
  result: { state: GoodfindsState; [key: string]: unknown },
) {
  const state = result.state;
  const common = {
    mode: state.mode,
    revision: state.revision,
    revisions: state.revisions,
    ...(result["receipt"] ? { receipt: result["receipt"] } : {}),
  };
  const target = entityTarget(action, args);
  const suppliedSearch = object(args["search"]);
  const search =
    state.config.searches.find((item) => item.id === target?.id) ??
    (target?.id
      ? null
      : (state.config.searches.find((item) => item.name === suppliedSearch["name"]) ??
        state.config.searches.at(-1) ??
        null));
  let data: Record<string, unknown>;
  if (
    [
      "save_search",
      "set_search_enabled",
      "remove_search",
      "set_search_cover",
      "set_monitoring",
      "report_host_schedule",
    ].includes(action)
  )
    data = {
      search: action === "remove_search" ? null : search,
      cover_follow_up: action !== "remove_search" && search ? searchCoverFollowUp(search) : null,
      monitoring: state.monitoring.filter((item) => item.search_id === search?.id),
      ...(action === "remove_search" ? { removed_search_id: args["search_id"] } : {}),
    };
  else if (["save_search_draft", "discard_search_draft"].includes(action))
    data = {
      draft:
        action === "discard_search_draft"
          ? null
          : (state.drafts.find((item) => item.id === target?.id) ?? state.drafts.at(-1) ?? null),
      ...(action === "discard_search_draft" ? { removed_draft_id: args["draft_id"] } : {}),
    };
  else if (action === "save_settings")
    data = {
      settings: {
        origin: state.config.origin,
        location: state.config.location,
        platforms: state.config.platforms,
        browser_preference: state.config.browser_preference,
        journey_checks_enabled: state.config.journey_checks_enabled,
        interval_minutes: state.config.schedule.interval_minutes,
        quiet_hours: state.config.schedule.quiet_hours,
        baseline_days: state.config.baseline_days,
        minimum_peer_listings: state.config.minimum_peer_listings,
      },
    };
  else if (action === "report_dispatcher_schedule") data = { dispatchers: state.dispatchers };
  else if (action === "request_scheduled_batch") data = { batch: result["batch"] };
  else if (action.startsWith("report_"))
    data = {
      access_context: state.access_context,
      evidence: {
        browser_access: state.config.browser_access,
        platform_sessions: state.config.platform_sessions,
        listing_contacts: state.config.listing_contacts,
      },
    };
  else if (action === "record_listing_feedback" || action === "undo_listing_feedback")
    data = {
      feedback:
        action === "undo_listing_feedback"
          ? (state.config.feedback.find((item) => item.id === args["feedback_id"]) ?? null)
          : (state.config.feedback.at(-1) ?? null),
    };
  else if (searchRunAction(action) !== undefined || action === "import_listing_observations") {
    const request = object(args["request"]);
    const run =
      state.search_runs.find((item) => item.id === (request["run_id"] ?? args["run_id"])) ??
      state.search_runs.find((item) => item.search_id === request["search_id"]) ??
      null;
    data = {
      search_run: run,
      workflow: run
        ? state.search_run_workflows[run.id]
        : searchWorkflow(null, { now: Date.parse(state.generated_at) }),
      ...(result["scheduled_check"] ? { scheduled_check: result["scheduled_check"] } : {}),
      ...(action === "import_listing_observations"
        ? { import_receipt: result["import_receipt"] }
        : {}),
    };
  } else if (sellerAction(action) !== undefined) {
    if (!state.seller_conversation) throw new Error("Missing conversation result");
    data = {
      conversation: {
        ...state.seller_conversation,
        pending_action: pendingAction(state.seller_conversation) ?? null,
      },
      workflow:
        state.seller_workflow ??
        sellerWorkflow(state.seller_conversation, {
          now: Date.parse(state.generated_at),
          config: state.config,
          mode: state.mode,
          context_id: state.access_context,
          expected_version: state.seller_conversation.version,
          availability: state.listings.find(
            (row) => row.key === state.seller_conversation?.listing_key,
          )?.availability,
        }),
      ...(result["execution"] ? { execution: result["execution"] } : {}),
    };
  } else if (action === "prepare_next_steps")
    data = { actions: state.next_steps.filter((item) => item.search_id === args["search_id"]) };
  else if (action === "set_listing_seen") {
    const pairs = z.array(z.object({ listing_key: z.string() })).parse(args["listings"]);
    data = {
      searches: state.searches,
      listings: state.listings
        .filter((item) => pairs.some((pair) => pair.listing_key === item.key))
        .map((item) => ({ key: item.key, seen_in_searches: item.seen_in_searches })),
    };
  } else if (action === "attach_listing_media") {
    const listing = state.listings.find((item) => item.key === args["listing_key"]);
    data = {
      listing_key: args["listing_key"],
      media_capture: listing?.media_capture,
      photos_count: listing?.photos.length ?? 0,
      videos_count: listing?.videos.length ?? 0,
    };
  } else data = {};
  return operations[action].output.parse({ ...common, ...data });
}
