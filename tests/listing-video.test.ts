import { seedWorkspace } from "./helpers/workspace.ts";
import { z } from "zod";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";

void test("listing videos are cached, imported and retrieved separately from state", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-video-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const fn = calls.get(name);
    assert.ok(fn, `Missing media tool: ${name}`);
    return fn(args);
  };
  // ISO BMFF fixture: format detection, not a playable-film fixture.
  const video = Buffer.from(
    "000000186674797069736f6d0000020069736f6d6d703432000000086d646174",
    "hex",
  );
  const path = resolve(data, "listing.mp4");
  await writeFile(path, video);
  const cached = await call("cache_goodfinds_media", { files: [{ path, label: "Seller video" }] });
  assert.equal(cached.isError, undefined);
  const content = z
    .object({ media: z.array(z.object({ id: z.string(), mime_type: z.string() })) })
    .parse(cached.structuredContent);
  const media = content.media[0];
  assert.ok(media);
  assert.equal(media.mime_type, "video/mp4");
  const row = {
    source: "facebook_marketplace",
    provenance: "manual",
    listing_id: "987654321",
    title: "Coffee machine",
    product: "coffee_machine",
    price_minor: 20000,
    price_kind: "asking",
    currency: "GBP",
    url: "https://www.facebook.com/marketplace/item/987654321/",
    videos: [{ media_id: media.id, position: 1, caption: "Seller demonstration" }],
  };
  const imported = await call("import_goodfinds_listing_observations", { observations: [row] });
  assert.equal(imported.isError, undefined, JSON.stringify(imported));
  const state = stateFromToolResult(imported);
  assert.deepEqual(state.listings[0]?.videos, row.videos);
  assert.ok(!JSON.stringify(state).includes(video.toString("base64")));
  const result = await call("get_goodfinds_video", { media_id: media.id });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    mime_type: "video/mp4",
    data: video.toString("base64"),
  });
  const image = await call("get_goodfinds_image", { media_id: media.id });
  assert.equal(image.isError, true);
});

void test("price-only and partial refreshes retain saved photos/videos and validate media types and coverage", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-retain-media-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const fn = calls.get(name);
    assert.ok(fn);
    return fn(args);
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
    "base64",
  );
  const mp4 = Buffer.from(
    "000000186674797069736f6d0000020069736f6d6d703432000000086d646174",
    "hex",
  );
  const path = resolve(data, "photo.png"),
    videoPath = resolve(data, "seller.mp4");
  await writeFile(path, png);
  await writeFile(videoPath, mp4);
  const cached = z.object({ media: z.array(z.object({ id: z.string() })) }).parse(
    (
      await call("cache_goodfinds_media", {
        files: [
          { path, label: "Photo" },
          { path: videoPath, label: "Video" },
        ],
      })
    ).structuredContent,
  );
  const photo = cached.media[0],
    video = cached.media[1];
  assert.ok(photo);
  assert.ok(video);
  const base = {
    source: "facebook_marketplace",
    provenance: "manual",
    listing_id: "234567891",
    title: "Mac mini",
    price_kind: "asking",
    availability: "active",
    product: "mac_mini",
    price_minor: 50000,
    currency: "GBP",
    url: "https://www.facebook.com/marketplace/item/234567891/",
  };
  const capture = { status: "complete", expected_photos: 1, expected_videos: 1 };
  const first = {
    ...base,
    observed_at: new Date(Date.now() - 30000).toISOString(),
    photos: [{ media_id: photo.id, position: 1, caption: "Photo" }],
    videos: [
      { media_id: video.id, position: 1, caption: "Demonstration", poster_media_id: photo.id },
    ],
    media_capture: capture,
    image_review: { total_images: 1, reviewed_positions: [1], complete: true },
    video_review: { total_videos: 1, reviewed_positions: [1], complete: true },
  };
  const initial = await call("import_goodfinds_listing_observations", { observations: [first] });
  assert.equal(initial.isError, undefined, JSON.stringify(initial));
  const refreshed = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        {
          ...base,
          observed_at: new Date(Date.now() - 20000).toISOString(),
          price_minor: 40000,
          collection_stage: "verification",
        },
      ],
    }),
  );
  assert.deepEqual(refreshed.listings[0]?.photos, first.photos);
  assert.deepEqual(refreshed.listings[0]?.videos, first.videos);
  assert.equal(
    refreshed.listings[0]?.video_review,
    undefined,
    "Saved files must not silently inherit verification",
  );
  assert.equal(refreshed.listings[0]?.price_minor, 40000);
  const partial = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        {
          ...base,
          observed_at: new Date(Date.now() - 10000).toISOString(),
          photos: [],
          videos: [],
          media_capture: { status: "partial", notes: "Download interrupted" },
        },
      ],
    }),
  );
  assert.deepEqual(partial.listings[0]?.videos, first.videos);
  assert.deepEqual(partial.listings[0]?.photos, first.photos);
  await Promise.all(
    [
      { videos: [{ media_id: photo.id, position: 1, caption: "Wrong type" }] },
      { photos: [{ media_id: video.id, position: 1, caption: "Wrong type" }] },
      {
        videos: first.videos,
        video_review: { total_videos: 0, reviewed_positions: [], complete: true },
      },
      {
        videos: first.videos,
        video_review: { total_videos: 2, reviewed_positions: [1], complete: true },
      },
      {
        videos: first.videos,
        media_capture: { status: "complete", expected_photos: 0, expected_videos: 2 },
      },
    ].map(async (invalid) => {
      assert.equal(
        (
          await call("import_goodfinds_listing_observations", {
            observations: [{ ...base, ...invalid }],
          })
        ).isError,
        true,
      );
    }),
  );
  const cleared = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        {
          ...base,
          photos: [],
          videos: [],
          media_capture: { status: "complete", expected_photos: 0, expected_videos: 0 },
        },
      ],
    }),
  );
  assert.deepEqual(cleared.listings[0]?.photos, []);
  assert.deepEqual(cleared.listings[0]?.videos, []);
});
