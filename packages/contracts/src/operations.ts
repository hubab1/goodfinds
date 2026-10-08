import { operationNames, isOperationName } from "./tool-names.ts";
export { operationForTool, isOperationName } from "./tool-names.ts";
import {
  workflowSchema,
  sellerWorkflowSchema,
  listingWorkflowSchema,
  blockerSchema,
} from "./workflow-schema.ts";
export { workflowSchema } from "./workflow-schema.ts";
import { z } from "zod";
import {
  dispatcherContextInputSchema,
  dispatcherSummarySchema,
  dispatcherPlanSchema,
  dispatcherRecordSchema,
  dispatcherReportSchema,
  scheduledBatchSchema,
  scheduledBatchOutputSchema,
} from "./scheduled-dispatch.ts";
import { listingSeenInputSchema } from "./listing-reading.ts";
import { modeSchema, settingsSchema, stateSchema, listingSchema } from "./state.ts";
import {
  searchInputSchema,
  draftInputSchema,
  savedSearchSchema,
  savedDraftSchema,
} from "./search-definition.ts";
import { searchCoverSchema, searchCoverFollowUpSchema } from "./search-cover.ts";
import { searchCommands, searchRunSchema } from "./search-workflow.ts";
import {
  monitoringPreferenceSchema,
  hostScheduleReportSchema,
  monitoringSummarySchema,
} from "./monitoring.ts";
import { accessReportSchema, sessionReportSchema } from "./integrations.ts";
import { listingContactReportSchema } from "./marketplace-actions.ts";
import { feedbackInputSchema, feedbackEventSchema } from "./discovery.ts";
import { journeyReportSchema } from "./journeys.ts";
import { listingQuerySchema } from "./listing-query.ts";
import { listingMediaInput } from "./listing-media.ts";
import { sellerCommands, conversationSchema, sellerActionSchema } from "./seller-conversation.ts";
import { connectionCheckObservationSchema } from "./connection-checks.ts";
import { revisionSchema, revisionsSchema } from "./revisions.ts";
const mode = modeSchema.default("live");
const expected_entity_revision = revisionSchema;
export const receiptSchema = z.object({
  request_id: z.uuid(),
  operation: z.string(),
  replayed: z.boolean(),
  committed_at: z.iso.datetime(),
});
export const executionSchema = z.object({
  action_id: z.string(),
  lease_token: z.string().nullable(),
  send_permitted: z.boolean(),
  reconcile_required: z.boolean(),
});
const common = {
  mode: modeSchema,
  revision: revisionSchema,
  revisions: revisionsSchema,
  receipt: receiptSchema.optional(),
};
export const stateSummarySchema = z
  .object({
    mode: modeSchema,
    revision: revisionSchema,
    access_context: z.string(),
    counts: stateSchema.shape.counts,
    searches: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        qualified_count: z.number(),
        tracked_count: z.number(),
        found_count: stateSchema.shape.searches.element.shape.found_count,
        unseen_count: stateSchema.shape.searches.element.shape.unseen_count,
        seen_count: stateSchema.shape.searches.element.shape.seen_count,
        last_searched_at: stateSchema.shape.searches.element.shape.last_searched_at,
        latest_found_at: stateSchema.shape.searches.element.shape.latest_found_at,
      }),
    ),
    search_runs: z.array(
      z.object({ id: z.uuid(), version: z.number(), phase: searchRunSchema.shape.phase }).loose(),
    ),
  })
  .loose();
