import sources from "../data/search-cover-sources.json" with { type: "json" };
import { rentalCoverFor, rentalCovers } from "./rental-cover.ts";
import type { SavedSearch } from "./state.ts";
import { z } from "zod";

export const vehicleCovers = sources.vehicle_presets;
export const marketplaceCovers = sources.marketplace_presets;
export const searchCoverCategorySchema = z.enum([
  "rental",
  "vehicle",
  "furniture",
  "cycling",
  "garden",
  "baby",
]);
export const bundledSearchCovers = [
  ...Object.entries(rentalCovers).map(([preset, image]) => ({
    category: "rental" as const,
    preset,
    image,
  })),
  ...Object.entries(vehicleCovers).map(([preset, image]) => ({
    category: "vehicle" as const,
    preset,
    image,
  })),
  ...Object.entries(marketplaceCovers).map(([preset, image]) => ({
    category: searchCoverCategorySchema.parse(image.category),
    preset,
    image,
  })),
];

// Previously saved covers keep their original content IDs after asset recompression.
const coverMediaIdAliases = new Map<string, string>(Object.entries(sources.media_id_aliases));

export function bundledSearchCoverById(mediaId: string) {
  const canonicalId = coverMediaIdAliases.get(mediaId) ?? mediaId;
  return bundledSearchCovers.find(({ image }) => image.media_id === canonicalId)?.image;
}

const marketplaceTypes = new Map<string, keyof typeof marketplaceCovers>([
  ["sofa", "sofa"],
  ["couch", "sofa"],
  ["dining_set", "dining_set"],
  ["dining_table", "dining_set"],
  ["wardrobe", "wardrobe"],
  ["chest_of_drawers", "chest_of_drawers"],
  ["sideboard", "sideboard"],
  ["bicycle", "bicycle"],
  ["garden_furniture", "garden_furniture"],
  ["patio_furniture", "garden_furniture"],
  ["pram", "pram"],
  ["pushchair", "pram"],
  ["stroller", "pram"],
]);

const vehicleTypes = new Map<string, keyof typeof vehicleCovers>([
  ["sedan", "sedan"],
  ["saloon", "sedan"],
  ["4x4", "4x4"],
  ["suv", "4x4"],
  ["motorbike", "motorbike"],
  ["motorcycle", "motorbike"],
  ["boat", "boat"],
]);
const vehicleCategories = new Set([
  "vehicle",
  "vehicles",
  "car",
  "cars",
  "motorbike",
  "motorcycle",
  "boat",
]);

function vehicleType(value: unknown) {
  const selected: unknown = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof selected === "string" ? vehicleTypes.get(selected.trim().toLowerCase()) : undefined;
}

export function bundledSearchCoverFor(search: Pick<SavedSearch, "product" | "values">) {
  if (search.product === "rental") return rentalCoverFor(search.values);
  const product = search.product.trim().toLowerCase();
  const marketplaceType = marketplaceTypes.get(product);
  if (marketplaceType) return marketplaceCovers[marketplaceType];
  const type =
    vehicleType(product) ??
    (vehicleCategories.has(product)
      ? (vehicleType(search.values["body_type"]) ?? vehicleType(search.values["vehicle_type"]))
      : undefined);
  return type ? vehicleCovers[type] : undefined;
}

export function isBundledSearchCover(mediaId: string) {
  return bundledSearchCoverById(mediaId) !== undefined;
}
