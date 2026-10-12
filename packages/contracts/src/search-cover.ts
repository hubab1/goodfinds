import { z } from "zod";
import type { SavedSearch } from "./state.ts";
import { isBundledSearchCover } from "./search-cover-presets.ts";

export const MANUFACTURER_PHOTO_GUIDANCE =
  "For identifiable products and clothing categories, automatically fetch a suitable official manufacturer photo, cache it in the user's workspace and attach it as the search worker’s first bounded media task before marketplace discovery. Choose any accepted model or a clearly labelled representative family photo; exact variant, storage and colour matching are unnecessary. This follow-up is required before finishing the request, including searches with no listings. Reuse a suitable saved photo. Bundled covers are generic illustrations and do not satisfy a named product's photo follow-up. If fetching is blocked or no suitable photo is available, report the specific reason and retain the fallback; never silently skip the attempt. Follow references/search-covers.md.";

const manufacturerProducts = new Map([
  ["macbook_pro", "MacBook Pro"],
  ["mac_mini", "Mac mini"],
  ["mac_pro", "Mac Pro"],
]);

export function searchCoverProduct(
  search: Pick<SavedSearch, "product" | "discovery"> & Partial<Pick<SavedSearch, "definition">>,
) {
  return (
    search.discovery?.reference_model?.trim() ||
    manufacturerProducts.get(search.product) ||
    (search.product === "clothing"
      ? search.discovery?.category_terms?.find((term) => term.trim())?.trim() ||
        search.definition?.title.trim()
      : undefined)
  );
}

export const searchCoverFollowUpSchema = z.object({
  search_id: z.string(),
  product: z.string(),
  action: z.literal("fetch_manufacturer_photo"),
  required: z.literal(true),
});

export function searchCoverFollowUp(
  search: Pick<SavedSearch, "id" | "product" | "cover" | "discovery"> &
    Partial<Pick<SavedSearch, "definition">>,
) {
  const product = searchCoverProduct(search);
  if (
    !product ||
    search.product === "rental" ||
    (search.cover && (search.cover.kind === "user" || !isBundledSearchCover(search.cover.media_id)))
  )
    return null;
  return {
    search_id: search.id,
    product,
    action: "fetch_manufacturer_photo" as const,
    required: true as const,
  };
}

export const searchCoverSchema = z
  .object({
    media_id: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["manufacturer", "generated", "area", "stock", "user"]),
    alt: z.string().trim().min(1).max(200),
    source_name: z.string().trim().min(1).max(200),
    source_url: z
      .url()
      .max(2000)
      .regex(/^https?:\/\//)
      .optional(),
    location: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((image, context) => {
    if (["manufacturer", "area", "stock"].includes(image.kind) && !image.source_url)
      context.addIssue({ code: "custom", message: "Include the image's source page" });
  });

export type SearchCover = z.infer<typeof searchCoverSchema>;
