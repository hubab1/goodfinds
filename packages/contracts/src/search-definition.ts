import { z } from "zod";
import { marketplaceSchema } from "./integrations.ts";
import { discoverySchema } from "./discovery.ts";
import { searchCoverSchema } from "./search-cover.ts";
import templates from "../data/search-templates.json" with { type: "json" };

export const SEARCH_NAME_GUIDANCE =
  "Use a short product, model or category name for search names and definition titles. Store budgets and price ranges in values. Preserve a custom name when the buyer explicitly requests that name.";
const searchNameSchema = z.string().trim().min(1).max(80).describe(SEARCH_NAME_GUIDANCE);

const key = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((value) => !["constructor", "prototype"].includes(value), "Choose a different field ID");
const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
export const answerSchema = z.union([
  scalar,
  z.array(z.string().max(500)).max(30),
  z.object({ min: z.number().optional(), max: z.number().optional() }).strict(),
  z.null(),
]);
export const answersSchema = z.record(key, answerSchema);
export type Answers = z.infer<typeof answersSchema>;
export type Answer = z.infer<typeof answerSchema>;

export const fieldSchema = z
  .object({
    id: key,
    decision_id: key.optional(),
    allow_unsure: z.boolean().optional(),
    label: z.string().trim().min(1).max(120),
    type: z.enum([
      "text",
      "location",
      "integer",
      "number",
      "boolean",
      "single_choice",
      "multiple_choice",
      "range",
    ]),
    required: z.boolean().default(false),
    question_stage: z.enum(["setup", "refinement"]).optional(),
    hint: z.string().max(500).optional(),
    unit: z.string().max(30).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    display_divisor: z.union([z.literal(1), z.literal(100)]).optional(),
    options: z
      .array(z.object({ value: scalar, label: z.string().trim().min(1).max(120) }).strict())
      .min(1)
      .max(30)
      .optional(),
    visible_when: z
      .object({ field: key, one_of: z.array(scalar).min(1).max(30) })
      .strict()
      .optional(),
    match: z
      .object({
        attribute: key,
        operator: z.enum(["eq", "gte", "lte", "in", "contains_any", "range"]),
        importance: z.enum(["required", "preferred"]).default("required"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SearchField = z.infer<typeof fieldSchema>;

export const searchDefinitionSchema = z
  .object({
    schema_version: z.literal(1),
    version: z.number().int().min(1).max(100000),
    category: key,
    title: searchNameSchema,
    description: z.string().max(500),
    price: z
      .object({
        currency: z.enum(["GBP", "USD", "EUR", "CAD", "AUD", "NZD", "JPY"]),
        period: z.enum(["once", "month", "week"]),
      })
      .strict(),
    comparison_attributes: z.array(key).min(1).max(16),
    fields: z.array(fieldSchema).min(1).max(30),
  })
  .strict()
  .superRefine((definition, context) => {
    const seen = new Set<string>();
    const decisions = new Set<string>();
    for (const field of definition.fields) {
      if (field.decision_id) {
        if (decisions.has(field.decision_id))
          context.addIssue({
            code: "custom",
            message: "Questions must resolve distinct decisions",
          });
        decisions.add(field.decision_id);
      }
      if (seen.has(field.id))
        context.addIssue({ code: "custom", message: "Field IDs must be unique" });
      if (field.visible_when && !seen.has(field.visible_when.field))
        context.addIssue({
          code: "custom",
          message: "Conditional fields must refer to an earlier field",
        });
      seen.add(field.id);
      if (field.required && field.question_stage === "refinement")
        context.addIssue({
          code: "custom",
          message: `${field.label}: required answers belong in setup`,
        });
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      )
        context.addIssue({ code: "custom", message: `${field.label}: minimum exceeds maximum` });
      if (["single_choice", "multiple_choice"].includes(field.type) && !field.options)
        context.addIssue({ code: "custom", message: `${field.label} needs choices` });
      if (field.options) {
        if (["text", "location", "range"].includes(field.type))
          context.addIssue({
            code: "custom",
            message: `${field.label}: use a choice field for options`,
          });
        if (
          field.type === "boolean" &&
          field.options.some((option) => typeof option.value !== "boolean")
        )
          context.addIssue({ code: "custom", message: "Boolean choices must use true or false" });
        const values = field.options.map((option) => JSON.stringify(option.value));
        if (
          new Set(values).size !== values.length ||
          field.options.some(
            (option) => typeof option.value === "string" && option.value.startsWith("__"),
          )
        )
          context.addIssue({
            code: "custom",
            message: `${field.label} needs unique, nonreserved choices`,
          });
        if (
          field.type === "multiple_choice" &&
          field.options.some((option) => typeof option.value !== "string")
        )
          context.addIssue({ code: "custom", message: "Multiple choices must use string values" });
        if (
          ["integer", "number"].includes(field.type) &&
          field.options.some((option) => typeof option.value !== "number")
        )
          context.addIssue({ code: "custom", message: "Numeric choices must use numbers" });
      }
      const operator = field.match?.operator;
      if (
        operator &&
        ((["gte", "lte"].includes(operator) && !["integer", "number"].includes(field.type)) ||
          (["in", "contains_any"].includes(operator) && field.type !== "multiple_choice") ||
          (operator === "range" && field.type !== "range") ||
          (field.type === "range" && operator !== "range") ||
          (field.type === "multiple_choice" && !["in", "contains_any"].includes(operator)))
      )
        context.addIssue({
          code: "custom",
          message: `${field.label}: matching operator does not fit its type`,
        });
    }
    if (new Set(definition.comparison_attributes).size !== definition.comparison_attributes.length)
      context.addIssue({ code: "custom", message: "Comparison attributes must be unique" });
  });
export type SearchDefinition = z.infer<typeof searchDefinitionSchema>;
export const SEARCH_TEMPLATES = z.array(searchDefinitionSchema).parse(templates);

export function isVisible(
  field: SearchField,
  answers: Answers,
  definition?: SearchDefinition,
): boolean {
  const condition = field.visible_when;
  if (!condition) return true;
  const parent = definition?.fields.find((item) => item.id === condition.field);
  return (
    (!parent || isVisible(parent, answers, definition)) &&
    condition.one_of.some((value) => value === answers[condition.field])
  );
}

export function interviewFields(
  definition: SearchDefinition,
  answers: Answers,
  stage: "setup" | "refinement" = "setup",
  refinementFields?: readonly string[],
  uncertainFields: readonly string[] = [],
): SearchField[] {
  const unanswered = definition.fields.filter(
    (field) =>
      isVisible(field, answers, definition) &&
      answers[field.id] === undefined &&
      !uncertainFields.includes(field.id),
  );
  const setup = (field: SearchField): boolean =>
    (field.question_stage ?? (field.required ? "setup" : "refinement")) === "setup";
  return stage === "setup"
    ? unanswered.filter(setup)
    : [
        ...unanswered.filter(setup),
        ...unanswered.filter(
          (field) => !setup(field) && (!refinementFields || refinementFields.includes(field.id)),
        ),
      ];
}

export function answerError(field: SearchField, value: Answer | undefined): string | undefined {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0))
    return field.required ? `${field.label} is required` : undefined;
  const numeric = (number: number): boolean =>
    Number.isFinite(number) &&
    (field.minimum === undefined || number >= field.minimum) &&
    (field.maximum === undefined || number <= field.maximum);
  switch (field.type) {
    case "text":
    case "location":
      if (typeof value !== "string" || !value.trim()) return `${field.label} needs text`;
      break;
    case "integer":
    case "number":
      if (
        typeof value !== "number" ||
        !numeric(value) ||
        (field.type === "integer" && !Number.isInteger(value))
      )
        return `${field.label} needs a valid ${field.type === "integer" ? "whole number" : "number"}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${field.label} needs Yes or No`;
      break;
    case "single_choice":
      if (!field.options?.some((option) => option.value === value))
        return `Choose an option for ${field.label}`;
      break;
    case "multiple_choice":
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((item) => !field.options?.some((option) => option.value === item))
      )
        return `Choose valid options for ${field.label}`;
      break;
    case "range":
      if (
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value.min === undefined && value.max === undefined) ||
        (value.min !== undefined && !numeric(value.min)) ||
        (value.max !== undefined && !numeric(value.max)) ||
        (value.min !== undefined && value.max !== undefined && value.min > value.max)
      )
        return `${field.label} needs a valid range`;
      break;
  }
  if (field.match?.attribute === "seller_listing_count") {
    const counts =
      typeof value === "object" ? (Array.isArray(value) ? value : Object.values(value)) : [value];
    if (
      counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    )
      return `${field.label} needs whole numbers of zero or more`;
  }
  return undefined;
}

