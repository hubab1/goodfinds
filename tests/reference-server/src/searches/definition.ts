import { modelIdentity } from "@goodfinds/contracts/discovery";
import { Effect } from "effect";
import { setupCostTotal } from "@goodfinds/contracts/verification";
import { validation } from "../workspace/errors.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  SEARCH_TEMPLATES,
  searchDefinitionSchema,
  answersSchema,
  validateAnswers,
  activeAnswers,
  isVisible,
  savedSearchSchema,
} from "@goodfinds/contracts/search-definition";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type {
  Answer,
  Answers,
  SearchDefinition,
  SearchField,
} from "@goodfinds/contracts/search-definition";
import { DAY, canonical, fresh, number, record } from "../workspace/model.ts";
import type { ListingObservation } from "../workspace/model.ts";

export function cleanAnswers(definition: SearchDefinition, input: unknown, partial = false) {
  return validation(() => cleanAnswersValue(definition, input, partial));
}
export const normalizeSearch = Effect.fnUntraced(function* (input: unknown) {
  const id =
    record(input) && typeof input["id"] === "string"
      ? input["id"]
      : "search-" + (yield* Effect.sync(randomUUID)).slice(0, 8);
  return yield* validation(() => normalizeSearchValue(input, id));
});
function cleanAnswersValue(definition: SearchDefinition, input: unknown, partial = false): Answers {
  const answers = answersSchema.parse(input),
    errors = validateAnswers(definition, answers, partial);
  if (errors.length) throw new Error(errors.join("; "));
  return Object.fromEntries(
    Object.entries(activeAnswers(definition, answers)).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.trim() || null
        : Array.isArray(value) && !value.length
          ? null
          : value,
    ]),
  );
}
function normalizeSearchValue(input: unknown, generatedId: string): SavedSearch {
  if (!record(input)) throw new Error("Search must be an object");
  const result = { ...input, id: input["id"] ?? generatedId, enabled: input["enabled"] ?? true };
  const saved = savedSearchSchema.parse(result);
  if (saved.product !== saved.definition.category)
    throw new Error("Search needs a matching category");
  const values = cleanAnswersValue(saved.definition, saved.values);
  // Preserve the caller's validated definition; UI defaults are derived when rendering it.
  return { ...saved, definition: searchDefinitionSchema.parse(input["definition"]), values };
}
export function attribute(row: ListingObservation, name: string): unknown {
  if (name === "chip_generation") {
    const chip = /^M([1-9]\d*)(?: (?:Pro|Max|Ultra))?$/iu.exec(row.chip ?? "");
    return chip?.[1] ? Number(chip[1]) : null;
  }
  return row.attributes && name in row.attributes ? row.attributes[name] : row[name];
}
export function hasEvidence(row: ListingObservation, name: string): boolean {
  const value = row.evidence?.[name === "chip_generation" ? "chip" : name];
  return typeof value === "string" && Boolean(value.trim());
}
export function criterionMatches(
  actual: unknown,
  expected: Answer,
  operator: NonNullable<SearchField["match"]>["operator"],
): boolean {
  switch (operator) {
    case "eq":
      return typeof actual === "string" && typeof expected === "string"
        ? actual.trim().toLowerCase() === expected.trim().toLowerCase()
        : actual === expected;
    case "gte":
      return number(actual) && number(expected) && actual >= expected;
    case "lte":
      return number(actual) && number(expected) && actual <= expected;
    case "in":
      return (
        Array.isArray(expected) && expected.some((option) => criterionMatches(actual, option, "eq"))
      );
    case "contains_any":
      return (
        Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.some((item: unknown) =>
          expected.some((option) => criterionMatches(item, option, "eq")),
        )
      );
    case "range":
      return (
        number(actual) &&
        record(expected) &&
        actual >= (number(expected["min"]) ? expected["min"] : -Infinity) &&
        actual <= (number(expected["max"]) ? expected["max"] : Infinity)
      );
    default:
      return false;
  }
}
export function sellerCountMatches(
  row: ListingObservation,
  expected: Answer,
  operator: NonNullable<SearchField["match"]>["operator"],
  now: number,
): boolean | null {
  const count = row.seller_listing_count;
  if (
    count == null ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !row.seller_profile_url ||
    !hasEvidence(row, "seller_listing_count") ||
    !fresh(row.seller_listings_checked_at, now, 30)
  )
    return null;
  if (row.seller_listing_count_precision === "exact")
    return criterionMatches(count, expected, operator);
  if (row.seller_listing_count_precision !== "lower_bound") return null;
  if (operator === "gte" && number(expected)) return count >= expected ? true : null;
  if ((operator === "lte" || operator === "eq") && number(expected))
    return count > expected ? false : null;
  if (operator === "in" && Array.isArray(expected))
    return expected.every((limit) => number(limit) && count > limit) ? false : null;
  if (operator === "range" && record(expected)) {
    if (number(expected["max"]) && count > expected["max"]) return false;
    if (expected["max"] === undefined && count >= (number(expected["min"]) ? expected["min"] : 0))
      return true;
  }
  return null;
}
export function criteria(
  row: ListingObservation,
  search: SavedSearch,
  budget = true,
  now = Date.now(),
): [string[], string[], string[]] {
  const rejected: string[] = [],
    uncertain: string[] = [],
    preferences: string[] = [];
  for (const field of search.definition.fields) {
    const rule = field.match,
      expected = search.values[field.id];
    if (!rule || expected == null || !isVisible(field, search.values, search.definition)) continue;
    const name = rule.attribute;
    if (search.discovery?.reference_model && name === search.discovery.model_attribute) continue;
    if (
      !budget &&
      (name === "seller_listing_count" || (name === "price_minor" && rule.operator === "lte"))
    )
      continue;
    const purchase = name === "price_minor" ? setupCostTotal(row) : null;
    const actual =
        purchase && row.setup_costs?.length ? purchase.total_minor : attribute(row, name),
      verified = ["price_minor", "drive_minutes"].includes(name) || hasEvidence(row, name);
    const approximateBoundary =
      name === "drive_minutes" &&
      row.journey_estimate?.precision === "town" &&
      typeof actual === "number" &&
      typeof expected === "number" &&
      rule.operator === "lte" &&
      Math.abs(actual - expected) <= 10;
    const matches = approximateBoundary
      ? null
      : name === "seller_listing_count"
        ? sellerCountMatches(row, expected, rule.operator, now)
        : purchase && row.setup_costs?.length && purchase.basis !== "observed"
          ? rule.operator === "lte" &&
            row.price_minor !== null &&
            !criterionMatches(row.total_cash_cost_minor ?? row.price_minor, expected, "lte")
            ? false
            : null
          : actual != null && verified
            ? criterionMatches(actual, expected, rule.operator)
            : null;
    const required = (rule.importance ?? "required") === "required";
    if (matches === null)
      (required ? uncertain : preferences).push(`${field.label} needs verification`);
    else if (!matches)
      (required ? rejected : preferences).push(
        `${field.label} does not meet your ${required ? "requirement" : "preference"}`,
      );
  }
  return [rejected, uncertain, preferences];
}
export function searchCohort(row: ListingObservation, search: SavedSearch): string | null {
  const dimensions =
    search.discovery?.reference_model || search.discovery?.research?.candidates.length
      ? [...new Set([...search.definition.comparison_attributes, search.discovery.model_attribute])]
      : search.definition.comparison_attributes;
  const values = dimensions.map((name) => attribute(row, name));
  if (values.some((value) => value == null || value === "")) return null;
  const model = search.discovery?.model_attribute ?? "model";
  const aliases = search.discovery?.model_aliases ?? [];
  const normalized = values.map((original, index) => {
    const match =
      dimensions[index] === model && typeof original === "string"
        ? aliases.find((entry) =>
            [entry.canonical, ...entry.aliases].some(
              (alias) => normalizeName(alias) === normalizeName(original),
            ),
          )
        : undefined;
    const value = match?.canonical ?? original;
    return typeof value === "string"
      ? normalizeName(value)
      : Array.isArray(value)
        ? z.array(z.string()).parse(value).map(normalizeName).toSorted()
        : value;
  });
  return canonical([row.product, search.definition.price, normalized]);
}
export function normalizeName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, " ");
}
export function canonicalModel(value: string, search: SavedSearch): string;
export function canonicalModel(value: unknown, search: SavedSearch): unknown;
export function canonicalModel(value: unknown, search: SavedSearch): unknown {
  return modelIdentity(value, search);
}
export { SEARCH_TEMPLATES, DAY };
