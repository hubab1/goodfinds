import { searchInputSchema } from "@goodfinds/contracts/search-definition";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { z } from "zod";

const record = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? z.record(z.string(), z.unknown()).parse(value)
    : undefined;

/** Reapply only the form's changes; preserve newer independent edits. */
export function reconcileSearchEdit(base: SavedSearch, submitted: unknown, latest: SavedSearch) {
  function merge(before: unknown, edited: unknown, saved: unknown, path: string[]): unknown {
    if (JSON.stringify(before) === JSON.stringify(edited)) return saved;
    if (
      JSON.stringify(before) === JSON.stringify(saved) ||
      JSON.stringify(edited) === JSON.stringify(saved)
    )
      return edited;
    const original = record(before);
    const requested = record(edited);
    const current = record(saved);
    if (original && requested && current)
      return Object.fromEntries(
        [...new Set([...Object.keys(original), ...Object.keys(requested), ...Object.keys(current)])]
          .map((key) => [key, merge(original[key], requested[key], current[key], [...path, key])])
          .filter(([, value]) => value !== undefined),
      );
    const field =
      path[0] === "values"
        ? (latest.definition.fields.find((item) => item.id === path[1])?.label ?? "requirements")
        : path[0] === "name"
          ? "name"
          : "details";
    throw new Error(
      `The search ${field} changed elsewhere while you were editing. Your entries are still here. Reopen the editor to review the latest version.`,
    );
  }
  return searchInputSchema.parse(
    merge(
      searchInputSchema.parse(base),
      searchInputSchema.parse(submitted),
      searchInputSchema.parse(latest),
      [],
    ),
  );
}
