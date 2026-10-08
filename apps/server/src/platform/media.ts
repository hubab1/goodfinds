import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { MediaError, mediaOperation, validation } from "../workspace/errors.ts";

export const mediaIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const mediaFilesSchema = z
  .array(z.object({ path: z.string().min(1), label: z.string().max(200) }).strict())
  .min(1)
  .max(20);

function mime(bytes: Buffer, videos = false) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (videos && bytes.length >= 24 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const brands = bytes.toString("ascii", 8, Math.min(bytes.length, bytes.readUInt32BE(0)));
    if (/isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV/.test(brands)) return "video/mp4" as const;
  }
  if (
    videos &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, 4096).includes(Buffer.from("webm"))
  )
    return "video/webm" as const;
  throw new MediaError({
    message: videos
      ? "Use downloaded JPEG, PNG, WebP, MP4 or WebM files. Other file types are not supported."
      : "Use downloaded JPEG, PNG or WebP images. Other file types are not supported.",
  });
}
function check<A>(evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof MediaError
        ? cause
        : new MediaError({ message: "The image is unavailable.", cause }),
  });
}
const mediaBytes = Effect.fnUntraced(function* (path: string, limit = 10_000_000) {
  const info = yield* mediaOperation(() => lstat(path));
  if (!info.isFile() || info.size === 0 || info.size > limit)
    return yield* Effect.fail(
      new MediaError({
        message: `Each file must be a regular file of up to ${limit / 1_000_000} MB.`,
      }),
    );
  const bytes = yield* mediaOperation((signal) => readFile(path, { signal }));
  // A file may grow between the metadata check and read.
  if (bytes.length === 0 || bytes.length > limit)
    return yield* Effect.fail(
      new MediaError({
        message: `Each file must be a regular file of up to ${limit / 1_000_000} MB.`,
      }),
    );
  return bytes;
});
const cacheFiles = Effect.fn("cacheFiles")(function* (
  workspaceDirectory: string,
  input: z.infer<typeof mediaFilesSchema>,
  videos: boolean,
) {
  const files = yield* validation(() => mediaFilesSchema.parse(input));
  const folder = resolve(workspaceDirectory, "media");
  let batchBytes = 0;
  const prepared = yield* Effect.forEach(
    files,
    (file) =>
      Effect.gen(function* () {
        const bytes = yield* mediaBytes(file.path, videos ? 50_000_000 : 10_000_000);
        batchBytes += bytes.length;
        if (batchBytes > (videos ? 100_000_000 : 50_000_000))
          return yield* Effect.fail(
            new MediaError({ message: `Cache files in batches of up to ${videos ? 100 : 50} MB.` }),
          );
        const mime_type = yield* check(() => mime(bytes, videos));
        if (mime_type.startsWith("image/") && bytes.length > 10_000_000)
          return yield* Effect.fail(new MediaError({ message: "Each image must be up to 10 MB." }));
        return {
          bytes,
          id: createHash("sha256").update(bytes).digest("hex"),
          mime_type,
          label: file.label,
        };
      }),
    { concurrency: 1 },
  );
  if (
    prepared.reduce((total, file) => total + file.bytes.length, 0) >
    (videos ? 100_000_000 : 50_000_000)
  )
    return yield* Effect.fail(
      new MediaError({ message: `Cache files in batches of up to ${videos ? 100 : 50} MB.` }),
    );
  yield* mediaOperation(() => mkdir(folder, { recursive: true, mode: 0o700 }));
  const unique = new Map(prepared.map((file) => [file.id, file]));
  yield* Effect.forEach(
    unique.values(),
    (file) =>
      Effect.gen(function* () {
        const staging = resolve(folder, `pending-${yield* Effect.sync(randomUUID)}`);
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Register removal before starting the interruptible write.
            yield* Effect.addFinalizer(() =>
              mediaOperation(() => rm(staging, { force: true })).pipe(Effect.orDie),
            );
            yield* mediaOperation((signal) =>
              writeFile(staging, file.bytes, { flag: "wx", mode: 0o600, signal }),
            );
            yield* mediaOperation(() => rename(staging, resolve(folder, file.id))).pipe(
              Effect.uninterruptible,
            );
          }),
        );
      }),
    { concurrency: 4 },
  );
  return prepared.map((file) => ({
    id: file.id,
    mime_type: file.mime_type,
    size_bytes: file.bytes.length,
    label: file.label,
  }));
});
export const cacheImages = (workspaceDirectory: string, files: z.infer<typeof mediaFilesSchema>) =>
  cacheFiles(workspaceDirectory, files, false);