export function validateAnswers(
  definition: SearchDefinition,
  answers: Answers,
  partial = false,
): string[] {
  const errors = Object.keys(answers)
    .filter((id) => !definition.fields.some((field) => field.id === id))
    .map((id) => `Unknown field: ${id}`);
  for (const field of definition.fields) {
    if (!isVisible(field, answers, definition) || (partial && answers[field.id] === undefined))
      continue;
    const error = answerError(field, answers[field.id]);
    if (error) errors.push(error);
  }
  return errors;
}

export function activeAnswers(definition: SearchDefinition, answers: Answers): Answers {
  return Object.fromEntries(
    definition.fields
      .filter((field) => isVisible(field, answers, definition) && answers[field.id] !== undefined)
      .map((field) => [field.id, answers[field.id] ?? null]),
  );
}

export function formatAnswer(field: SearchField, answer: Answer | undefined): string {
  if (answer == null || answer === "" || (Array.isArray(answer) && answer.length === 0))
    return "No preference";
  if (Array.isArray(answer))
    return answer
      .map((value) => field.options?.find((option) => option.value === value)?.label ?? value)
      .join(", ");
  if (typeof answer === "object" && field.match?.attribute === "seller_listing_count") {
    const label =
      answer.min === undefined
        ? `Up to ${answer.max}`
        : answer.max === undefined
          ? `At least ${answer.min}`
          : answer.min === answer.max
            ? `${answer.min}`
            : `${answer.min}–${answer.max}`;
    const single = answer.max === 1 && (answer.min === undefined || answer.min === 1);
    return `${label} ${single ? "listing" : "listings"}`;
  }
  if (typeof answer === "object")
    return `${answer.min ?? "Any"}–${answer.max ?? "Any"}${field.unit ? ` ${field.unit}` : ""}`;
  const option = field.options?.find((item) => item.value === answer);
  if (option)
    return option.label === String(answer) && field.unit
      ? `${option.label} ${field.unit}`
      : option.label;
  if (typeof answer === "number" && field.display_divisor === 100 && field.unit?.startsWith("£")) {
    const price = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: "GBP",
      maximumFractionDigits: answer % 100 ? 2 : 0,
    }).format(answer / 100);
    return `${price}${field.unit.slice(1)}`;
  }
  if (typeof answer === "boolean") return answer ? "Yes" : "No";
  return `${typeof answer === "number" ? answer / (field.display_divisor ?? 1) : answer}${field.unit ? ` ${field.unit}` : ""}`;
}

