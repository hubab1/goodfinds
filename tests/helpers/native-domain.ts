import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { z } from "zod";
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { answerSchema } from "@goodfinds/contracts/search-definition";
import type { SearchField } from "@goodfinds/contracts/search-definition";
import {
  workspaceConfigurationSchema,
  listingObservationSchema,
} from "@goodfinds/contracts/workspace-schema";
import type {
  ListingObservation,
  WorkspaceConfiguration,
} from "@goodfinds/contracts/workspace-schema";
import { stateSchema } from "@goodfinds/contracts/state";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { nativeCall, nativeEffect, nativeBinary } from "./native-driver.ts";
export * from "@goodfinds/contracts/workspace-schema";
export const DAY = 86_400_000;
export const SEARCH_LEASE_MS = 300_000;
export const NO_PREFERENCE = "__no_preference__",
  NOT_SURE = "__not_sure__",
  CUSTOM = "__custom__";
export const iso = (time: number) => new Date(time).toISOString();
export const hash = (args: unknown) => z.string().parse(nativeCall({ op: "hash", args }));
export const validateConfiguration = (args: unknown) =>
  nativeEffect({ op: "validate_config", args }).pipe(
    Effect.map((v) => workspaceConfigurationSchema.parse(v)),
  );
export const normalize = (args: unknown, demo: boolean, now: number) =>
  nativeEffect({ op: "normalize", args, demo, now }).pipe(
    Effect.map((v) => listingObservationSchema.parse(v)),
  );
export const normalizeObservations = (args: unknown, demo: boolean, now: number) =>
  nativeEffect({ op: "normalize_observations", args, demo, now }).pipe(
    Effect.map((v) => z.array(listingObservationSchema).parse(v)),
  );
export const nativeQuestion = (field: SearchField, custom = false) =>
  ElicitRequestFormParamsSchema.parse(
    nativeCall({ op: "native_question", args: { field, custom } }),
  );
export const nativeAnswer = (
  field: SearchField,
  content: Record<string, unknown>,
  custom = false,
) => answerSchema.parse(nativeCall({ op: "native_answer", args: { field, content, custom } }));
const reasons = z.object({
  rejected: z.array(z.string()),
  uncertain: z.array(z.string()),
  preferences: z.array(z.string()),
});
export function criteria(
  row: ListingObservation,
  search: SavedSearch,
  budget = true,
  now = Date.now(),
): [string[], string[], string[]] {
  const v = reasons.parse(nativeCall({ op: "criteria", args: { row, search, budget, now } }));
  return [v.rejected, v.uncertain, v.preferences];
}
export function learnedCriteria(
  row: ListingObservation,
  search: SavedSearch,
  config: WorkspaceConfiguration,
  budget: boolean,
): [string[], string[], number] {
  const v = reasons
    .omit({ preferences: true })
    .extend({ score: z.number() })
    .parse(nativeCall({ op: "learned_criteria", args: { row, search, config, budget } }));
  return [v.rejected, v.uncertain, v.score];
}
export const searchCohort = (row: ListingObservation, search: SavedSearch) =>
  z
    .string()
    .nullable()
    .parse(nativeCall({ op: "search_cohort", args: { row, search } }));
export function matchListing(
  row: ListingObservation,
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  demo: boolean,
  budget = true,
): [string, string[]] {
  const v = z
    .object({ status: z.string(), reasons: z.array(z.string()) })
    .parse(nativeCall({ op: "match_listing", args: { row, search, config, now, demo, budget } }));
  return [v.status, v.reasons];
}
const evaluation = stateSchema.shape.decisions.element
  .omit({ search_id: true, search_name: true })
  .extend({
    quality: listingObservationSchema.shape.quality.unwrap(),
    preferences: z.array(z.string()),
    credibility: z.object({ status: z.string(), reasons: z.array(z.string()) }).loose(),
  });
export const evaluateListing = (
  row: ListingObservation,
  pool: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  demo = false,
) =>
  evaluation.parse(
    nativeCall({ op: "evaluate_listing", args: { row, pool, search, config, now, demo } }),
  );
export const ruleHash = (search: SavedSearch, config: WorkspaceConfiguration) =>
  z.string().parse(nativeCall({ op: "rule_hash", args: { search, config } }));
export const connect = (path: string) =>
  Effect.try(() => {
    nativeCall({ op: "initialize", path });
    return new Database(path);
  });
export const evaluateObservations = (
  config: unknown,
  observations: unknown,
  path: string,
  demo = false,
  now = Date.now(),
  coverage: unknown = null,
  _connection?: Database,
) =>
  nativeEffect({
    op: "evaluate",
    path,
    mode: demo ? "sample" : "live",
    args: { config, observations, coverage },
    now,
  });
export const cacheImages = (root: string, files: { path: string; label: string }[]) =>
  nativeEffect({ op: "cache_images", root, args: files }).pipe(
    Effect.map((v) =>
      z
        .array(
          z.object({
            id: z.string(),
            mime_type: z.string(),
            size_bytes: z.number(),
            label: z.string(),
          }),
        )
        .parse(v),
    ),
  );
export const readImage = (root: string, id: string) =>
  nativeEffect({ op: "read_image", root, args: { id } }).pipe(
    Effect.map((v) => z.object({ data: z.string(), mimeType: z.string() }).parse(v)),
  );
export const runCli = (args: string[]) =>
  Effect.try({
    try: () => {
      const r = spawnSync(nativeBinary, args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    },
    catch: (e) => e,
  });
