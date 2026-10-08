import { formatAnswer, isVisible } from "@goodfinds/contracts/search-definition";
import type { Answer, SearchField } from "@goodfinds/contracts/search-definition";
import { money } from "./presentation.ts";
import type { SavedSearch } from "@goodfinds/contracts/state";

function hasPreference(answer: Answer | undefined): boolean {
  if (answer == null || answer === "") return false;
  if (Array.isArray(answer)) return answer.length > 0;
  if (typeof answer === "object") return answer.min !== undefined || answer.max !== undefined;
  return true;
}

function isDistanceField(field: SearchField): boolean {
  return /^(?:max_)?(?:radius|distance)(?:_(?:km|mi|miles))?$/u.test(
    field.match?.attribute ?? field.id,
  );
}

function compactAnswer(field: SearchField, answer: Answer | undefined): string {
  const value = formatAnswer(field, answer);
  const label = field.label.replace(/^(minimum|maximum)\s+/iu, "");
  const shortLabel = label.charAt(0).toLowerCase() + label.slice(1);
  if (typeof answer === "number") {
    const option = field.options?.find((item) => item.value === answer);
    if (option && option.label !== String(answer)) {
      const minimum =
        field.match?.operator === "gte" && !/newer|or more|at least|[≥+]/iu.test(value);
      const maximum = field.match?.operator === "lte" && !/or less|up to|at most|[≤]/iu.test(value);
      return `${value}${minimum ? "+" : maximum ? " max" : ""}`;
    }
    const limit =
      field.match?.operator === "gte" ? "+" : field.match?.operator === "lte" ? " max" : "";
    const description =
      field.unit && label.toLowerCase().includes(field.unit.toLowerCase()) ? "" : ` ${shortLabel}`;
    return `${value}${limit}${description}`;
  }
  if (field.options && (typeof answer === "string" || Array.isArray(answer))) return value;
  return `${label}: ${value}`;
}

export function searchRequirements(search: SavedSearch) {
  return search.definition.fields
    .filter(
      (field) =>
        isVisible(field, search.values, search.definition) && search.values[field.id] !== undefined,
    )
    .map((field) => {
      const answer = search.values[field.id];
      return {
        id: field.id,
        label: field.label,
        value: !hasPreference(answer)
          ? "No preference"
          : field.match?.attribute === "price_minor" && typeof answer === "number"
            ? `${money(answer, search.definition.price.currency)}${search.definition.price.period === "once" ? "" : ` per ${search.definition.price.period}`}`
            : formatAnswer(field, answer),
      };
    });
}

export function searchSummary(search: SavedSearch): string {
  return (
    search.definition.fields
      .filter(
        (field) =>
          isVisible(field, search.values, search.definition) &&
          hasPreference(search.values[field.id]) &&
          field.type !== "location" &&
          !isDistanceField(field) &&
          !["price_minor", "drive_minutes"].includes(field.match?.attribute ?? ""),
      )
      .slice(0, 3)
      .map((field) => compactAnswer(field, search.values[field.id]))
      .join(" · ") || search.definition.title
  );
}

export function searchLocation(
  search: SavedSearch,
  origin: string,
): {
  location: string;
  distances: { label: string; kind: "drive" | "radius" }[];
} {
  const locations = search.definition.fields
    .filter(
      (field) =>
        field.type === "location" &&
        isVisible(field, search.values, search.definition) &&
        hasPreference(search.values[field.id]),
    )
    .map((field) => formatAnswer(field, search.values[field.id]));
  const distances: { label: string; kind: "drive" | "radius" }[] = search.definition.fields
    .filter(
      (field) =>
        isDistanceField(field) &&
        isVisible(field, search.values, search.definition) &&
        hasPreference(search.values[field.id]),
    )
    .map((field) => ({
      label:
        field.match?.operator === "lte"
          ? `Within ${formatAnswer(field, search.values[field.id])}`
          : `${field.label}: ${formatAnswer(field, search.values[field.id])}`,
      kind: "radius",
    }));
  const limits = search.definition.fields
    .filter(
      (field) =>
        field.match?.attribute === "drive_minutes" &&
        field.match.operator === "lte" &&
        isVisible(field, search.values, search.definition),
    )
    .map((field) => search.values[field.id])
    .filter((value): value is number => typeof value === "number");
  if (limits.length) {
    const minutes = Math.min(...limits);
    const distance =
      minutes % 60 === 0
        ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
        : `${minutes} min`;
    distances.push({ label: `Up to ${distance} drive`, kind: "drive" });
  }
  return {
    location: locations.join(" · ") || (distances.length > 0 ? origin : "Any location"),
    distances,
  };
}

export function searchBudget(search: SavedSearch): string {
  const limits = search.definition.fields
    .filter(
      (field) =>
        field.match?.attribute === "price_minor" &&
        field.match.operator === "lte" &&
        isVisible(field, search.values, search.definition),
    )
    .map((field) => search.values[field.id])
    .filter((value): value is number => typeof value === "number");
  return limits.length
    ? money(Math.min(...limits), search.definition.price.currency)
    : "No price limit";
}
