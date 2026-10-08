import { appliesToSearch } from "@goodfinds/contracts/discovery";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type { WorkspaceConfiguration, ListingObservation } from "../workspace/model.ts";
import { attribute, criterionMatches, hasEvidence, canonicalModel } from "./definition.ts";

export function latestListingFeedback(
  events: FeedbackEvent[],
  search: SavedSearch,
  key: string,
): FeedbackEvent | undefined {
  return events.findLast((event) => appliesToSearch(event, search) && event.listing_key === key);
}
export function learnedCriteria(
  row: ListingObservation,
  search: SavedSearch,
  config: WorkspaceConfiguration,
  budget: boolean,
): [string[], string[], number] {
  const rejected: string[] = [],
    uncertain: string[] = [];
  let score = 0;
  if (!(search.marketplaces ?? ["facebook_marketplace"]).includes(row.source))
    rejected.push("Marketplace is outside this search");
  if (config.platforms[row.source]?.enabled === false) rejected.push("Marketplace is disabled");
  const discovery = search.discovery;
  if (discovery?.scope === "exact") {
    const model = attribute(row, discovery.model_attribute);
    if (model == null || !hasEvidence(row, discovery.model_attribute))
      uncertain.push("Exact model needs verification");
    else if (
      !criterionMatches(
        canonicalModel(model, search),
        canonicalModel(discovery.reference_model ?? "", search),
        "eq",
      )
    )
      rejected.push("Different model from your exact requirement");
  }
  if (!budget) return [rejected, uncertain, score];
  const latest = latestListingFeedback(config.feedback, search, row.key);
  if (latest?.action === "dismiss") rejected.push("Dismissed for this search");
  if (latest?.action === "shortlist") score += 100;
  const rules = new Map<string, NonNullable<FeedbackEvent["rule"]>>();
  for (const event of config.feedback) {
    if (appliesToSearch(event, search) && event.rule)
      rules.set(
        `${event.rule.attribute}:${event.rule.operator}${event.rule.operator === "neq" ? `:${JSON.stringify(event.rule.value)}` : ""}`,
        event.rule,
      );
  }
  for (const rule of rules.values()) {
    const actual = attribute(row, rule.attribute);
    const verified =
      ["price_minor", "drive_minutes"].includes(rule.attribute) || hasEvidence(row, rule.attribute);
    if (actual == null || !verified) {
      if (rule.importance === "required") uncertain.push(`${rule.label} needs verification`);
      continue;
    }
    const modelRule = rule.attribute === (search.discovery?.model_attribute ?? "model");
    const actualValue = modelRule ? canonicalModel(actual, search) : actual;
    const expectedValue =
      modelRule && typeof rule.value === "string" ? canonicalModel(rule.value, search) : rule.value;
    const match =
      rule.operator === "neq"
        ? !criterionMatches(actualValue, expectedValue, "eq")
        : criterionMatches(actualValue, expectedValue, rule.operator);
    if (match) score += rule.importance === "preferred" ? 1 : 0;
    else if (rule.importance === "required") rejected.push(rule.label);
  }
  if (
    discovery?.reference_model &&
    discovery.scope !== "exact" &&
    hasEvidence(row, discovery.model_attribute) &&
    criterionMatches(
      canonicalModel(attribute(row, discovery.model_attribute), search),
      canonicalModel(discovery.reference_model, search),
      "eq",
    )
  )
    score++;
  for (const field of search.definition.fields) {
    if (
      field.match?.importance === "preferred" &&
      search.values[field.id] != null &&
      hasEvidence(row, field.match.attribute) &&
      criterionMatches(
        attribute(row, field.match.attribute),
        search.values[field.id] ?? null,
        field.match.operator,
      )
    )
      score++;
  }
  return [rejected, uncertain, score];
}