export const cacheMedia = (workspaceDirectory: string, files: z.infer<typeof mediaFilesSchema>) =>
  cacheFiles(workspaceDirectory, files, true);
export const readImage = Effect.fn("readImage")(function* (
  workspaceDirectory: string,
  rawId: string,
  bundledFile?: { path: string; mediaId: string },
) {
  const id = yield* validation(() => mediaIdSchema.parse(rawId));
  const image = yield* mediaBytes(resolve(workspaceDirectory, "media", id)).pipe(
    Effect.map((bytes) => ({ bytes, expectedId: id })),
    Effect.catchTag("MediaError", (error) => {
      const cause = error.cause;
      return bundledFile && cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? mediaBytes(bundledFile.path).pipe(
            Effect.map((bytes) => ({ bytes, expectedId: bundledFile.mediaId })),
          )
        : Effect.fail(error);
    }),
  );
  const { bytes, expectedId } = image;
  if (createHash("sha256").update(bytes).digest("hex") !== expectedId)
    return yield* Effect.fail(
      new MediaError({ message: "The saved image has changed. Download it again." }),
    );
  const mimeType = yield* check(() => mime(bytes));
  if (mimeType === "video/mp4" || mimeType === "video/webm")
    return yield* Effect.fail(new MediaError({ message: "The saved file is not an image." }));
  return { type: "image" as const, mimeType, data: bytes.toString("base64") };
});
export const readVideo = Effect.fn("readVideo")(function* (
  workspaceDirectory: string,
  rawId: string,
) {
  const id = yield* validation(() => mediaIdSchema.parse(rawId));
  const bytes = yield* mediaBytes(resolve(workspaceDirectory, "media", id), 50_000_000);
  if (createHash("sha256").update(bytes).digest("hex") !== id)
    return yield* Effect.fail(
      new MediaError({ message: "The saved video has changed. Download it again." }),
    );
  const mime_type = yield* check(() => mime(bytes, true));
  if (mime_type !== "video/mp4" && mime_type !== "video/webm")
    return yield* Effect.fail(new MediaError({ message: "The saved file is not a video." }));
  return { mime_type, data: bytes.toString("base64") };
});
export const readMediaFile = Effect.fn("readMediaFile")(function* (
  workspaceDirectory: string,
  rawId: string,
) {
  const id = yield* validation(() => mediaIdSchema.parse(rawId));
  const path = resolve(workspaceDirectory, "media", id);
  const bytes = yield* mediaBytes(path, 50_000_000);
  if (createHash("sha256").update(bytes).digest("hex") !== id)
    return yield* Effect.fail(
      new MediaError({ message: "The saved media has changed. Download it again." }),
    );
  const mime_type = yield* check(() => mime(bytes, true));
  return { media_id: id, path, mime_type, size_bytes: bytes.length };
});
export const validateImageReferences = Effect.fn("validateImageReferences")(function* (
  workspaceDirectory: string,
  observations: unknown,
) {
  const rows = yield* validation(() =>
    z
      .array(
        z
          .object({
            photos: z.array(z.object({ media_id: mediaIdSchema }).loose()).optional(),
            seller_avatar_media_id: mediaIdSchema.nullish(),
            videos: z
              .array(
                z
                  .object({ media_id: mediaIdSchema, poster_media_id: mediaIdSchema.optional() })
                  .loose(),
              )
              .optional(),
          })
          .loose(),
      )
      .parse(observations),
  );
  const ids = new Set(
    rows.flatMap((row) =>
      (row.photos ?? [])
        .map((photo) => photo.media_id)
        .concat(
          (row.videos ?? []).flatMap((video) =>
            video.poster_media_id ? [video.poster_media_id] : [],
          ),
        )
        .concat(row.seller_avatar_media_id ? [row.seller_avatar_media_id] : []),
    ),
  );
  yield* Effect.forEach(ids, (id) => readImage(workspaceDirectory, id), {
    concurrency: 4,
    discard: true,
  });
  const videoIds = new Set(
    rows.flatMap((row) => (row.videos ?? []).map((video) => video.media_id)),
  );
  yield* Effect.forEach(videoIds, (id) => readVideo(workspaceDirectory, id), {
    concurrency: 2,
    discard: true,
  });
});
