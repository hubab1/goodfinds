import type { MediaRepairListing } from "@goodfinds/contracts/listing-model";
import { mediaState } from "@goodfinds/contracts/listing-model";
export function repairQueue(rows: MediaRepairListing[], now: number) {
  return rows.flatMap((row) => {
    const capture = row.media_capture;
    const photos = row.photos?.length ?? 0,
      videos = row.videos?.length ?? 0;
    const media = mediaState(row, now);
    if (media.state === "complete") return [];
    return [
      {
        listing_key: row.key,
        title: row.title,
        url: row.url,
        product: row.product,
        saved_photos: photos,
        saved_videos: videos,
        media_capture: capture ?? null,
        retry_at: media.retry_at,
        ready: media.ready,
      },
    ];
  });
}
