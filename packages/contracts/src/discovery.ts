import { z } from "zod";
import { queryDefinitionSchema } from "./search-workflow.ts";
import { verificationDefinitionSchema } from "./verification.ts";

const attribute = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u)
  .refine((s) => !["constructor", "prototype"].includes(s));
export const discoverySchema = z
  .object({
    scope: z.enum(["exact", "alternatives", "help_choose"]),
    reference_model: z.string().trim().min(1).max(200).optional(),
    model_attribute: attribute.default("model"),
    category_terms: z.array(z.string().trim().min(1).max(300)).min(1).max(10).optional(),
    query_plan: z.array(queryDefinitionSchema).max(20).optional(),
    verification_checks: z.array(verificationDefinitionSchema).max(30).optional(),
    model_aliases: z
      .array(
        z
          .object({
            canonical: z.string().trim().min(1).max(200),
            aliases: z.array(z.string().trim().min(1).max(200)).max(20),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    research: z
      .object({
        summary: z.string().trim().min(1).max(5000),
        checked_at: z.iso.datetime(),
        sources: z
          .array(
            z
              .object({
                url: z.url().refine((s) => s.startsWith("https://")),
                title: z.string().max(200),
              })
              .strict(),
          )
          .min(1)
          .max(30),
        queries: z.array(z.string().trim().min(1).max(300)).max(20),
        candidates: z
          .array(
            z
              .object({
                model: z.string().trim().min(1).max(200),
                capabilities: z.record(
                  attribute,
                  z.union([z.string().max(500), z.number(), z.boolean()]),
                ),
                tradeoffs: z.string().max(1000),
                uncertainty: z.string().max(1000),
              })
              .strict(),
          )
          .max(30),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "exact" && !value.reference_model)
      ctx.addIssue({ code: "custom", message: "Exact model searches need a model" });
  });
export const feedbackInputSchema = z
  .object({
    search_id: z.string(),
    listing_key: z.string(),
    action: z.enum(["shortlist", "dismiss", "more_like"]),
    reason: z.string().trim().max(1000).optional(),
    scope: z.enum(["search", "category", "global"]).default("search"),
    exclude_model: z.boolean().optional(),
    rule: z
      .object({
        attribute,
        operator: z.enum(["eq", "neq", "gte", "lte"]),
        value: z.union([z.string().min(1).max(500), z.number(), z.boolean()]),
        importance: z.enum(["required", "preferred"]),
        label: z.string().trim().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.exclude_model && (value.action !== "dismiss" || !value.reason))
      ctx.addIssue({
        code: "custom",
        message: "Model exclusion needs an explicit dismissal reason",
      });
    if (value.rule && !value.reason)
      ctx.addIssue({
        code: "custom",
        message: "An explicit preference needs the buyer's original reason",
      });
  });
export const feedbackEventSchema = feedbackInputSchema.extend({
  id: z.string(),
  category: z.string(),
  created_at: z.iso.datetime(),
  undone: z.boolean(),
});
export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;
export function appliesToSearch(
  event: FeedbackEvent,
  search: { id: string; product: string },
): boolean {
  return (
    !event.undone &&
    (event.scope === "global" ||
      (event.scope === "category" && event.category === search.product) ||
      event.search_id === search.id)
  );
}

export {
  modelIdentity,
  verifiedModel,
  modelExclusionRule,
  excludedModels,
  modelIsExcluded,
} from "./model-feedback.ts";
