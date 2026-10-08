import { createEbayClient } from "../platform/ebay.ts";
import { connectionCheckStorage } from "../platform/connection-checks-sqlite.ts";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";
import { GOODFINDS_VERSION } from "@goodfinds/contracts/version";
import { hostRequest } from "@goodfinds/contracts/host-request";
import { ebaySearchSchema, ebayItemSchema } from "../connections/ebay.ts";
import {
  locationPageResultSchema,
  marketplaceCapabilitiesResultSchema,
  ebaySearchResultSchema,
  ebayItemResultSchema,
} from "@goodfinds/contracts/external-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { listingQuerySchema } from "@goodfinds/contracts/listing-query";
export { executeWorkspaceCommand } from "../platform/workspace-sqlite.ts";
import { Backend, backendLayer } from "./backend.ts";
import type { Layer } from "effect";
import { Cause, Effect, ManagedRuntime } from "effect";
import { sellerActions } from "@goodfinds/contracts/tool-names";
import { operations, parseOperation, wireSchema } from "@goodfinds/contracts/operations";
import type { CommandName, OperationInput, QueryName } from "@goodfinds/contracts/operations";
import { commandResult } from "../workspace/command-results.ts";
import { validation, transport, ValidationError, errorDetails } from "../workspace/errors.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, modeSchema } from "@goodfinds/contracts/state";
import { searchCoverSchema, MANUFACTURER_PHOTO_GUIDANCE } from "@goodfinds/contracts/search-cover";
import {
  bundledSearchCovers,
  searchCoverCategorySchema,
} from "@goodfinds/contracts/search-cover-presets";
import {
  SEARCH_TEMPLATES,
  SEARCH_NAME_GUIDANCE,
  searchDefinitionSchema,
  interviewFields,
  validateAnswers,
} from "@goodfinds/contracts/search-definition";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { CUSTOM, NOT_SURE, nativeAnswer, nativeQuestion } from "../searches/interview.ts";
import { mediaFilesSchema, mediaIdSchema } from "../platform/media.ts";
import { searchProgress } from "@goodfinds/contracts/search-workflow";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import {
  connectionCheckResultSchema,
  connectionCheckTools,
} from "@goodfinds/contracts/connection-checks";
import { ConnectionChecks } from "../connections/checks.ts";
import { WORKSPACE_DIRECTORY } from "../platform/runtime.ts";
export const PANEL_RESOURCE_URI = `ui://goodfinds/shopping-panel-v${GOODFINDS_VERSION}.html`;
const mode = z.enum(["live", "sample"]).default("live");

export function stateToolResult(result: {
  state: GoodfindsState;
  [key: string]: unknown;
}): CallToolResult {
  const state = result.state;
  const summary = {
    mode: state.mode,
    revision: state.revision,
    revisions: state.revisions,
    access_context: state.access_context,
    counts: state.counts,
    searches: state.searches.map((search) => ({
      id: search.id,
      name: search.name,
      enabled: search.enabled,
      qualified_count: search.qualified_count,
      tracked_count: search.tracked_count,
      found_count: search.found_count,
      unseen_count: search.unseen_count,
      seen_count: search.seen_count,
      last_searched_at: search.last_searched_at,
      latest_found_at: search.latest_found_at,
    })),
    drafts: state.drafts.map((draft) => ({ id: draft.id, name: draft.name, values: draft.values })),
    search_runs: state.search_runs.map((run) => ({
      id: run.id,
      search_id: run.search_id,
      version: run.version,
      phase: run.phase,
      progress: searchProgress(run),
      next_step: run.next_step,
      interruption: run.interruption,
      worker: run.worker,
    })),
    seller_conversation: state.seller_conversation,
    attention_count: state.next_steps.length,
    next_steps: state.next_steps.slice(0, 3).map((item) => ({
      listing_key: item.listing_key,
      search_id: item.search_id,
      title: item.title,
      label: item.label,
      readiness: item.readiness,
    })),
    monitoring: state.monitoring.map((item) => ({
      search_id: item.search_id,
      preference: item.preference,
      interval_minutes: item.interval_minutes,
      timing: item.timing,
      plan: item.plan,
      quiet_now: item.quiet_now,
      next_allowed_at: item.next_allowed_at,
      status: item.status,
      label: item.label,
      next_action: item.next_action,
      automation_id: item.schedule?.automation_id ?? null,
      thread_id: item.schedule?.thread_id ?? null,
      verified_at: item.schedule?.verified_at ?? null,
      host_schedule: item.host_schedule,
      last_run_at: item.schedule?.last_run_at ?? null,
      interruption: item.interruption,
    })),
    hint: "Use get_goodfinds_search_context for the brief and query plan; list_goodfinds_listings for paginated summaries; get_goodfinds_listing for evidence/history. The panel receives full state separately.",
  };
  const compact = {
    ...result,
    mode: state.mode,
    revision: state.revision,
    revisions: state.revisions,
    state: summary,
  };
  return {
    structuredContent: compact,
    content: [{ type: "text", text: JSON.stringify(compact) }],
    _meta: { goodfinds_state: state },
  };
}

const executeWorkspaceCommand = <K extends CommandName>(
  action: K,
  args: OperationInput<K>,
  workspaceMode: "live" | "sample",
) => Effect.flatMap(Backend, (backend) => backend.request(action, args, workspaceMode));
const readSearchCover = (id: string) => Effect.flatMap(Backend, (backend) => backend.readImage(id));
const templatesCall = () =>
  Effect.succeed<CallToolResult>({
    structuredContent: { templates: SEARCH_TEMPLATES },
    content: [{ type: "text", text: JSON.stringify({ templates: SEARCH_TEMPLATES }) }],
  });
const searchCoverCatalogSchema = z
  .object({ category: searchCoverCategorySchema.optional() })
  .strict();
const searchCoversCall = Effect.fnUntraced(function* (input: unknown) {
  const args = yield* validation(() => searchCoverCatalogSchema.parse(input));
  const covers = bundledSearchCovers
    .filter(({ category }) => !args.category || category === args.category)
    .map(({ category, preset, image: cover }) => ({
      category,
      preset,
      label: cover.label,
      cover: searchCoverSchema.parse({
        media_id: cover.media_id,
        kind: cover.kind,
        alt: cover.alt,
        source_name: cover.source_name,
        prompt: cover.prompt,
      }),
    }));
  return {
    structuredContent: { covers },
    content: [{ type: "text" as const, text: JSON.stringify({ covers }) }],
  };
});

