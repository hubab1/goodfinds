import { z } from "zod";
import { excludedModels, modelIdentity } from "./model-feedback.ts";
import type { FeedbackEvent } from "./discovery.ts";
import { searchPhases, activeSearchPhases, resumableSearchPhases } from "./search-run-model.ts";
import { marketplaceSchema } from "./integrations.ts";
import { workerExecutionSchema } from "./worker-execution.ts";

export const queryDefinitionSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    purpose: z.enum(["exact", "alias", "brand", "category", "feature", "alternative"]),
  })
  .strict();
export const searchQuerySchema = queryDefinitionSchema
  .extend({
    id: z.string().min(1).max(100),
    marketplace: marketplaceSchema,
    status: z.enum(["planned", "running", "completed", "skipped", "failed"]).default("planned"),
    result_count: z.number().int().nonnegative().nullable().default(null),
    unique_relevant_count: z.number().int().nonnegative().nullable().default(null),
    reason: z.string().trim().min(1).max(1000).nullable().default(null),
  })
  .refine(
    (query) => !["skipped", "failed"].includes(query.status) || query.reason !== null,
    "Skipped and failed queries need a reason",
  );
export const searchRunSchema = z
  .object({
    id: z.uuid(),
    search_id: z.string(),
    search_revision: z.string(),
    trigger: z.enum(["manual", "scheduled"]).default("manual"),
    scheduled_at: z.iso.datetime().nullable().default(null),
    version: z.number().int().nonnegative(),
    phase: z.enum(searchPhases),
    queries: z.array(searchQuerySchema).min(1).max(120),
    listing_keys: z.array(z.string()).max(10000),
    verified_keys: z.array(z.string()).max(10000),
    created_at: z.iso.datetime(),
    started_at: z.iso.datetime().nullable().optional(),
    updated_at: z.iso.datetime(),
    first_result_at: z.iso.datetime().nullable(),
    next_step: z.string().max(1000),
    interruption: z.string().max(2000).nullable(),
    worker: z
      .object({
        id: z.uuid(),
        agent_id: z.string().trim().min(1).max(200),
        parent_thread_id: z.string().trim().min(1).max(200).nullable(),
        claimed_at: z.iso.datetime(),
        last_heartbeat_at: z.iso.datetime(),
        lease_expires_at: z.iso.datetime(),
        execution: workerExecutionSchema.optional(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type SearchRun = z.infer<typeof searchRunSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export const ACTIVE_SEARCH_PHASES = activeSearchPhases;
export const RESUMABLE_SEARCH_PHASES = resumableSearchPhases;

type SearchBrief = {
  id: string;
  product: string;
  definition: { title: string };
  marketplaces?: z.infer<typeof marketplaceSchema>[] | undefined;
  discovery?:
    | {
        model_attribute?: string | undefined;
        reference_model?: string | undefined;
        category_terms?: string[] | undefined;
        query_plan?: z.infer<typeof queryDefinitionSchema>[] | undefined;
        model_aliases?: { canonical: string; aliases: string[] }[] | undefined;
        research?: { queries: string[]; candidates: { model: string }[] } | undefined;
      }
    | undefined;
};
export function queryPlan(search: SearchBrief, feedback: FeedbackEvent[] = []): SearchQuery[] {
  const excluded = new Set(
    excludedModels(search, feedback).map((value) => modelIdentity(value, search)),
  );
  const reference = search.discovery?.reference_model;
  const category =
    search.discovery?.category_terms ??
    (["espresso_machine", "coffee_machine"].includes(search.product)
      ? ["coffee machine", "espresso machine"]
      : [search.product.replaceAll("_", " ")]);
  const definitions: z.infer<typeof queryDefinitionSchema>[] = [
    ...(reference ? [{ text: reference, purpose: "exact" as const }] : []),
    ...category.map((text) => ({ text, purpose: "category" as const })),
    ...(search.discovery?.model_aliases ?? []).flatMap((entry) =>
      entry.aliases.map((text) => ({ text, purpose: "alias" as const })),
    ),
    ...(search.discovery?.query_plan ?? []),
    ...(search.discovery?.research?.queries ?? []).map((text) => ({
      text,
      purpose: "feature" as const,
    })),
    ...(search.discovery?.research?.candidates ?? []).map(({ model }) => ({
      text: model,
      purpose: "alternative" as const,
    })),
  ];
  const seen = new Set<string>();
  return (search.marketplaces ?? ["facebook_marketplace"])
    .flatMap((marketplace) =>
      definitions
        .flatMap((definition, index) => {
          if (
            definition.purpose !== "category" &&
            excluded.has(modelIdentity(definition.text, search))
          )
            return [];
          const key = `${marketplace}:${definition.text.trim().toLowerCase().replace(/\s+/gu, " ")}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [
            searchQuerySchema.parse({ ...definition, id: `${marketplace}-${index}`, marketplace }),
          ];
        })
        .slice(0, 20),
    )
    .slice(0, 120);
}
export function searchProgress(run: SearchRun) {
  return {
    checked_queries: run.queries.filter((query) => query.status === "completed").length,
    total_queries: run.queries.length,
    discovered: run.listing_keys.length,
    verified: run.verified_keys.length,
    category_checked: run.queries.some(
      (query) => query.purpose === "category" && query.status === "completed",
    ),
    first_result_seconds:
      run.first_result_at === null
        ? null
        : (Date.parse(run.first_result_at) - Date.parse(run.created_at)) / 1000,
  };
}

export const searchCommands = {
  start: z
    .object({
      search_id: z.string(),
      request_id: z.uuid(),
      resume: z.boolean().default(true),
      trigger: z.enum(["manual", "scheduled"]).default("manual"),
    })
    .strict(),
  update: z
    .object({
      run_id: z.uuid(),
      expected_version: z.number().int().nonnegative(),
      phase: searchRunSchema.shape.phase.optional(),
      query: searchQuerySchema.optional(),
      add_queries: z.array(searchQuerySchema).max(20).optional(),
      next_step: z.string().max(1000).optional(),
      interruption: z.string().max(2000).nullable().optional(),
      worker_id: z.uuid().optional(),
    })
    .strict(),
  claim: z
    .object({
      run_id: z.uuid(),
      expected_version: z.number().int().nonnegative(),
      worker_id: z.uuid(),
      agent_id: z.string().trim().min(1).max(200),
      parent_thread_id: z.string().trim().min(1).max(200).optional(),
      execution: workerExecutionSchema.optional(),
    })
    .strict(),
  heartbeat: z.object({ run_id: z.uuid(), worker_id: z.uuid() }).strict(),
  cancel: z.object({ run_id: z.uuid() }).strict(),
};
