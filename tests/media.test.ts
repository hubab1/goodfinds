import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cacheImages, readImage } from "../apps/server/src/platform/media.ts";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import searchImageSources from "@goodfinds/contracts/data/search-cover-sources.json" with { type: "json" };

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
  "base64",
);

void test("search covers validate cached images, survive edits and stay separate from listing evidence", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-cover-"));
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
  const initial = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  const search = initial.searches[0];
  assert.ok(search);
  const bundled = await call("get_goodfinds_image", {
    media_id: searchImageSources.rental.media_id,
  });
  assert.equal(bundled.content[0]?.type, "image");
  assert.equal(bundled.isError, undefined);
  const source = resolve(data, "cover.png");
  await writeFile(source, png);
  const [cached] = await Effect.runPromise(
    cacheImages(data, [{ path: source, label: "Representative product" }]),
  );
  assert.ok(cached);
  const image = {
    media_id: cached.id,
    kind: "manufacturer",
    alt: "Representative MacBook Pro photo",
    source_name: "Apple",
    source_url: "https://www.apple.com/uk/macbook-pro/",
  };
  const request = {
    expected_entity_revision: initial.revisions.searches[search.id] ?? initial.revisions.absent,
    search_id: search.id,
    cover: image,
  };
  assert.equal(
    (
      await call("set_goodfinds_search_cover", {
        ...request,
        cover: { ...image, media_id: "a".repeat(64) },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await call("set_goodfinds_search_cover", {
        ...request,
        cover: { ...image, source_url: "javascript:alert(1)" },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await call("set_goodfinds_search_cover", {
        ...request,
        cover: { ...image, kind: "generated" },
      })
    ).isError,
    true,
  );
  assert.equal(
    stateFromToolResult(await call("get_goodfinds_workspace", {})).revision,
    initial.revision,
  );
  const saved = stateFromToolResult(await call("set_goodfinds_search_cover", request));
  assert.deepEqual(saved.searches[0]?.cover, image);
  assert.equal(saved.listings.length, 0);
  assert.ok(!JSON.stringify(saved).includes(png.toString("base64")));
  assert.equal((await call("set_goodfinds_search_cover", request)).isError, true);
  const edited = stateFromToolResult(
    await call("save_goodfinds_search", {
      expected_entity_revision: revisionFor(saved, "save_goodfinds_search", {
        search: { id: search.id },
      }),
      search: {
        id: search.id,
        name: "Updated search",
        product: search.product,
        enabled: search.enabled,
        definition: search.definition,
        values: search.values,
      },
    }),
  );
  assert.deepEqual(edited.searches[0]?.cover, image);
  assert.deepEqual(
    stateFromToolResult(await call("get_goodfinds_workspace", {})).searches[0]?.cover,
    image,
  );
  const sample = stateFromToolResult(await call("get_goodfinds_workspace", { mode: "sample" }));
  await call("set_goodfinds_search_cover", {
    mode: "sample",
    expected_entity_revision: revisionFor(sample, "set_goodfinds_search_cover", {
      search_id: search.id,
    }),
    search_id: search.id,
    cover: { ...image, alt: "Sample cover" },
  });
  assert.deepEqual(
    stateFromToolResult(await call("get_goodfinds_workspace", {})).searches[0]?.cover,
    image,
  );
  const restored = stateFromToolResult(
    await call("set_goodfinds_search_cover", {
      expected_entity_revision: revisionFor(edited, "set_goodfinds_search_cover", {
        search_id: search.id,
      }),
      search_id: search.id,
      cover: null,
    }),
  );
  assert.equal(restored.searches[0]?.cover, undefined);
  assert.equal(restored.searches[0]?.name, "Updated search");
});

void test("downloaded images persist by content ID, deduplicate and reject unsafe reads", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-media-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const source = resolve(data, "download.png");
  await writeFile(source, png);
  const media = await Effect.runPromise(
    cacheImages(data, [
      { path: source, label: "Photo 1" },
      { path: source, label: "Same photo" },
    ]),
  );
  assert.equal(media.length, 2);
  const first = media[0];
  assert.ok(first);
  assert.equal(first.id, media[1]?.id);
  await rm(source);
  const image = await Effect.runPromise(readImage(data, first.id));
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, png.toString("base64"));
  await assert.rejects(Effect.runPromise(readImage(data, "../../searches.json")));
  await writeFile(resolve(data, "media", first.id), Buffer.from("changed"));
  await assert.rejects(Effect.runPromise(readImage(data, first.id)), /changed/);
  await writeFile(source, png);
  await Effect.runPromise(cacheImages(data, [{ path: source, label: "Re-downloaded" }]));
  assert.equal((await Effect.runPromise(readImage(data, first.id))).data, image.data);
  await writeFile(source, "<svg onload='alert(1)'></svg>");
  await assert.rejects(
    Effect.runPromise(cacheImages(data, [{ path: source, label: "Unsupported" }])),
    /file types/,
  );
});

void test("bundled cover aliases verify replacement hashes and preserve cached originals", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-cover-alias-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const source = resolve(data, "original.png");
  await writeFile(source, png);
  const oldId = createHash("sha256").update(png).digest("hex");
  const replacement = await readFile(
    resolve(import.meta.dir, "../assets/search-covers", searchImageSources.rental.file),
  );
  const path = resolve(data, "replacement.webp");
  await writeFile(path, replacement);
  const bundled = { path, mediaId: searchImageSources.rental.media_id };
  const image = await Effect.runPromise(readImage(data, oldId, bundled));
  assert.equal(image.mimeType, "image/webp");
  assert.equal(image.data, replacement.toString("base64"));

  await Effect.runPromise(cacheImages(data, [{ path: source, label: "Original cover" }]));
  assert.equal(
    (await Effect.runPromise(readImage(data, oldId, bundled))).data,
    png.toString("base64"),
  );
  await writeFile(resolve(data, "media", oldId), Buffer.from("changed"));
  await assert.rejects(Effect.runPromise(readImage(data, oldId, bundled)), /changed/);
  await rm(resolve(data, "media", oldId));
  await writeFile(path, png);
  await assert.rejects(Effect.runPromise(readImage(data, oldId, bundled)), /changed/);
});

