import { seedWorkspace } from "./helpers/workspace.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { z } from "zod";

void test("media repair preserves listing facts and survives later refreshes and older collectors", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-media-repair-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const fn = calls.get(name);
    assert.ok(fn, `Missing tool: ${name}`);
    return fn(args);
  };
  const path = resolve(data, "photo.png");
  await writeFile(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const cached = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(
      (await call("cache_goodfinds_media", { files: [{ path, label: "Photo" }] }))
        .structuredContent,
    );
  const media = cached.media[0];
  assert.ok(media);
  const observed_at = new Date(Date.now() - 120000).toISOString();
  const row = {
    source: "facebook_marketplace",
    provenance: "manual",
    listing_id: "123456789",
    title: "Coffee machine",
    product: "coffee_machine",
    price_minor: 10000,
    currency: "GBP",
    price_kind: "asking",
    availability: "active",
    observed_at,
    collection_stage: "verification",
    url: "https://www.facebook.com/marketplace/item/123456789/",
    image_review: { total_images: 1, reviewed_positions: [1], complete: true },
  };
  const initial = stateFromToolResult(
    await call("import_goodfinds_listing_observations", { observations: [row] }),
  );
  const before = initial.listings[0];
  assert.ok(before);
  const pending = await call("list_goodfinds_media_repairs", { limit: 100 });
  assert.equal(pending.isError, undefined);
  const captured_at = new Date(Date.now() - 60000).toISOString();
  const photos = [{ media_id: media.id, position: 1, caption: "Listing photo 1" }];
  const repaired = await call("attach_goodfinds_listing_media", {
    listing_key: before.key,
    photos,
    videos: [],
    media_capture: { status: "complete", expected_photos: 1, expected_videos: 0, captured_at },
  });
  assert.equal(repaired.isError, undefined, JSON.stringify(repaired));
  const after = stateFromToolResult(repaired).listings[0];
  assert.deepEqual(after?.photos, photos);
  const finished = await call("list_goodfinds_media_repairs", { limit: 100 });
  const queue = z
    .object({ total: z.number() })
    .parse(JSON.parse(finished.content.find((item) => item.type === "text")?.text ?? "{}"));
  assert.equal(queue.total, 0);
  await Promise.all(
    [
      { listing_key: "manual:missing" },
      { videos: [{ media_id: media.id, position: 1, caption: "Image used as a video" }] },
      { photos: [...photos, ...photos] },
      { media_capture: { status: "complete", expected_photos: 2, expected_videos: 0 } },
      {
        media_capture: {
          status: "complete",
          expected_photos: 1,
          expected_videos: 0,
          captured_at: new Date(Date.now() + 600000).toISOString(),
        },
      },
    ].map(async (invalid) => {
      const result = await call("attach_goodfinds_listing_media", {
        listing_key: before.key,
        photos,
        videos: [],
        media_capture: { status: "complete", expected_photos: 1, expected_videos: 0 },
        ...invalid,
      });
      assert.equal(result.isError, true);
    }),
  );
  const partial = stateFromToolResult(
    await call("attach_goodfinds_listing_media", {
      listing_key: before.key,
      videos: [],
      media_capture: {
        status: "partial",
        expected_photos: 1,
        expected_videos: 1,
        notes: "Video download unavailable",
      },
    }),
  );
  assert.deepEqual(partial.listings[0]?.photos, photos);
  const retry = await call("list_goodfinds_media_repairs", { limit: 100 });
  const retryQueue = z
    .object({
      ready: z.number(),
      listings: z.array(z.object({ retry_at: z.string(), saved_photos: z.number() })),
    })
    .parse(JSON.parse(retry.content.find((item) => item.type === "text")?.text ?? "{}"));
  assert.equal(retryQueue.ready, 0);
  assert.equal(retryQueue.listings[0]?.saved_photos, 1);
  for (const field of [
    "observed_at",
    "last_observed_at",
    "price_minor",
    "collection_stage",
    "image_review",
    "check_outcome",
    "observation_conflict",
  ] as const)
    assert.deepEqual(after?.[field], before[field], `Media repair must preserve ${field}`);
  const db = new Database(resolve(data, "workspace.sqlite"));
  assert.equal(
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM listing_observations").get()
      ?.count,
    1,
  );
  db.query(
    "UPDATE listings SET document_json=json_remove(document_json,'$.photos','$.media_capture')",
  ).run();
  db.close();
  const reloaded = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  assert.deepEqual(
    reloaded.listings[0]?.photos,
    photos,
    "Older collectors cannot erase a repair receipt",
  );
  const details = await call("get_goodfinds_listing", { listing_key: before.key });
  assert.equal(details.isError, undefined);
  const refreshed = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        { ...row, observed_at: new Date(Date.now() - 30000).toISOString(), price_minor: 9000 },
      ],
    }),
  );
  assert.deepEqual(refreshed.listings[0]?.photos, photos);
  assert.equal(refreshed.listings[0]?.price_minor, 9000);
  const cleared = stateFromToolResult(
    await call("import_goodfinds_listing_observations", {
      observations: [
        {
          ...row,
          observed_at: new Date().toISOString(),
          photos: [],
          videos: [],
          media_capture: { status: "complete", expected_photos: 0, expected_videos: 0 },
        },
      ],
    }),
  );
  assert.deepEqual(
    cleared.listings[0]?.photos,
    [],
    "A newer complete gallery takes precedence over an old repair",
  );
});
