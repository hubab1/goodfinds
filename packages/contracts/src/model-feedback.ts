import type { FeedbackEvent } from "./discovery.ts";

export type ModelSearch = {
  id: string;
  product: string;
  discovery?:
    | {
        model_attribute?: string | undefined;
        model_aliases?: { canonical: string; aliases: string[] }[] | undefined;
      }
    | undefined;
};
export function normalizeModel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/gu, " ");
}
export function modelIdentity(value: unknown, search: ModelSearch): unknown {
  if (typeof value !== "string") return value;
  const entry = search.discovery?.model_aliases?.find((item) =>
    [item.canonical, ...item.aliases].some(
      (alias) => normalizeModel(alias) === normalizeModel(value),
    ),
  );
  return normalizeModel(entry?.canonical ?? value);
}
export function verifiedModel(
  row: {
    attributes?: Record<string, unknown> | null | undefined;
    evidence?: Record<string, unknown> | null | undefined;
    [key: string]: unknown;
  },
  search: ModelSearch,
): string | undefined {
  const name = search.discovery?.model_attribute ?? "model";
  const value = row.attributes?.[name] ?? row[name];
  const evidence = row.evidence?.[name];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    typeof evidence !== "string" ||
    !evidence.trim() ||
    /\b(unknown|unconfirmed|unidentified|unsure|not known)\b/iu.test(value)
  )
    return undefined;
  return (
    search.discovery?.model_aliases?.find((item) =>
      [item.canonical, ...item.aliases].some(
        (alias) => normalizeModel(alias) === normalizeModel(value),
      ),
    )?.canonical ?? value.trim()
  );
}
export function modelExclusionRule(row: Parameters<typeof verifiedModel>[0], search: ModelSearch) {
  const model = verifiedModel(row, search);
  return model
    ? {
        attribute: search.discovery?.model_attribute ?? "model",
        operator: "neq" as const,
        value: model,
        importance: "required" as const,
        label: `Exclude ${model}`,
      }
    : undefined;
}
export function excludedModels(search: ModelSearch, events: FeedbackEvent[]): string[] {
  const name = search.discovery?.model_attribute ?? "model";
  return [
    ...new Set(
      events
        .filter(
          (event) =>
            !event.undone &&
            (event.scope === "global" ||
              (event.scope === "category" && event.category === search.product) ||
              event.search_id === search.id) &&
            event.rule?.attribute === name &&
            event.rule.operator === "neq" &&
            event.rule.importance === "required" &&
            typeof event.rule.value === "string",
        )
        .flatMap((event) => (typeof event.rule?.value === "string" ? [event.rule.value] : [])),
    ),
  ];
}
export function modelIsExcluded(
  row: Parameters<typeof verifiedModel>[0],
  search: ModelSearch,
  events: FeedbackEvent[],
): boolean {
  const model = verifiedModel(row, search);
  return (
    model !== undefined &&
    excludedModels(search, events).some(
      (value) => modelIdentity(value, search) === modelIdentity(model, search),
    )
  );
}
