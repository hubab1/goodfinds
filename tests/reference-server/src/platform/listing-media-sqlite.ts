import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { z } from "zod";
import type { WorkspaceMode } from "@goodfinds/contracts/state";
import { all, execute, get } from "./sqlite.ts";
import { hash, iso, parseJson, time } from "../workspace/model.ts";
import type { ListingObservation } from "../workspace/model.ts";
import { validation } from "../workspace/errors.ts";

// Media recovery is independent of an observation of price, availability or suitability.
export { listingMediaInput } from "@goodfinds/contracts/listing-media";
import { listingMediaInput } from "@goodfinds/contracts/listing-media";
type Capture = z.infer<typeof listingMediaInput>;

function merge<T extends { media_id: string; position: number }>(
  previous: T[] | undefined,
  fresh: T[] | undefined,
  expected: number | undefined,
): T[] | undefined {
  if (!fresh) return previous;
  // A full photo pass can succeed even when a video download fails, and vice versa.
  if (expected != null && fresh.length === expected) return fresh;
  const combined = [...(previous ?? [])];
  for (const item of fresh) {
    if (combined.some((saved) => saved.media_id === item.media_id)) continue;
    const position = combined.some((saved) => saved.position === item.position)
      ? Math.max(0, ...combined.map((saved) => saved.position)) + 1
      : item.position;
    combined.push({ ...item, position });
  }
  return combined;
}

export const applyCaptures = Effect.fnUntraced(function* (
  db: Database,
  rows: ListingObservation[],
) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  if (!byKey.size) return;
  const captures = yield* all<{ data: string }>(
    db,
    "SELECT document_json AS data FROM listing_media_captures ORDER BY captured_at, rowid",
  );
  for (const entry of captures) {
    const capture = parseJson<Capture>(entry.data),
      row = byKey.get(capture.listing_key);
    if (!row) continue;
    const captured = capture.media_capture.captured_at;
    if (!captured) continue;
    // A newer, explicitly complete observed gallery supersedes an old repair.
    if (
      row.media_capture?.status === "complete" &&
      time(row.media_capture.captured_at ?? row.observed_at) > time(captured)
    )
      continue;
    const photos = merge(row.photos, capture.photos, capture.media_capture.expected_photos);
    const videos = merge(row.videos, capture.videos, capture.media_capture.expected_videos);
    if (photos !== undefined) row.photos = photos;
    if (videos !== undefined) row.videos = videos;
    row.media_capture = capture.media_capture;
  }
});

export const attachCapture = Effect.fn("attachCapture")(function* (
  db: Database,
  input: unknown,
  mode: WorkspaceMode,
  now: number,
) {
  const capture = yield* validation(() => {
    const parsed = listingMediaInput.parse(input);
    const captured_at = parsed.media_capture.captured_at ?? iso(now);
    if (time(captured_at) > now + 300000)
      throw new Error("Media capture time cannot be in the future");
    parsed.media_capture.captured_at = iso(time(captured_at));
    for (const [items, expected] of [
      [parsed.photos, parsed.media_capture.expected_photos],
      [parsed.videos, parsed.media_capture.expected_videos],
    ] as const) {
      if (
        new Set(items?.map((item) => item.position)).size !== (items?.length ?? 0) ||
        items?.some((item) => expected != null && item.position > expected)
      )
        throw new Error("Saved media needs unique positions within the observed gallery total");
      if (
        parsed.media_capture.status === "complete" &&
        (expected == null || expected !== (items?.length ?? 0))
      )
        throw new Error(
          "Complete media capture needs observed totals and every saved photo and video",
        );
    }
    if (parsed.media_capture.status === "complete" && (!parsed.photos || !parsed.videos))
      throw new Error("A complete capture must explicitly include both photos and videos");
    return parsed;
  });
  const entry = yield* get<{ data: string }>(
    db,
    "SELECT document_json AS data FROM listings WHERE listing_key=? AND provenance=?",
    capture.listing_key,
    mode === "sample" ? "synthetic" : "manual",
  );
  const row = yield* validation(() => {
    if (!entry) throw new Error("Choose a saved listing in this workspace");
    return parseJson<ListingObservation>(entry.data);
  });
  yield* execute(db, "INSERT OR IGNORE INTO listing_media_captures VALUES (?, ?, ?, ?)", [
    hash(capture),
    capture.listing_key,
    capture.media_capture.captured_at ?? iso(now),
    JSON.stringify(capture),
  ]);
  yield* applyCaptures(db, [row]);
  yield* execute(db, "UPDATE listings SET document_json=? WHERE listing_key=?", [
    JSON.stringify(row),
    row.key,
  ]);
});