void test("MCP import requires cached image references and the panel loads bytes separately", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-media-tools-"));
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
  const row = {
    source: "facebook_marketplace",
    provenance: "manual",
    listing_id: "123",
    title: "Image test",
    product: "mac_mini",
    price_minor: 50000,
    price_kind: "asking",
    currency: "GBP",
    url: "https://www.facebook.com/marketplace/item/123/",
    photos: [{ media_id: "a".repeat(64), position: 1, caption: "Photo" }],
    image_review: { total_images: 1, reviewed_positions: [1], complete: true },
    seller_public_profile_url: "https://www.facebook.com/profile.php?id=456",
    seller_profile_url: "https://www.facebook.com/marketplace/profile/456/",
    seller_listing_count: 0,
    seller_listing_count_text: "0 listings",
    seller_listing_count_precision: "exact",
    seller_listings_checked_at: new Date().toISOString(),
    seller_friend_count: 10,
    seller_friend_count_text: "10 friends",
    seller_friend_count_precision: "exact",
    seller_profile_checked_at: new Date().toISOString(),
    evidence: {
      seller_friend_count: "Profile header: 10 friends",
      seller_listing_count: "0 current listings",
    },
  };
  assert.equal(
    (await call("import_goodfinds_listing_observations", { observations: [row] })).isError,
    true,
  );
  assert.equal(stateFromToolResult(await call("get_goodfinds_workspace", {})).counts.listings, 0);
  const source = resolve(data, "download.png");
  await writeFile(source, png);
  const [cached] = await Effect.runPromise(cacheImages(data, [{ path: source, label: "Photo" }]));
  assert.ok(cached);
  row.photos[0] = { media_id: cached.id, position: 1, caption: "Photo" };
  const state = stateFromToolResult(
    await call("import_goodfinds_listing_observations", { observations: [row] }),
  );
  assert.equal(state.listings[0]?.photos[0]?.media_id, cached.id);
  assert.equal(state.listings[0]?.seller_listing_count, 0);
  assert.equal(state.listings[0]?.seller_listing_count_precision, "exact");
  assert.equal(state.listings[0]?.seller_listing_count_text, "0 listings");
  assert.equal(state.listings[0]?.seller_friend_count, 10);
  assert.equal(state.listings[0]?.seller_friend_count_text, "10 friends");
  assert.equal(state.listings[0]?.seller_friend_count_precision, "exact");
  assert.equal(state.listings[0]?.seller_public_profile_url, row.seller_public_profile_url);
  assert.ok(!JSON.stringify(state).includes(png.toString("base64")));
  const result = await call("get_goodfinds_image", { media_id: cached.id });
  assert.equal(result.content[0]?.type, "image");
  assert.ok((await readFile(resolve(data, "media", cached.id))).equals(png));
});