export function createGoodfindsServer(
  workspaceDirectory: string = WORKSPACE_DIRECTORY,
  layer: Layer.Layer<Backend> = backendLayer(workspaceDirectory),
) {
  const server = new McpServer(
    { name: "Goodfinds", version: GOODFINDS_VERSION },
    {
      instructions: hostRequest(
        SEARCH_NAME_GUIDANCE +
          " " +
          MANUFACTURER_PHOTO_GUIDANCE +
          " " +
          "Use the marketplace-shopping skill for setup, discovery, verification, monitoring and seller follow-up. Read get_goodfinds_search_context for the current brief, browser route, resource revisions and monitoring state. Use the canonical tools and arguments advertised here; no older aliases are accepted. Apply workflow.allowed_actions and workflow.prerequisites, save observations after each query, and use stable request IDs for retries. The parent requests a search run and dispatches a native background agent; the worker claims that exact run and renews its lease. If delegation or access is unavailable, save the interruption and return promptly. Read-only checks never activate monitoring. Reuse the buyer's existing one-off or recurring choice, respect compiled quiet hours, and reconcile shared dispatchers in the original buying conversation. Join compatible schedules through get_goodfinds_dispatcher_context and report_goodfinds_dispatcher_schedule. Each shared wake-up first calls request_goodfinds_scheduled_batch; dispatch only its returned unclaimed runs with bounded browser concurrency and reuse live workers. Seller messages require the exact reviewed user-approved action and a fresh single-use send permit. Sample evidence stays isolated. Read references/tool-contracts.md for revisions and retries, references/background-work.md for dispatch, and the workflow-specific skill reference for completion.",
      ),
    },
  );
  const runtime = ManagedRuntime.make(layer);
  const connectionChecks = new ConnectionChecks(connectionCheckStorage(workspaceDirectory), {
    readState: (workspaceMode) =>
      runtime.runPromise(
        executeWorkspaceCommand("get_workspace", {}, workspaceMode).pipe(
          Effect.map((result) => result.state),
        ),
      ),
    record: (observations, state, workspaceMode, signal, guard) =>
      runtime.runPromise(
        Effect.flatMap(Backend, (backend) =>
          backend.request(
            "report_connections",
            {
              reports: [...observations],
              expected_entity_revision: state.revisions.evidence,
              context_id: state.access_context,
            },
            workspaceMode,
            guard,
          ),
        ).pipe(Effect.map((result) => result.state)),
        { signal },
      ),
  });
  type Program = Effect.Effect<CallToolResult, unknown, Backend>;
  const calls = new Map<string, (args: unknown, signal?: AbortSignal) => Promise<CallToolResult>>();
  const effects = new Map<
    string,
    (args: unknown) => Effect.Effect<CallToolResult, never, Backend>
  >();
  const asResult = (program: Program) =>
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.succeed<CallToolResult>({
          isError: true,
          structuredContent: { error: errorDetails(Cause.squash(cause)) },
          content: [{ type: "text", text: errorMessage(Cause.squash(cause)) }],
        }),
      ),
    );
  const invoke = (program: Program, signal?: AbortSignal) =>
    runtime.runPromise(asResult(program), signal ? { signal } : undefined);
  const adapt = (name: string, handler: (args: unknown) => Program) => {
    const effect = (args: unknown) => asResult(handler(args));
    effects.set(name, effect);
    return (args: unknown, signal?: AbortSignal) =>
      runtime.runPromise(effect(args), signal ? { signal } : undefined);
  };
  let locationPreview: { shutdown: () => Promise<void> } | undefined;
  const sdkClose = server.close.bind(server);
  // Closing the SDK also interrupts outstanding workflows and releases the service Layer.
  server.close = async () => {
    connectionChecks.close();
    await locationPreview?.shutdown();
    return Effect.runPromise(
      runtime.disposeEffect.pipe(Effect.ensuring(transport(() => sdkClose()).pipe(Effect.orDie))),
    );
  };
  function tool(
    name: string,
    title: string,
    description: string,
    action: CommandName,
    readOnly = false,
    render = false,
  ): void {
    const operation = operations[action];
    const shape = operation.input.shape;
    const call = adapt(
      name,
      Effect.fnUntraced(function* (args: unknown) {
        const parsed = yield* validation(() => parseOperation(action, args));
        const fields: Record<string, unknown> = parsed;
        const backend = yield* Backend;
        if (action === "import_listing_observations")
          yield* backend.validateImages(fields["observations"]);
        if (action === "attach_listing_media") yield* backend.validateImages([parsed]);
        const image = yield* validation(() =>
          action === "set_search_cover"
            ? fields["cover"]
            : action === "save_search"
              ? z.object({ cover: searchCoverSchema.optional() }).parse(fields["search"]).cover
              : undefined,
        );
        if (image)
          yield* readSearchCover(
            (yield* validation(() => searchCoverSchema.parse(image))).media_id,
          );
        const selectedMode = yield* validation(() => modeSchema.parse(parsed["mode"] ?? "live"));
        const result = yield* backend.request(action, parsed, selectedMode);
        if (action === "get_workspace" || action === "load_sample_workspace")
          return stateToolResult(result);
        const data = yield* validation(() =>
          result["operation_result"]
            ? operation.output.parse({
                ...z.record(z.string(), z.unknown()).parse(result["operation_result"]),
                receipt: result["receipt"],
              })
            : commandResult(action, parsed, result),
        );
        return {
          structuredContent: data,
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          _meta: { goodfinds_state: result.state },
        };
      }),
    );
    const names =
      action === "set_search_enabled" || action === "remove_search" ? operation.names : [name];
    for (const toolName of names) {
      calls.set(toolName, call);
      const effect = effects.get(name);
      if (effect) effects.set(toolName, effect);
      registerAppTool(
        server,
        toolName,
        {
          title,
          description,
          inputSchema: shape,
          outputSchema: operation.wire,
          annotations: {
            ...operation.annotations,
            readOnlyHint: readOnly || operation.annotations.readOnlyHint,
          },
          _meta: {
            ui: {
              visibility: ["model", "app"],
              ...(render ? { resourceUri: PANEL_RESOURCE_URI } : {}),
            },
            ...(render
              ? { "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] } }
              : {}),
          },
        },
        (args: unknown, extra: { signal: AbortSignal }) => call(args, extra.signal),
      );
    }
  }
  tool(
    "open_goodfinds_panel",
    "Open Goodfinds",
    "Open Goodfinds beside the conversation to manage buying searches, compare listings, and see current linked Codex schedule status. Refreshes linked schedules without activating or resuming them.",
    "get_workspace",
    true,
    true,
  );
  for (const { name, title, description, input: schema, action } of connectionCheckTools) {
    const call = adapt(
      name,
      Effect.fnUntraced(function* (input: unknown) {
        const args = yield* validation(() => schema.parse(input));
        const result = yield* Effect.tryPromise({
          try: () => connectionChecks[action](args),
          catch: (cause) => cause,
        });
        const state = (yield* executeWorkspaceCommand("get_workspace", {}, args.mode)).state;
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          _meta: { goodfinds_state: state },
        };
      }),
    );
    calls.set(name, call);
    registerAppTool(
      server,
      name,
      {
        title,
        description,
        inputSchema: schema.shape,
        outputSchema: wireSchema(connectionCheckResultSchema),
        annotations: {
          readOnlyHint: action === "read",
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: { ui: { visibility: ["model", "app"] } },
      },
      (input: unknown, extra: { signal: AbortSignal }) => call(input, extra.signal),
    );
  }
  function dataTool(name: string, title: string, description: string, action: QueryName) {
    const operation = operations[action];
    const shape = operation.input.shape;
    const call = adapt(
      name,
      Effect.fnUntraced(function* (input: unknown) {
        const args = yield* validation(() => parseOperation(action, input));
        const backend = yield* Backend;
        const selectors = yield* validation(() =>
          z
            .object({
              listing_key: z.string().optional(),
              progress_only: z.boolean().optional(),
              thread_id: z.uuid().optional(),
              dispatcher_id: z.uuid().optional(),
              search_ids: z.array(z.string()).optional(),
              ...listingQuerySchema.shape,
            })
            .parse(args),
        );
        const result = yield* backend.query(action, selectors, args.mode);
        const structuredContent = yield* validation(() => operation.output.parse(result));
        return {
          structuredContent,
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        };
      }),
    );
    calls.set(name, call);
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: shape,
        outputSchema: operation.wire,
        annotations: operation.annotations,
      },
      (input: unknown, extra: { signal: AbortSignal }) => call(input, extra.signal),
    );
  }
  dataTool(
    "get_goodfinds_settings",
    "Read settings",
    "Read all panel-editable preferences and the current revision for save_goodfinds_settings: location, browser, marketplace choices, check frequency, quiet hours, time zone and price comparisons. Includes scoped browser/sign-in observations. Does not change permissions or schedules.",
    "get_settings",
  );
  dataTool(
    "list_goodfinds_activity",
    "Read recent activity",
    "Read the Activity panel's recent checks and current monitoring summary, with pagination. For active background workers use list_goodfinds_search_runs. Read-only; never starts or resumes a search.",
    "list_activity",
  );
  dataTool(
    "get_goodfinds_monitoring",
    "Read current monitoring status",
    "Read current status of the linked Codex automations, including external pauses, removal and unavailable status. Returns compact monitoring summaries without listing evidence. Read-only: does not create, resume or modify schedules. Unlinked searches still need host schedule discovery through the marketplace-shopping scheduling guidance.",
    "get_monitoring",
  );
  dataTool(
    "list_goodfinds_next_steps",
    "Read recommended next actions",
    "Read the attention queue, prepared draft text, conditional candidates and fulfilled buying goals. Works in chat without the panel. Recommendations do not authorize sending or purchase commitments.",
    "list_next_steps",
  );
  tool(
    "prepare_goodfinds_next_steps",
    "Prepare the next buying action",
    "Rank suitable or conditional saved candidates and prepare an unsent opening message for the strongest candidate. Idempotent; preserves edited drafts and existing conversations. Search completion does this automatically. Does not contact sellers.",
    "prepare_next_steps",
  );
  dataTool(
    "get_goodfinds_search_context",
    "Read buying brief and query plan",
    "Read compact settings, saved brief, research, query plans, resumable runs and monitoring choice/host receipts without listing histories. Includes required cover_follow_ups for identified products without photos, search_workflows and search_run_workflows action descriptors with input requirements and blocker recovery, plus absolute storage paths for scheduled prompts. Includes last_searched_at, latest_found_at and independent unseen/seen counts. Reading this context does not mark listings seen. Use its revision for edits. Omit search_id for setup or pass it to scope the search.",
    "get_search_context",
  );
  dataTool(
    "list_goodfinds_listings",
    "Read listing summaries",
    "Read the same listing groups and seller filters as the panel. Filter by saved search, seller's current listing-count limits and joined-by year, or choose all, promising or good_deals. Disregarded listings are hidden unless include_dismissed is true. Excluded models and aliases are hidden even in all results unless include_excluded is true. Use seen: unseen or seen to filter buyer reading status independently for each search; reading this tool never clears unseen status. Filtering precedes pagination; stale/unknown seller counts cannot satisfy a hard filter. Sort recent (last checked), recommended, price_low/price_high within currency/rent-period groups, or found_newest/found_oldest (first found, unchanged by rechecks). Returns compact specifications, seller context, match reasons and saved media counts; read get_goodfinds_listing for complete evidence/history.",
    "list_listings",
  );
  tool(
    "set_goodfinds_listing_seen",
    "Mark listings seen or unseen",
    "Save the buyer’s seen status for explicit listing/search pairs. Seen is independent per search and survives rechecks and restarts. Set seen: false to mark unseen. Agent browsing or reading tools never marks listings seen automatically; use this only when the buyer asks or when the panel observes the buyer viewing a card.",
    "set_listing_seen",
  );
  dataTool(
    "get_goodfinds_listing",
    "Read listing evidence",
    "Read one saved listing, its verification checks, setup costs, photo/video references, media-capture failures and history on demand. Includes independent workflow dimensions and action blockers; pass search_id for scoped suitability, dismissal and next steps.",
    "get_listing",
  );
  dataTool(
    "list_goodfinds_journey_checks",
    "Read missing journey estimates",
    "Read town-grouped Google Maps checks for relevant saved listings. Local cached routes are reused automatically; confirmed text origins work without coordinates. Scope by search_id and paginate. Check the driving route in the selected browser and save its visible duration, actual timestamp and evidence with record_goodfinds_journey_check. Do not use straight-line distance as driving time.",
    "list_journey_checks",
  );
  tool(
    "record_goodfinds_journey_check",
    "Save a checked driving estimate",
    "Save an observed Google Maps driving route without refreshing listing availability, price, photos or observation times. Pass the queue origin_key and destination, all matching listing_keys, visible minutes, source_url, evidence and checked_at. Town-level routes share a local cache. Traffic estimates expire after 24 hours; explicit typical estimates after seven days. Changed origins invalidate cached results. This tool does not contact sellers.",
    "record_journey_check",
  );
  dataTool(
    "list_goodfinds_media_repairs",
    "Read incomplete listing galleries",
    "Read a paginated recovery queue for saved listings with missing or unconfirmed gallery capture, including photos/videos saved, expected totals, failures and retry times. Scope by search_id. Ready entries can be revisited after provisional discovery; failed captures wait 24 hours between automatic retries. An explicit buyer-requested reconciliation can retry sooner. Use attach_goodfinds_listing_media to save recovered files without changing listing facts or review coverage.",
    "list_media_repairs",
  );
  dataTool(
    "check_goodfinds_scheduled_search",
    "Check whether a scheduled search is due",
    "Call before any scheduled browser/API work or background dispatch. Read current quiet hours, cadence, enabled/fulfilled status and prior starts. allowed false is a normal skip: do not browse, create a worker, notify routine skips or catch up missed times. Returns the compiled schedule plan and next permitted time. A subsequent start must pass trigger scheduled so the server rechecks atomically.",
    "check_scheduled_search",
  );
  dataTool(
    "list_goodfinds_search_runs",
    "Read search progress",
    "Read durable background worker identity/lease, query coverage, discoveries, next step and search_run_workflows action descriptors. progress_only returns compact version polling without action views. Expired agents become interrupted, preserving results. Reuse an active worker; resume stopped runs with a new agent.",
    "list_search_runs",
  );
  dataTool(
    "get_goodfinds_dispatcher_context",
    "Read shared search scheduling",
    "Read a shared wake-up plan for explicit search_ids or an existing dispatcher_id in its original thread_id. Returns current plan revision, members, legacy automation receipts and verified shared schedules. Does not activate monitoring. Preserve search-specific timing; use this plan for host registration.",
    "get_dispatcher_context",
  );
  tool(
    "request_goodfinds_scheduled_batch",
    "Dispatch due saved searches",
    "The shared automation calls this first with its dispatcher_id, original thread_id and stable request_id for this wake-up. The database atomically reserves only due recurring searches, respecting quiet hours, fulfilment and individual pauses. Existing workers are reused. Dispatch collection workers only for returned unclaimed runs; an empty batch is quiet. A request reserves work and does not prove execution or authorize seller contact.",
    "request_scheduled_batch",
  );
  tool(
    "report_goodfinds_dispatcher_schedule",
    "Record a shared host schedule",
    "Record a verified shared automation against get_goodfinds_dispatcher_context plan.revision and expected_entity_revision for settings. Preserve host, original thread and notification policy. Pause and verify redundant legacy automations before migration; only existing recurring choices join. Active host rule must match the shared plan. Timing and successful-run history remain per search.",
    "report_dispatcher_schedule",
  );
  tool(
    "request_goodfinds_search_run",
    "Start or resume a search",
    "Save a durable query plan before background dispatch. Pass trigger scheduled for every automation wake-up: the server enforces quiet hours, saved daily times and check intervals before creating work. A skipped scheduled_check is normal; do not dispatch. Explicit manual searches use trigger manual and can run during quiet hours without changing monitoring. Reuses an active run without resetting its owner or progress. Only claim_goodfinds_search_run proves an agent started.",
    "request_search_run",
  );
  tool(
    "claim_goodfinds_search_run",
    "Connect a background search agent",
    "Called by the spawned native subagent before browsing. Use its actual agent ID or canonical task name and a new worker UUID. Optional request.execution records actual host-reported profile/model/reasoning_effort, not a recommendation or model switch; omit unknown settings. Atomically claims one current run for five minutes; overlapping workers are rejected. Pass worker_id on subsequent progress and run imports. Never invent an agent or claim from the parent chat.",
    "claim_search_run",
  );
  tool(
    "renew_goodfinds_search_lease",
    "Report background search activity",
    "Renew the claimed agent's five-minute lease at least once a minute and before lengthy work. No expected_version is needed; read the returned version before progress updates. Cancelled, expired and replaced workers cannot renew or import results.",
    "renew_search_lease",
  );
  tool(
    "cancel_goodfinds_search_run",
    "Stop a background search",
    "Cancel a saved run atomically while preserving listings. A worker checks cancellation before each browser step and import; later progress and imports are rejected. Completed runs remain completed. This stops the current search, not its recurring schedule.",
    "cancel_search_run",
  );
  tool(
    "update_goodfinds_search_run",
    "Record search progress",
    "Record a planned query, phase, interruption or next step with current version and worker_id when claimed. Updates renew activity. Completion requires category coverage and outcomes for other queries. Use partial for incomplete coverage. A buyer cancellation can set phase cancelled without worker_id; the worker must stop at its next checkpoint.",
    "update_search_run",
  );
  tool(
    "get_goodfinds_workspace",
    "Read Goodfinds searches and deals",
    "Refresh full panel state through app-only metadata and return compact counts/progress to the model. For buying briefs and edit revisions use get_goodfinds_search_context; for evidence use paginated summaries and get_goodfinds_listing. Sample mode is fictional.",
    "get_workspace",
    true,
  );
  tool(
    "save_goodfinds_search",
    "Save a search",
    "Create or edit a search using its validated definition and answers. Apply the search-name rules in references/search-setup.md. Save a completed draft with draft_id and the current revision. Resolve cover_follow_up after initial discovery, including searches with no listings: automatically fetch, locally cache and attach the manufacturer photo, or report the specific blocker. Then resolve returned monitoring.next_action through the skill's evaluation-delivery guide; saving alone does not schedule checks. Increment definition.version when fields change. Prices are integer pence.",
    "save_search",
  );
  tool(
    "set_goodfinds_search_cover",
    "Choose a search card image",
    "Set a representative cover for one saved search using a media ID from cache_goodfinds_images or list_goodfinds_search_covers, descriptive alt text and source information. Manufacturer, stock and area images need source_url; generated illustrations need their prompt. Include location for a cover tied to the saved rental area so it resets when the location changes. Bundled covers are generic illustrations; identified products require suitable locally cached product photos. This is a search illustration, separate from listing evidence. Read the current revision first. Pass cover null to restore the category default.",
    "set_search_cover",
  );
  const searchCoversBoundary = adapt("list_goodfinds_search_covers", searchCoversCall);
  calls.set("list_goodfinds_search_covers", searchCoversBoundary);
  registerAppTool(
    server,
    "list_goodfinds_search_covers",
    {
      title: "Read generic search cover options",
      description:
        "Read bundled monochrome illustrations, optionally filtered by category rental, vehicle, furniture, cycling, garden or baby. Select an item type supported by the brief; broad or unbranded searches can use generic artwork. Rental presets use an explicit search country; ambiguous places use neutral. These are fictional category illustrations, not product photos or listing evidence. Named models need an official photo fetched into the user's workspace, or a reported blocker if unavailable. Pass the chosen cover object to set_goodfinds_search_cover, adding location with the saved rental area for localized rentals.",
      inputSchema: searchCoverCatalogSchema.shape,
      outputSchema: wireSchema(
        z.object({
          covers: z.array(
            z.object({
              category: searchCoverCategorySchema,
              preset: z.string(),
              label: z.string(),
              cover: searchCoverSchema,
            }),
          ),
        }),
      ),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    (args, extra) => searchCoversBoundary(args, extra.signal),
  );
  tool(
    "save_goodfinds_search_draft",
    "Prepare search questions",
    "Create or update an unfinished search from the user's brief. Pass a supported definition or adapt its fields, comparison attributes and matching rules. Apply the marketplace-shopping skill's question-design check before saving. Answers must come from the user; leave unanswered fields absent. Supply the draft id to resume. Read state first; increment definition.version when changing fields.",
    "save_search_draft",
  );
  tool(
    "discard_goodfinds_search_draft",
    "Discard an unfinished search",
    "Remove an unfinished search without changing saved searches or listing history.",
    "discard_search_draft",
  );

  const templatesBoundary = adapt("list_goodfinds_search_templates", templatesCall);
  calls.set("list_goodfinds_search_templates", templatesBoundary);
  server.registerTool(
    "list_goodfinds_search_templates",
    {
      title: "List search templates",
      description:
        "Read laptop and rental starter definitions; generate other categories using the supported contract. question_stage can be setup or refinement: required fields default to setup, optional fields default to refinement. Mark a decisive optional question setup; required fields cannot be refinement. Preserve user-led attributes even beyond marketplace filters. Use earlier-field visibility conditions, deterministic matching operators and exact comparison attributes. Save definitions and partial answers as drafts. Normalize location values with listing evidence. Rental prices need an explicit week/month period. Keep stable category and field IDs.",
      inputSchema: {},
      outputSchema: wireSchema(z.object({ templates: z.array(searchDefinitionSchema) })),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args, extra) => templatesBoundary(args, extra.signal),
  );
  const interviewInput = z
    .object({
      mode,
      draft_id: z.string(),
      stage: z.enum(["setup", "refinement"]).default("setup"),
      refinement_fields: z.array(z.string()).min(1).max(10).optional(),
    })
    .strict();
  const interview = Effect.fn("interview")(function* (
    input: unknown,
    elicit: (params: ElicitRequestFormParams, signal: AbortSignal) => Promise<ElicitResult>,
  ) {
    const args = yield* validation(() => interviewInput.parse(input));
    let { state } = yield* executeWorkspaceCommand("get_workspace", {}, args.mode);
    const draft = state.drafts.find((item) => item.id === args.draft_id);
    if (!draft)
      return yield* Effect.fail(
        new ValidationError({ message: "That unfinished search no longer exists" }),
      );
    if (args.refinement_fields) {
      if (args.stage !== "refinement")
        return yield* Effect.fail(
          new ValidationError({ message: "Select refinement fields only during refinement" }),
        );
      for (const id of args.refinement_fields) {
        const selected = draft.definition.fields.find((item) => item.id === id);
        if (!selected || selected.required || selected.question_stage === "setup")
          return yield* Effect.fail(
            new ValidationError({ message: `That field is not an optional refinement: ${id}` }),
          );
      }
    }
    const field = interviewFields(
      draft.definition,
      draft.values,
      args.stage,
      args.refinement_fields,
      draft.uncertain_fields ?? [],
    )[0];
    let status = draft.definition.fields.some(
      (item) => item.required && draft.uncertain_fields?.includes(item.id),
    )
      ? "needs_guidance"
      : "ready";
    if (field) {
      const capabilities = server.server.getClientCapabilities()?.elicitation;
      if (!capabilities || (!capabilities.form && Object.keys(capabilities).length > 0))
        status = "unsupported";
      else {
        let result = yield* transport((signal) => elicit(nativeQuestion(field), signal));
        let custom = false;
        if (result.action === "accept" && result.content?.[field.id] === CUSTOM) {
          custom = true;
          result = yield* transport((signal) => elicit(nativeQuestion(field, true), signal));
        }
        if (result.action !== "accept")
          status = result.action === "cancel" ? "cancelled" : "declined";
        else {
          const reply = result.content?.[field.id];
          const unsure =
            !custom &&
            field.allow_unsure &&
            (reply === NOT_SURE || (Array.isArray(reply) && reply.includes(NOT_SURE)));
          if (unsure && Array.isArray(reply) && reply.length !== 1)
            return yield* Effect.fail(
              new ValidationError({
                message: "Choose Not sure on its own, or select the options you want",
              }),
            );
          const values = unsure
            ? draft.values
            : {
                ...draft.values,
                [field.id]: yield* validation(() =>
                  nativeAnswer(field, result.content ?? {}, custom),
                ),
              };
          const uncertain_fields = unsure
            ? [...new Set([...(draft.uncertain_fields ?? []), field.id])]
            : (draft.uncertain_fields ?? []).filter((id) => id !== field.id);
          const errors = validateAnswers(draft.definition, values, true);
          if (errors.length)
            return yield* Effect.fail(
              new ValidationError({ message: errors[0] ?? "Invalid answer" }),
            );
          ({ state } = yield* executeWorkspaceCommand(
            "save_search_draft",
            {
              expected_entity_revision: state.revisions.drafts[draft.id] ?? state.revisions.absent,
              request_id: crypto.randomUUID(),
              draft: { ...draft, values, uncertain_fields },
            },
            args.mode,
          ));
          status =
            unsure ||
            draft.definition.fields.some(
              (item) => item.required && uncertain_fields.includes(item.id),
            )
              ? "needs_guidance"
              : interviewFields(
                    draft.definition,
                    values,
                    args.stage,
                    args.refinement_fields,
                    uncertain_fields,
                  ).length
                ? "answered"
                : "ready";
        }
      }
    }
    const result = {
      state,
      interview: {
        status,
        stage: args.stage,
        draft_id: draft.id,
        remaining_refinements: interviewFields(
          draft.definition,
          state.drafts.find((item) => item.id === draft.id)?.values ?? draft.values,
          "refinement",
        )
          .filter((item) => !item.required && item.question_stage !== "setup")
          .map((item) => ({ id: item.id, label: item.label })),
        ...(field ? { question: field } : {}),
      },
    };
    return stateToolResult(result);
  });
  calls.set(
    "ask_goodfinds_search_question",
    adapt("ask_goodfinds_search_question", (input) =>
      interview(input, (params, signal) => server.server.elicitInput(params, { signal })),
    ),
  );
  server.registerTool(
    "ask_goodfinds_search_question",
    {
      title: "Ask a search question",
      description:
        "Ask the next unanswered applicable setup question through the host's native form. ready means review/save is available even when optional refinements remain. Use stage refinement only when the user wants those details and pass refinement_fields with the selected field IDs to keep follow-ups focused. Omitting that list includes all applicable refinements. Required/setup questions come first. Cancel/decline preserves the draft. Unsupported means use the same short sequence in chat or the panel. Explicit no preference is recorded; supplied answers are not asked again. Call get_goodfinds_workspace for draft_id.",
      inputSchema: interviewInput.shape,
      outputSchema: wireSchema(
        z.object({
          state: operations.get_workspace.output.shape.state,
          interview: z
            .object({
              status: z.enum([
                "ready",
                "needs_guidance",
                "unsupported",
                "cancelled",
                "declined",
                "answered",
              ]),
              stage: z.enum(["setup", "refinement"]),
              draft_id: z.string(),
              remaining_refinements: z.array(z.object({ id: z.string(), label: z.string() })),
            })
            .loose(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input, extra) =>
      invoke(
        interview(input, (params, signal) =>
          server.server.elicitInput(params, {
            relatedRequestId: extra.requestId,
            signal,
          }),
        ),
        extra.signal,
      ),
  );
  tool(
    "set_goodfinds_monitoring",
    "Save one-off or recurring monitoring choice",
    "Record an explicit one-off/search choice and cadence: interval_minutes, or timing {mode: daily, times: [HH:mm,...]} for up to 12 daily times in the saved quiet-hours time zone. Recurring searches respect quiet hours (22:00–08:00 by default); allow_quiet_hours true is an explicit per-search override. Preserve other choices when omitted. Does not create a schedule. Reconcile its shared dispatcher in the original buying thread through get_goodfinds_dispatcher_context and report_goodfinds_dispatcher_schedule. Configure the host with the shared plan, preserving peer timings and existing pauses.",
    "set_monitoring",
  );
  tool(
    "report_goodfinds_host_schedule",
    "Record verified host schedule status",
    "Legacy migration only: record the host-observed automation ID, original buying thread, status, interval, actual rrule, timezone and evidence for one unshared search. Shared members use report_goodfinds_dispatcher_schedule. Active requires the buyer's search choice and the compiled plan's recurrence/time zone. Reuse existing automation IDs and thread bindings. Record blocked attempts without erasing a previously active receipt. Only provide next/last run timestamps observed in the host; registration does not prove an unattended run succeeded.",
    "report_host_schedule",
  );
  tool(
    "set_goodfinds_search_enabled",
    "Pause or enable a search",
    "Pause or enable evaluation of a saved search. Reconcile the shared dispatcher in its original buying thread: pausing one member preserves eligible peers, and the host pauses only when none remain. Verify and record the shared plan; preserve external group pauses unless resuming is authorized. Evaluation changes alone do not change the external scheduler.",
    "set_search_enabled",
  );
  tool(
    "remove_goodfinds_search",
    "Remove a buying search",
    "Remove a saved search while retaining listing history. A shared member can be removed while eligible peers continue; removing the final active member requires a verified host pause. Legacy individual schedules also require a verified pause. Keep at least one search; read the current state before removing.",
    "remove_search",
  );
  tool(
    "save_goodfinds_settings",
    "Save search preferences",
    "Save location, browser, default check interval, comparisons and quiet_hours {enabled,start,end,timezone}. Quiet hours default to 22:00–08:00 in the local time zone and apply to recurring searches, while manual searches remain available. Changes take effect in the scheduled-run guard immediately; reconcile existing shared host schedules against their new dispatcher plans without activating paused searches.",
    "save_settings",
  );
  tool(
    "report_goodfinds_browser_access",
    "Record verified browser access",
    "Record host-observed browser capability, host/profile, evidence and website blocks. Use current access_context as context_id. Missing capability is unknown, not proof of denied permission. This records a check; it grants no permission.",
    "report_browser_access",
  );
  tool(
    "report_goodfinds_listing_contact",
    "Record observed listing contact options",
    "WorkspaceStore the actual listing's observed message/offer controls, offer_note support inside the native form, disabled state, external-only contact and offer limits. Native offers plus personal text are preferred when available; standalone messaging and embedded notes are distinct. Inspect the selected host/browser profile; login is separate. Use current access_context as context_id. Do not infer eligibility or Vinted discounts from the platform name, cookie presence or seller text. Record bounds for this individual item's native form; bundle-only forms remain unknown for this listing. Recording evidence does not send an offer or message.",
    "report_listing_contact",
  );
  const sellerTools = [
    [
      "plan",
      "save_goodfinds_collection_plan",
      "Save viewing or collection plan",
      "Save proposed or confirmed date/time, pickup location and demonstration details with a conversation version. A confirmed plan needs supporting evidence; seller evidence must quote a saved incoming message. Does not contact the seller.",
    ],
    [
      "arrange",
      "prepare_goodfinds_collection_message",
      "Prepare collection message",
      "Prepare an unsent viewing/collection message from the saved plan, agreed price and unresolved item checks. Missing date/time and location remain questions. User-requested regeneration replaces the current draft; review the exact new text before sending.",
    ],
    [
      "get",
      "get_goodfinds_seller_conversation",
      "Read listing conversation",
      "Read one saved listing's seller conversation, version, exact drafts, action history and observed seller messages. Opening does not contact the seller.",
    ],
    [
      "save",
      "save_goodfinds_seller_message_draft",
      "Save reviewed offer draft",
      "Save the buyer's exact message, offer and optional collection terms with the current conversation version. Saving does not authorize sending. A reply must reference the incoming message it answers.",
    ],
    [
      "request",
      "request_goodfinds_seller_action",
      "Request reviewed message or reply check",
      "Create one durable send or check action with a unique request_id. Request a send only when the user explicitly chooses the exact reviewed text and listing, after report_goodfinds_listing_contact confirms its message interface. Native platform offers use their separate form handoff. Reuse the action ID when retrying a handoff. This records authorization; it does not send a platform message. Sample mode is manual practice only.",
    ],
    [
      "handoff",
      "report_goodfinds_seller_action_handoff",
      "Record chat handoff",
      "Record that the host accepted this action request. This is not confirmation of a seller message.",
    ],
    [
      "cancel",
      "cancel_goodfinds_seller_action",
      "Cancel unstarted outreach",
      "Cancel an unstarted or safely blocked action. An interrupted or potentially sent message requires thread reconciliation first.",
    ],
    [
      "claim",
      "claim_goodfinds_seller_action",
      "Claim seller browser action",
      "Claim a saved user-approved action after current browser access and profile sign-in are reported. Returns a lease_token and reconcile_required; never grants send permission. Completed actions return no lease. An interrupted send can only be reconciled, not resent. Follow references/seller-conversation.md.",
    ],
    [
      "prepare",
      "issue_goodfinds_message_send_permit",
      "Verify one outgoing message",
      "Immediately before sending, verify canonical listing, seller profile, buyer, browser profile and existing thread, and check the thread for duplicates. Supply actual identity evidence. Returns execution.send_permitted true at most once per action after checking collection expiry and availability. Send only on that fresh true result; replay cannot grant another permit.",
    ],
    [
      "complete",
      "report_goodfinds_seller_action_result",
      "Record browser action evidence",
      "Record sent only after observing the exact outgoing draft in its verified thread; include its full text in evidence. An interrupted send stays uncertain until reconciliation proves sent or not_sent. Checked imports incoming messages in chronological order, with stable external_id, actual platform_at or null, multiple reply facets and supporting words. No new reply is not rejection. This tool records evidence; it performs no browser action.",
    ],
    [
      "manual",
      "record_goodfinds_user_reported_message",
      "Record message reported by buyer",
      "Record a seller reply or the exact pending outgoing message explicitly reported sent by the user. Provenance stays user_reported; do not claim a browser observation. Use a stable external_id and current conversation version.",
    ],
    [
      "correct",
      "correct_goodfinds_reply_interpretation",
      "Correct seller reply meaning",
      "Record the buyer's correction to one seller message, retaining the original facets in an audit event. Multiple price, collection and availability facets can coexist; uncertain wording needs review.",
    ],
    [
      "outcome",
      "set_goodfinds_buying_outcome",
      "Record buying outcome",
      "Record open, bought, withdrawn or unavailable as stated by the user. An accepted offer is not a purchase. Listing asking price and availability observations stay unchanged.",
    ],
  ] as const;
  for (const [operation, name, title, description] of sellerTools) {
    const action = Object.keys(sellerActions)
      .filter((key): key is keyof typeof sellerActions => Object.hasOwn(sellerActions, key))
      .find((key) => sellerActions[key] === operation);
    if (!action) throw new Error("Missing seller operation");
    tool(name, title, description, action, operation === "get");
  }
  tool(
    "report_goodfinds_marketplace_session",
    "Record platform sign-in",
    "Record sign-in observed in one marketplace and browser profile. Use actual visible evidence, current context_id and revision. Public browsing is not sign-in. Keep passwords, cookies and API credentials in their own stores.",
    "report_marketplace_session",
  );
  tool(
    "record_goodfinds_listing_feedback",
    "Remember listing feedback",
    "Save the buyer's original feedback with scope (search by default). A dismissal hides this listing. Set exclude_model: true only for an explicit model rejection; the server saves an alias-aware exclusion from verified listing evidence. Supply another rule only when the buyer explicitly states that preference; damage, distance or vague rejection do not justify broader exclusions. Never guess a numeric limit.",
    "record_listing_feedback",
  );
  tool(
    "undo_goodfinds_listing_feedback",
    "Undo learned feedback",
    "Undo one saved feedback event and its matching effect without deleting its original wording.",
    "undo_listing_feedback",
  );
  const ebay = createEbayClient();
  const externalTool = <O extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: z.ZodRawShape,
    output: z.ZodObject<O>,
    run: (args: unknown, signal: AbortSignal) => Promise<unknown>,
    openWorld = true,
  ) => {
    const input = z.object(shape).strict();
    const call = adapt(
      name,
      Effect.fnUntraced(function* (args: unknown) {
        const parsed = yield* validation(() => input.parse(args));
        const result = yield* transport((signal) => run(parsed, signal));
        const structuredContent = yield* validation(() => output.parse({ result }));
        return {
          structuredContent,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }),
    );
    calls.set(name, call);
    registerAppTool(
      server,
      name,
      {
        title,
        description,
        inputSchema: shape,
        outputSchema: wireSchema(output),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: name !== "open_goodfinds_location_chooser",
          openWorldHint: openWorld,
        },
        _meta: { ui: { visibility: ["model"] } },
      },
      (args: unknown, extra: { signal: AbortSignal }) => call(args, extra.signal),
    );
  };
  externalTool(
    "open_goodfinds_location_chooser",
    "Open a one-use browser location page",
    "Open the returned device-local URL in the user's chosen available browser. This page lasts five minutes, can save location once, and requires explicit button clicks and browser consent. It runs on the MCP server device, so use only with a browser on that same user's device. No browser automation permission is granted by opening it.",
    { mode },
    locationPageResultSchema,
    async (input, signal) => {
      const args = z.object({ mode }).parse(input);
      const { state } = await runtime.runPromise(
        executeWorkspaceCommand("get_workspace", {}, args.mode),
        {
          signal,
        },
      );
      await locationPreview?.shutdown();
      const { openPreview } = await import("./preview.ts");
      const preview = await Effect.runPromise(
        openPreview(workspaceDirectory, 0, { mode: args.mode, revision: state.revisions.settings }),
        { signal },
      );
      const shutdown = () => Effect.runPromise(preview.shutdown);
      const timer = setTimeout(() => {
        void shutdown().catch(() => {});
      }, 5 * 60_000);
      timer.unref();
      locationPreview = {
        shutdown: async () => {
          clearTimeout(timer);
          await shutdown();
        },
      };
      return {
        url: preview.url,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        note: "User-device browser only. Click to locate and confirm; this does not grant external browser control.",
      };
    },
    false,
  );
  externalTool(
    "list_goodfinds_marketplace_capabilities",
    "Read platform capabilities",
    "Read marketplace collection routes and whether the server has eBay application credentials. Browser logins do not grant API access; link/import platforms need an approved collection route.",
    {},
    marketplaceCapabilitiesResultSchema,
    async () => ({
      marketplaces: MARKETPLACES,
      ebay_api_configured: ebay.configured,
      message_execution: ["facebook_marketplace"],
      native_offer_execution: [],
      contact_scope: "observed_per_listing",
    }),
    false,
  );
  externalTool(
    "search_goodfinds_ebay",
    "Search eBay fixed-price listings",
    "Use the official eBay Browse API with server application credentials. Returns one page of uninspected evidence in eBay order, not a completed search/import. Keep query alternatives broad, collect item details, inspect images and verify full costs before importing. No buyer browser login needed.",
    ebaySearchSchema.shape,
    ebaySearchResultSchema,
    (args, signal) => ebay.search(args, signal),
  );
  externalTool(
    "get_goodfinds_ebay_listing",
    "Read eBay listing details",
    "Read one eBay Browse item with server application credentials. Returns API evidence for host verification and image inspection; does not save a listing or mark images inspected.",
    ebayItemSchema.shape,
    ebayItemResultSchema,
    (args, signal) => ebay.item(args, signal),
  );
  tool(
    "load_goodfinds_sample_workspace",
    "Load sample listings",
    "Load explicitly fictional Marketplace listings in an isolated sample workspace. Repeating the sample evaluation exercises suppression of unchanged alert previews. Does not search Facebook.",
    "load_sample_workspace",
  );
  tool(
    "import_goodfinds_listing_observations",
    "Track supplied Marketplace listings",
    "Save and evaluate supplied or browser-inspected listing observations using the marketplace-shopping skill's listing-evidence and observations references. Use canonical marketplace listing IDs/URLs, provenance manual, source excerpts and recorded observation times. Import discovery cards provisionally; verification needs inspected gallery images and seller videos, separate complete review records, and cached media IDs. Unknown facts remain unknown. Compare full outright asking prices, excluding finance, bids and deposits. Optional search_coverage records query scope, pagination and success/partial/failed evidence; missing listings never prove a sale. Worker imports include run_id and worker_id. Use a fresh request_id per batch and retry the same ID and arguments after an ambiguous response. The host agent performs browsing; this tool persists and evaluates its evidence.",
    "import_listing_observations",
  );
  const cacheSchema = z.object({ files: mediaFilesSchema }).strict();
  tool(
    "attach_goodfinds_listing_media",
    "Repair a saved listing gallery",
    "Attach cached photos/videos and capture totals to an existing listing without rechecking its price, availability, specifications or verification. Use for missing-media reconciliation; keeps independent durable capture receipts across later collector refreshes. Complete requires every observed file. Partial/unavailable preserves existing files. Does not mark images or videos reviewed.",
    "attach_listing_media",
  );
  const cacheCall = adapt(
    "cache_goodfinds_images",
    Effect.fn("cache_goodfinds_images")(function* (input: unknown) {
      const { files } = yield* validation(() => cacheSchema.parse(input));
      const backend = yield* Backend;
      const media = yield* backend.cacheImages(files);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ media }) }],
        structuredContent: { media },
      };
    }),
  );
  calls.set("cache_goodfinds_images", cacheCall);
  registerAppTool(
    server,
    "cache_goodfinds_images",
    {
      title: "Save search, listing and seller images",
      description:
        "Cache JPEG, PNG or WebP files already available on this device, including browser-downloaded photos, user-provided images and generated search illustrations. Returns media IDs for set_goodfinds_search_cover or for photos and seller_avatar_media_id in observations. Does not fetch remote URLs. Up to 20 files/50 MB per batch; 10 MB per image.",
      inputSchema: cacheSchema.shape,
      outputSchema: wireSchema(
        z.object({
          media: z.array(
            z.object({
              id: mediaIdSchema,
              mime_type: z.string(),
              size_bytes: z.number(),
              label: z.string(),
            }),
          ),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["model"] } },
    },
    (args, extra) => cacheCall(args, extra.signal),
  );
  const mediaCall = adapt(
    "cache_goodfinds_media",
    Effect.fn("cache_goodfinds_media")(function* (input: unknown) {
      const { files } = yield* validation(() => cacheSchema.parse(input));
      const backend = yield* Backend;
      const media = yield* backend.cacheMedia(files);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ media }) }],
        structuredContent: { media },
      };
    }),
  );
  calls.set("cache_goodfinds_media", mediaCall);
  registerAppTool(
    server,
    "cache_goodfinds_media",
    {
      title: "Save listing photos and videos",
      description:
        "Cache browser-downloaded JPEG, PNG, WebP, MP4 or WebM files already on this device. Attach IDs as photos or videos in observations; video poster_media_id must reference an image. No remote URLs are fetched. Up to 20 files/100 MB per batch; 10 MB per image and 50 MB per video. Failures stay partial, never invent media or treat a poster as a reviewed video.",
      inputSchema: cacheSchema.shape,
      outputSchema: wireSchema(
        z.object({
          media: z.array(
            z.object({
              id: mediaIdSchema,
              mime_type: z.string(),
              size_bytes: z.number(),
              label: z.string(),
            }),
          ),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["model"] } },
    },
    (args, extra) => mediaCall(args, extra.signal),
  );
  const imageSchema = z.object({ media_id: mediaIdSchema }).strict();
  const mediaFileCall = adapt(
    "get_goodfinds_media_file",
    Effect.fn("get_goodfinds_media_file")(function* (input: unknown) {
      const { media_id } = yield* validation(() => imageSchema.parse(input));
      const backend = yield* Backend;
      const media = yield* backend.readMediaFile(media_id);
      return {
        structuredContent: media,
        content: [{ type: "text" as const, text: JSON.stringify(media) }],
      };
    }),
  );
  calls.set("get_goodfinds_media_file", mediaFileCall);
  server.registerTool(
    "get_goodfinds_media_file",
    {
      title: "Open saved media in chat",
      description:
        "Resolve a saved listing photo or seller video to its verified local file, MIME type and size, without putting video bytes into the conversation. Use gallery IDs from get_goodfinds_listing. Local hosts can preview this file; hosts without local-file access can play it in the connected Goodfinds panel. Supports only managed cached media IDs; never accepts an arbitrary path or fetches a URL.",
      inputSchema: imageSchema.shape,
      outputSchema: wireSchema(
        z.object({
          media_id: mediaIdSchema,
          path: z.string(),
          mime_type: z.string(),
          size_bytes: z.number(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input, extra) => mediaFileCall(input, extra.signal),
  );
  const imageCall = adapt(
    "get_goodfinds_image",
    Effect.fn("get_goodfinds_image")(
      function* (input: unknown) {
        const { media_id } = yield* validation(() => imageSchema.parse(input));
        return { content: [yield* readSearchCover(media_id)] };
      },
      Effect.catchCause(() =>
        Effect.succeed<CallToolResult>({
          isError: true,
          content: [{ type: "text", text: "The saved image is unavailable." }],
        }),
      ),
    ),
  );
  calls.set("get_goodfinds_image", imageCall);
  registerAppTool(
    server,
    "get_goodfinds_image",
    {
      title: "View a saved image",
      description:
        "View one saved product, search or seller image by its media ID, in chat or the panel. Use IDs returned by get_goodfinds_listing or search context. The image alone does not establish inspection of the whole gallery.",
      inputSchema: imageSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    (args, extra) => imageCall(args, extra.signal),
  );
  const videoCall = adapt(
    "get_goodfinds_video",
    Effect.fn("get_goodfinds_video")(function* (input: unknown) {
      const { media_id } = yield* validation(() => imageSchema.parse(input));
      const backend = yield* Backend;
      return { content: [], structuredContent: yield* backend.readVideo(media_id) };
    }),
  );
  calls.set("get_goodfinds_video", videoCall);
  registerAppTool(
    server,
    "get_goodfinds_video",
    {
      title: "Read a saved video for the panel",
      outputSchema: wireSchema(
        z.object({ mime_type: z.enum(["video/mp4", "video/webm"]), data: z.string() }),
      ),
      description:
        "Read a cached MP4 or WebM by media ID on demand. Video bytes stay separate from listing state.",
      inputSchema: imageSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    (args, extra) => videoCall(args, extra.signal),
  );
  registerAppResource(
    server,
    "Goodfinds panel",
    PANEL_RESOURCE_URI,
    { description: "Search management and deal comparison on this device" },
    () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const backend = yield* Backend;
          return {
            contents: [
              {
                uri: PANEL_RESOURCE_URI,
                mimeType: RESOURCE_MIME_TYPE,
                text: yield* backend.panel,
                _meta: {
                  ui: {
                    prefersBorder: false,
                    permissions: { geolocation: {} },
                    csp: {
                      connectDomains: [
                        "https://ipwho.is",
                        "https://api.bigdatacloud.net",
                        "https://api.postcodes.io",
                        "https://api.zippopotam.us",
                      ],
                      resourceDomains: [],
                    },
                  },
                },
              },
            ],
          };
        }),
      ),
  );
  return { server, calls, effects, runtime };
}