export const errorSchema = z.object({
  code: z.enum([
    "validation_error",
    "revision_conflict",
    "missing_search",
    "storage_error",
    "media_error",
    "transport_error",
    "cancelled",
    "internal_error",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  current_revision: revisionSchema.optional(),
  resource: z.string().optional(),
  recovery: z.string(),
  blockers: z.array(blockerSchema).optional(),
});
const errorResult = { error: errorSchema.optional() };
const stateOutput = z.object({ ...common, ...errorResult, state: stateSummarySchema.optional() });
export function wireSchema<O extends z.ZodRawShape>(output: z.ZodObject<O>) {
  const success = z.toJSONSchema(output);
  return output
    .partial()
    .extend({ error: errorSchema.optional() })
    .meta({ anyOf: [{ required: success.required ?? [] }, { required: ["error"] }] })
    .superRefine((value, ctx) => {
      const record: Record<string, unknown> = value;
      const parsed = record["error"]
        ? errorSchema.safeParse(record["error"])
        : output.safeParse(value);
      if (!parsed.success) ctx.addIssue({ code: "custom", message: "Invalid operation result" });
    });
}
function command<S extends z.ZodRawShape, O extends z.ZodRawShape>(
  names: readonly string[],
  shape: S,
  output: z.ZodObject<O>,
  readOnly = false,
  destructive = false,
) {
  return {
    names,
    kind: "command" as const,
    input: z
      .object({
        context_id: z.string().optional(),
        request_id: z.uuid().optional(),
        expected_entity_revision: revisionSchema.optional(),
        expected_draft_revision: revisionSchema.optional(),
      })
      .extend(shape)
      .strict(),
    output: output.extend(errorResult),
    wire: wireSchema(output),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
  };
}
function query<S extends z.ZodRawShape, O extends z.ZodRawShape>(
  names: readonly string[],
  shape: S,
  output: z.ZodObject<O>,
) {
  return {
    names,
    kind: "query" as const,
    input: z.object({ mode }).extend(shape).strict(),
    output: output.extend(errorResult),
    wire: wireSchema(output),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}
const searchOutput = z.object({
  ...common,
  search: savedSearchSchema.nullable(),
  cover_follow_up: searchCoverFollowUpSchema.nullable().optional(),
  monitoring: z.array(monitoringSummarySchema),
  removed_search_id: z.string().optional(),
});
const draftOutput = z.object({
  ...common,
  draft: savedDraftSchema.nullable(),
  removed_draft_id: z.string().optional(),
});
const settingsOutput = z.object({ ...common, settings: settingsSchema });
const evidenceOutput = z.object({
  ...common,
  access_context: z.string(),
  evidence: z.object({
    browser_access: stateSchema.shape.config.shape.browser_access,
    platform_sessions: stateSchema.shape.config.shape.platform_sessions,
    listing_contacts: stateSchema.shape.config.shape.listing_contacts,
  }),
});
const feedbackOutput = z.object({ ...common, feedback: feedbackEventSchema.nullable() });
const runOutput = z.object({
  ...common,
  search_run: searchRunSchema.nullable(),
  workflow: workflowSchema,
  scheduled_check: z.object({ allowed: z.boolean() }).loose().optional(),
});
const sellerOutput = z.object({
  ...common,
  conversation: conversationSchema,
  workflow: sellerWorkflowSchema,
  execution: executionSchema.optional(),
});
const sellerMutationOutput = sellerOutput.extend({
  conversation: conversationSchema
    .omit({ messages: true, events: true, actions: true })
    .extend({ pending_action: sellerActionSchema.nullable() }),
});
const importOutput = z.object({
  ...common,
  import_receipt: z.object({ evaluation_id: z.string(), observed_count: z.number() }),
  search_run: searchRunSchema.nullable(),
  workflow: workflowSchema,
});

function seller_conversation<S extends z.ZodRawShape, O extends z.ZodRawShape>(
  names: readonly string[],
  shape: S,
  output: z.ZodObject<O>,
  readOnly = false,
  destructive = false,
) {
  return {
    names,
    kind: "command" as const,
    input: z.object(shape).strict(),
    output,
    wire: wireSchema(output),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
  };
}

export const operations = {
  get_workspace: command(operationNames.get_workspace, { mode }, stateOutput, true, false),
  get_settings: query(
    operationNames.get_settings,
    {},
    z
      .object({
        revision: revisionSchema,
        revisions: revisionsSchema,
        access_context: z.string(),
        settings: settingsSchema.loose(),
      })
      .loose(),
  ),
  list_activity: query(
    operationNames.list_activity,
    {
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    z.object({
      activity: stateSchema.shape.activity,
      total: z.number(),
      next_offset: z.number().nullable(),
      monitoring: z.array(monitoringSummarySchema),
    }),
  ),
  get_monitoring: query(
    operationNames.get_monitoring,
    {},
    z.object({ revision: revisionSchema, monitoring: z.array(monitoringSummarySchema) }),
  ),
  list_next_steps: query(
    operationNames.list_next_steps,
    {
      search_id: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(5),
    },
    z
      .object({
        actions: stateSchema.shape.next_steps,
        total: z.number(),
        next_offset: z.number().nullable(),
        fulfilled_searches: z.array(z.string()),
      })
      .loose(),
  ),
  prepare_next_steps: command(
    operationNames.prepare_next_steps,
    {
      mode,
      search_id: z.string(),
      run_id: z.uuid().optional(),
    },
    z.object({ ...common, actions: stateSchema.shape.next_steps }),
    false,
    false,
  ),
  get_search_context: query(
    operationNames.get_search_context,
    { search_id: z.string().optional() },
    z
      .object({
        revision: revisionSchema,
        revisions: revisionsSchema,
        access_context: z.string(),
        searches: z.array(
          savedSearchSchema.extend({
            unseen_count: stateSchema.shape.searches.element.shape.unseen_count,
            seen_count: stateSchema.shape.searches.element.shape.seen_count,
            last_searched_at: stateSchema.shape.searches.element.shape.last_searched_at,
            latest_found_at: stateSchema.shape.searches.element.shape.latest_found_at,
            found_count: stateSchema.shape.searches.element.shape.found_count,
          }),
        ),
        cover_follow_ups: z.array(searchCoverFollowUpSchema),
        dispatchers: z.array(dispatcherSummarySchema).default([]),
        drafts: z.array(savedDraftSchema),
        search_runs: z.array(searchRunSchema.loose()),
        search_workflows: z.record(z.string(), workflowSchema),
        search_run_workflows: z.record(z.string(), workflowSchema),
        monitoring: z.array(monitoringSummarySchema),
      })
      .loose(),
  ),
  list_journey_checks: query(
    operationNames.list_journey_checks,
    {
      search_id: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    z.object({
      origin_key: z.string(),
      enabled: z.boolean(),
      origin_confirmed: z.boolean(),
      checks: z.array(
        z.object({
          destination: z.string(),
          country: z.string().nullable(),
          listing_keys: z.array(z.string()),
          maps_url: z.url(),
        }),
      ),
      total: z.number(),
      next_offset: z.number().nullable(),
    }),
  ),
  record_journey_check: command(
    operationNames.record_journey_check,
    { mode, report: journeyReportSchema },
    stateOutput,
    false,
    false,
  ),
  set_listing_seen: command(
    operationNames.set_listing_seen,
    { mode, ...listingSeenInputSchema.shape },
    z.object({
      ...common,
      searches: stateSummarySchema.shape.searches,
      listings: z.array(
        z.object({ key: z.string(), seen_in_searches: listingSchema.shape.seen_in_searches }),
      ),
    }),
  ),
  list_listings: query(
    operationNames.list_listings,
    { ...listingQuerySchema.shape, search_id: z.string().optional() },
    z.object({
      listings: z.array(
        z
          .object({
            key: z.string(),
            title: z.string(),
            url: z.string(),
            saved_photos: z.number(),
            saved_videos: z.number(),
            search_matches: z.array(
              z
                .object({ search_id: z.string(), status: z.string(), reasons: z.array(z.string()) })
                .loose(),
            ),
          })
          .loose(),
      ),
      total: z.number(),
      next_offset: z.number().nullable(),
    }),
  ),
  get_listing: query(
    operationNames.get_listing,
    { listing_key: z.string(), search_id: z.string().optional() },
    z
      .object({ listing: stateSchema.shape.listings.element, workflow: listingWorkflowSchema })
      .loose(),
  ),
  list_media_repairs: query(
    operationNames.list_media_repairs,
    {
      search_id: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
    z
      .object({
        listings: z.array(z.object({ listing_key: z.string() }).loose()),
        total: z.number(),
        next_offset: z.number().nullable(),
      })
      .loose(),
  ),
  check_scheduled_search: query(
    operationNames.check_scheduled_search,
    { search_id: z.string() },
    z.object({ allowed: z.boolean() }).loose(),
  ),
  get_dispatcher_context: query(
    operationNames.get_dispatcher_context,
    dispatcherContextInputSchema.shape,
    z
      .object({
        revision: revisionSchema,
        revisions: revisionsSchema,
        plan: dispatcherPlanSchema,
        dispatcher: dispatcherRecordSchema.nullable(),
        dispatchers: z.array(dispatcherSummarySchema),
      })
      .loose(),
  ),
  request_scheduled_batch: command(
    operationNames.request_scheduled_batch,
    { mode, ...scheduledBatchSchema.shape },
    z.object({ ...common, batch: scheduledBatchOutputSchema }),
    false,
    false,
  ),
  report_dispatcher_schedule: command(
    operationNames.report_dispatcher_schedule,
    { mode, expected_entity_revision, report: dispatcherReportSchema },
    z.object({ ...common, dispatchers: z.array(dispatcherSummarySchema) }),
    false,
    false,
  ),
  list_search_runs: query(
    operationNames.list_search_runs,
    {
      search_id: z.string().optional(),
      progress_only: z.boolean().default(false),
    },
    z.object({
      search_runs: z.array(
        z.object({ id: z.uuid(), version: z.number(), phase: searchRunSchema.shape.phase }).loose(),
      ),
      search_run_workflows: z.record(z.string(), workflowSchema),
    }),
  ),
  request_search_run: command(
    operationNames.request_search_run,
    { mode, request: searchCommands.start },
    runOutput,
    false,
    false,
  ),
  claim_search_run: command(
    operationNames.claim_search_run,
    { mode, request: searchCommands.claim },
    runOutput,
    false,
    false,
  ),
  renew_search_lease: command(
    operationNames.renew_search_lease,
    { mode, request: searchCommands.heartbeat },
    runOutput,
    false,
    false,
  ),
  cancel_search_run: command(
    operationNames.cancel_search_run,
    { mode, request: searchCommands.cancel },
    runOutput,
    false,
    false,
  ),
  update_search_run: command(
    operationNames.update_search_run,
    { mode, request: searchCommands.update },
    runOutput,
    false,
    false,
  ),
  save_search: command(
    operationNames.save_search,
    {
      mode,
      expected_entity_revision,
      search: z.union([searchInputSchema, savedSearchSchema]),
      draft_id: z.string().optional(),
    },
    searchOutput,
    false,
    true,
  ),
  set_search_cover: command(
    operationNames.set_search_cover,
    {
      mode,
      expected_entity_revision,
      search_id: z.string(),
      cover: searchCoverSchema.nullable(),
    },
    searchOutput,
    false,
    true,
  ),
  save_search_draft: command(
    operationNames.save_search_draft,
    { mode, expected_entity_revision, draft: draftInputSchema },
    draftOutput,
    false,
    true,
  ),
  discard_search_draft: command(
    operationNames.discard_search_draft,
    { mode, expected_entity_revision, draft_id: z.string() },
    draftOutput,
    false,
    true,
  ),
  set_monitoring: command(
    operationNames.set_monitoring,
    { mode, expected_entity_revision, monitoring: monitoringPreferenceSchema },
    searchOutput,
    false,
    true,
  ),
  report_host_schedule: command(
    operationNames.report_host_schedule,
    { mode, expected_entity_revision, report: hostScheduleReportSchema },
    searchOutput,
    false,
    false,
  ),
  set_search_enabled: command(
    operationNames.set_search_enabled,
    {
      mode,
      expected_entity_revision,
      search_id: z.string(),
      enabled: z.boolean(),
    },
    searchOutput,
    false,
    true,
  ),
  remove_search: command(
    operationNames.remove_search,
    { mode, expected_entity_revision, search_id: z.string() },
    searchOutput,
    false,
    true,
  ),
  save_settings: command(
    operationNames.save_settings,
    {
      mode,
      expected_entity_revision,
      settings: settingsSchema,
    },
    settingsOutput,
    false,
    true,
  ),
  report_browser_access: command(
    operationNames.report_browser_access,
    { mode, expected_entity_revision, context_id: z.string(), report: accessReportSchema },
    evidenceOutput,
    false,
    false,
  ),
  report_listing_contact: command(
    operationNames.report_listing_contact,
    { mode, expected_entity_revision, context_id: z.string(), report: listingContactReportSchema },
    evidenceOutput,
    false,
    false,
  ),
  report_marketplace_session: command(
    operationNames.report_marketplace_session,
    { mode, expected_entity_revision, context_id: z.string(), report: sessionReportSchema },
    evidenceOutput,
    false,
    false,
  ),
  record_listing_feedback: command(
    operationNames.record_listing_feedback,
    { mode, expected_entity_revision, feedback: feedbackInputSchema },
    feedbackOutput,
    false,
    false,
  ),
  undo_listing_feedback: command(
    operationNames.undo_listing_feedback,
    { mode, expected_entity_revision, feedback_id: z.string() },
    feedbackOutput,
    false,
    true,
  ),
  load_sample_workspace: command(
    operationNames.load_sample_workspace,
    { mode: z.literal("sample").default("sample") },
    stateOutput,
    false,
    true,
  ),
  import_listing_observations: command(
    operationNames.import_listing_observations,
    {
      mode: z.literal("live").default("live"),
      observations: z.array(z.record(z.string(), z.unknown())).max(500),
      run_id: z.uuid().optional(),
      worker_id: z.uuid().optional(),
      search_coverage: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
    },
    importOutput,
    false,
    false,
  ),
  attach_listing_media: command(
    operationNames.attach_listing_media,
    { mode, ...listingMediaInput.shape },
    z.object({
      ...common,
      listing_key: z.string(),
      media_capture: stateSchema.shape.listings.element.shape.media_capture,
      photos_count: z.number(),
      videos_count: z.number(),
    }),
    false,
    false,
  ),
  report_connections: command(
    operationNames.report_connections,
    {
      mode,
      expected_entity_revision,
      context_id: z.string(),
      reports: z.array(connectionCheckObservationSchema).min(1).max(6),
    },
    evidenceOutput,
  ),
  save_collection_plan: seller_conversation(
    operationNames.save_collection_plan,
    sellerCommands.plan.shape,
    sellerMutationOutput,
    false,
    true,
  ),
  prepare_collection_message: seller_conversation(
    operationNames.prepare_collection_message,
    sellerCommands.arrange.shape,
    sellerMutationOutput,
    false,
    true,
  ),
  get_seller_conversation: seller_conversation(
    operationNames.get_seller_conversation,
    sellerCommands.get.shape,
    sellerOutput,
    true,
    false,
  ),
  save_seller_message_draft: seller_conversation(
    operationNames.save_seller_message_draft,
    sellerCommands.save.shape,
    sellerMutationOutput,
    false,
    true,
  ),
  request_seller_action: seller_conversation(
    operationNames.request_seller_action,
    sellerCommands.request.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  report_seller_action_handoff: seller_conversation(
    operationNames.report_seller_action_handoff,
    sellerCommands.handoff.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  cancel_seller_action: seller_conversation(
    operationNames.cancel_seller_action,
    sellerCommands.cancel.shape,
    sellerMutationOutput,
    false,
    true,
  ),
  claim_seller_action: seller_conversation(
    operationNames.claim_seller_action,
    sellerCommands.claim.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  issue_message_send_permit: seller_conversation(
    operationNames.issue_message_send_permit,
    sellerCommands.prepare.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  report_seller_action_result: seller_conversation(
    operationNames.report_seller_action_result,
    sellerCommands.complete.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  record_user_reported_message: seller_conversation(
    operationNames.record_user_reported_message,
    sellerCommands.manual.shape,
    sellerMutationOutput,
    false,
    false,
  ),
  correct_reply_interpretation: seller_conversation(
    operationNames.correct_reply_interpretation,
    sellerCommands.correct.shape,
    sellerMutationOutput,
    false,
    true,
  ),
  set_buying_outcome: seller_conversation(
    operationNames.set_buying_outcome,
    sellerCommands.outcome.shape,
    sellerMutationOutput,
    false,
    true,
  ),
} as const;
export type OperationName = keyof typeof operations;
export type CommandName = {
  [K in OperationName]: (typeof operations)[K]["kind"] extends "command" ? K : never;
}[OperationName];
export type QueryName = Exclude<OperationName, CommandName>;
export type CommandArguments = z.input<(typeof operations)[CommandName]["input"]>;
export type OperationInput<K extends OperationName> = z.input<(typeof operations)[K]["input"]>;
export type OperationResult<K extends OperationName> = z.output<(typeof operations)[K]["output"]>;
export function parseOperation<K extends OperationName>(
  name: K,
  input: unknown,
): z.output<(typeof operations)[K]["input"]> {
  const args = input;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The selected schema validates this operation's precise input type.
  return operations[name].input.parse(args) as z.output<(typeof operations)[K]["input"]>;
}

export function isCommandName(name: string): name is CommandName {
  return isOperationName(name) && operations[name].kind === "command";
}
