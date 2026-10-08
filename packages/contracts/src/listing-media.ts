import { z } from "zod";
import { listingSchema } from "./state.ts";
export const listingMediaInput = z
  .object({
    listing_key: z.string().min(1),
    photos: listingSchema.shape.photos.unwrap().optional(),
    videos: listingSchema.shape.videos.unwrap().optional(),
    media_capture: listingSchema.shape.media_capture.unwrap(),
  })
  .strict();