const searchShape = {
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  name: searchNameSchema,
  product: key,
  enabled: z.boolean().default(true),
  cover: searchCoverSchema.optional(),
  marketplaces: z
    .array(marketplaceSchema)
    .min(1)
    .max(6)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
  discovery: discoverySchema.optional(),
  definition: searchDefinitionSchema,
  values: answersSchema,
};
export const searchInputSchema = z
  .object(searchShape)
  .strict()
  .superRefine((search, context) => {
    if (search.product !== search.definition.category)
      context.addIssue({
        code: "custom",
        message: "Search category does not match its definition",
      });
    for (const message of validateAnswers(search.definition, search.values))
      context.addIssue({ code: "custom", message });
  });
export const savedSearchSchema = z.object({ ...searchShape, id: z.string() }).strict();
export const draftInputSchema = z
  .object({
    id: z
      .string()
      .regex(/^draft-[a-z0-9-]+$/)
      .optional(),
    name: searchNameSchema,
    marketplaces: searchShape.marketplaces,
    discovery: discoverySchema.optional(),
    uncertain_fields: z.array(key).max(30).optional(),
    definition: searchDefinitionSchema,
    values: answersSchema,
  })
  .strict()
  .superRefine((draft, context) => {
    if (new Set(draft.uncertain_fields ?? []).size !== (draft.uncertain_fields ?? []).length)
      context.addIssue({ code: "custom", message: "Uncertain fields must be unique" });
    for (const id of draft.uncertain_fields ?? [])
      if (
        !draft.definition.fields.some((field) => field.id === id) ||
        draft.values[id] !== undefined
      )
        context.addIssue({ code: "custom", message: "Uncertainty must name an unanswered field" });
    for (const message of validateAnswers(draft.definition, draft.values, true))
      context.addIssue({ code: "custom", message });
  });
export const savedDraftSchema = z.object({
  id: z.string(),
  name: z.string(),
  marketplaces: searchShape.marketplaces,
  discovery: discoverySchema.optional(),
  uncertain_fields: z.array(key).max(30).optional(),
  definition: searchDefinitionSchema,
  values: answersSchema,
});
export type SearchDraft = z.infer<typeof savedDraftSchema>;
