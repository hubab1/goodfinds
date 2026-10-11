import { z } from "zod";
import { feedbackEventSchema } from "./discovery.ts";
import { settingsSchema } from "./state.ts";
import { revisionSchema } from "./revisions.ts";
import { searchRunSchema, searchQuerySchema } from "./search-workflow.ts";
import { savedSearchSchema } from "./search-definition.ts";
import { workflowSchema } from "./workflow-schema.ts";
import { runtimeContextSchema } from "./runtime.ts";

export const recoveryInputShape = {
  run_id: z.uuid(),
  expected_context_revision: revisionSchema.optional(),
  feedback_offset: z.number().int().nonnegative().default(0),
  expected_version: z.number().int().nonnegative().optional(),
  query_offset: z.number().int().nonnegative().default(0),
  listing_offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
  include_brief: z.boolean().default(true),
};
export const searchRecoverySchema = z.object({
  run: searchRunSchema.omit({ queries: true, listing_keys: true, verified_keys: true }),
  brief: savedSearchSchema.nullable(),
  context_revision: revisionSchema,
  settings: settingsSchema.nullable(),
  feedback: z.array(feedbackEventSchema),
  next_feedback_offset: z.number().int().nullable(),
  brief_included: z.boolean(),
  search_current: z.boolean(),
  brief_revision: z.string(),
  workflow: workflowSchema,
  runtime: runtimeContextSchema,
  unfinished_queries: z.array(searchQuerySchema),
  pending_verification: z.array(z.string()),
  coverage: z.object({
    queries: z.number().int(),
    completed: z.number().int(),
    skipped: z.number().int(),
    unfinished: z.number().int(),
    discovered: z.number().int(),
    verified: z.number().int(),
    pending_verification: z.number().int(),
  }),
  next_query_offset: z.number().int().nullable(),
  next_listing_offset: z.number().int().nullable(),
  references: z.array(z.string()),
});
