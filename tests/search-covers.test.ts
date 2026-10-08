import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGoodfindsServer } from "@goodfinds/server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { rentalCoverFor, rentalCovers } from "@goodfinds/contracts/rental-cover";
import { SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { searchCoverSchema, searchCoverFollowUp } from "@goodfinds/contracts/search-cover";
import {
  bundledSearchCoverFor,
  marketplaceCovers,
  searchCoverCategorySchema,
  vehicleCovers,
} from "@goodfinds/contracts/search-cover-presets";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import coverSources from "@goodfinds/contracts/data/search-cover-sources.json" with { type: "json" };

void test("Mac families require workspace photos and generic vehicle illustrations do not satisfy named models", () => {
  for (const [category, product] of [
    ["macbook_pro", "MacBook Pro"],
    ["mac_mini", "Mac mini"],
    ["mac_pro", "Mac Pro"],
  ] as const) {
    assert.deepEqual(searchCoverFollowUp({ id: category, product: category }), {
      search_id: category,
      product,
      action: "fetch_manufacturer_photo",
      required: true,
    });
  }
  assert.equal(bundledSearchCoverFor({ product: "mac_mini", values: {} }), undefined);
  assert.equal(searchCoverFollowUp({ id: "unknown", product: "constructor" }), null);
  assert.equal(
    searchCoverFollowUp({
      id: "custom-image",
      product: "mac_mini",
      cover: {
        media_id: vehicleCovers.sedan.media_id,
        kind: "user",
        alt: "Buyer's chosen image",
        source_name: "Buyer",
      },
    }),
    null,
  );
  assert.equal(
    searchCoverFollowUp({
      id: "generic-car",
      product: "vehicle",
      discovery: { scope: "help_choose", model_attribute: "model" },
    }),
    null,
  );
  assert.equal(
    searchCoverFollowUp({
      id: "named-car",
      product: "vehicle",
      discovery: { scope: "exact", reference_model: "Ford Focus", model_attribute: "model" },
      cover: {
        media_id: vehicleCovers.sedan.media_id,
        kind: "generated",
        alt: vehicleCovers.sedan.alt,
        source_name: vehicleCovers.sedan.source_name,
        prompt: vehicleCovers.sedan.prompt,
      },
    })?.product,
    "Ford Focus",
  );
});

void test("vehicle defaults use explicit types and preserve ambiguity", () => {
  for (const [search, preset] of [
    [{ product: "vehicle", values: { body_type: "sedan" } }, "sedan"],
    [{ product: "car", values: { body_type: ["4x4"] as string[] } }, "4x4"],
    [{ product: "vehicle", values: { vehicle_type: "motorcycle" } }, "motorbike"],
    [{ product: "boat", values: {} }, "boat"],
  ] as const)
    assert.equal(bundledSearchCoverFor(search)?.media_id, vehicleCovers[preset].media_id);
  for (const search of [
    { product: "car", values: {} },
    { product: "vehicle", values: { body_type: ["sedan", "suv"] } },
    { product: "camera", values: { body_type: "sedan" } },
  ])
    assert.equal(bundledSearchCoverFor(search), undefined);
});

void test("marketplace defaults recognize item types without guessing a broad furniture or baby brief", () => {
  for (const [product, preset] of [
    ["sofa", "sofa"],
    ["couch", "sofa"],
    ["dining_set", "dining_set"],
    ["wardrobe", "wardrobe"],
    ["chest_of_drawers", "chest_of_drawers"],
    ["sideboard", "sideboard"],
    ["bicycle", "bicycle"],
    ["garden_furniture", "garden_furniture"],
    ["pushchair", "pram"],
  ] as const)
    assert.equal(
      bundledSearchCoverFor({ product, values: {} })?.media_id,
      marketplaceCovers[preset].media_id,
    );
  for (const product of ["furniture", "baby", "garden", "constructor"])
    assert.equal(bundledSearchCoverFor({ product, values: {} }), undefined);
  const {
    category: _category,
    file: _file,
    generated_at: _date,
    label: _label,
    ...cover
  } = marketplaceCovers.sofa;
  assert.equal(
    searchCoverFollowUp({
      id: "named-sofa",
      product: "sofa",
      discovery: { scope: "exact", reference_model: "IKEA KIVIK", model_attribute: "model" },
      cover: searchCoverSchema.parse(cover),
    })?.product,
    "IKEA KIVIK",
  );
});

void test("rental defaults follow explicit search countries and keep ambiguous places neutral", () => {
  for (const [area, preset] of [
    ["Austin, Texas, US", "us"],
    ["London, Ontario, Canada", "ca"],
    ["Sydney, Australia", "au"],
    ["Lyon, France", "fr"],
    ["Berlin, Deutschland", "de"],
    ["Birmingham, U.K.", "gb"],
    ["London", "neutral"],
    ["Paris, Texas", "neutral"],
    ["Los Angeles, CA", "neutral"],
    ["Wilmington, DE", "neutral"],
    ["Valencia, Spain", "neutral"],
  ] as const)
    assert.equal(rentalCoverFor({ area }).media_id, rentalCovers[preset].media_id, area);
  assert.equal(
    rentalCoverFor({ currency: "GBP", language: "en-GB" }).media_id,
    rentalCovers.neutral.media_id,
  );
  assert.equal(
    rentalCoverFor({ area: "Paris, France", country: "CA" }).media_id,
    rentalCovers.ca.media_id,
  );
  assert.equal(
    rentalCoverFor({ area: "Paris, France", country: "Spain" }).media_id,
    rentalCovers.neutral.media_id,
  );
});

void test("identified products return required photo follow-up until a local cover is attached, and reuse it after budget edits", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-required-cover-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const fn = calls.get(name);
    assert.ok(fn);
    const result = await fn(args);
    assert.equal(result.isError, undefined);
    return result;
  };
  const state = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  const original = state.config.searches[0];
  assert.ok(original);
  const search = {
    ...original,
    id: "ninja-cover-example",
    name: "Ninja CRISPi",
    product: "air_fryer",
    definition: { ...original.definition, category: "air_fryer", title: "Ninja CRISPi" },
    discovery: { scope: "exact", reference_model: "Ninja CRISPi" },
  };
  const saved = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: state.revisions.absent,
        search,
      })
    ).structuredContent,
  );
  assert.deepEqual(saved.cover_follow_up, {
    search_id: search.id,
    product: "Ninja CRISPi",
    action: "fetch_manufacturer_photo",
    required: true,
  });
  const context = operations.get_search_context.output.parse(
    (await call("get_goodfinds_search_context", { search_id: search.id })).structuredContent,
  );
  assert.deepEqual(context.cover_follow_ups, [saved.cover_follow_up]);
  assert.deepEqual(
    operations.get_search_context.output.parse(
      (await call("get_goodfinds_search_context", { search_id: original.id })).structuredContent,
    ).cover_follow_ups,
    [
      {
        search_id: original.id,
        product: "MacBook Pro",
        action: "fetch_manufacturer_photo",
        required: true,
      },
    ],
    "Mac searches also need a photo fetched into the workspace",
  );
  const fixture = resolve(data, "product-photo.png");
  await writeFile(
    fixture,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const cached = await call("cache_goodfinds_images", {
    files: [
      {
        path: fixture,
        label: "Offline manufacturer-photo fixture",
      },
    ],
  });
  const media = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(cached.structuredContent).media[0];
  assert.ok(media);
  const cover = {
    media_id: media.id,
    kind: "manufacturer",
    alt: "Representative product photo",
    source_name: "Example maker",
    source_url: "https://example.com/product",
  };
  const attached = operations.set_search_cover.output.parse(
    (
      await call("set_goodfinds_search_cover", {
        search_id: search.id,
        expected_entity_revision: saved.revisions.searches[search.id],
        cover,
      })
    ).structuredContent,
  );
  assert.equal(attached.cover_follow_up, null);
  assert.deepEqual(attached.search?.cover, cover);
  const edited = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: attached.revisions.searches[search.id],
        search: { ...search, values: { ...search.values, max_price_minor: 15000 } },
      })
    ).structuredContent,
  );
  assert.equal(edited.cover_follow_up, null);
  assert.deepEqual(edited.search?.cover, cover);
  assert.deepEqual(
    operations.get_search_context.output.parse(
      (await call("get_goodfinds_search_context", { search_id: search.id })).structuredContent,
    ).cover_follow_ups,
    [],
  );
  const changed = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: edited.revisions.searches[search.id],
        search: {
          ...edited.search,
          discovery: { scope: "exact", reference_model: "Ninja Speedi" },
        },
      })
    ).structuredContent,
  );
  assert.equal(changed.search?.cover, undefined);
  assert.equal(changed.cover_follow_up?.product, "Ninja Speedi");
});

void test("the generic cover catalog serves matching local assets and a named vehicle replaces its illustration", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-generic-covers-"));
  const { server, calls } = createGoodfindsServer(seedWorkspace(data));
  t.after(async () => {
    await server.close();
    await rm(data, { recursive: true, force: true });
  });
  const call = async (name: string, args: unknown) => {
    const fn = calls.get(name);
    assert.ok(fn);
    const result = await fn(args);
    assert.equal(result.isError, undefined);
    return result;
  };
  const catalogSchema = z.object({
    covers: z.array(
      z.object({
        category: searchCoverCategorySchema,
        preset: z.string(),
        cover: searchCoverSchema,
      }),
    ),
  });
  const options = catalogSchema.parse(
    (await call("list_goodfinds_search_covers", { category: "vehicle" })).structuredContent,
  ).covers;
  assert.deepEqual(options.map((option) => option.preset).toSorted(), [
    "4x4",
    "boat",
    "motorbike",
    "sedan",
  ]);
  const all = catalogSchema.parse(
    (await call("list_goodfinds_search_covers", {})).structuredContent,
  ).covers;
  assert.equal(all.filter((option) => option.category === "rental").length, 7);
  assert.deepEqual(
    catalogSchema
      .parse(
        (await call("list_goodfinds_search_covers", { category: "furniture" })).structuredContent,
      )
      .covers.map((option) => option.preset)
      .toSorted(),
    ["chest_of_drawers", "dining_set", "sideboard", "sofa", "wardrobe"],
  );
  assert.equal(all.length, 19);
  let totalBytes = 0;
  await Promise.all(
    all.map(async (option) => {
      const image = (await call("get_goodfinds_image", { media_id: option.cover.media_id }))
        .content[0];
      assert.equal(image?.type, "image");
      assert.ok(image && image.type === "image");
      assert.equal(image.mimeType, "image/webp");
      const bytes = Buffer.from(image.data, "base64");
      assert.ok(bytes.length <= 24_000, "Each bundled cover must stay below 24 KB");
      totalBytes += bytes.length;
      assert.equal(createHash("sha256").update(bytes).digest("hex"), option.cover.media_id);
    }),
  );
  assert.ok(totalBytes <= 300_000, "The bundled cover catalog must stay below 300 KB");
  await Promise.all(
    Object.entries(coverSources.media_id_aliases).map(async ([oldId, currentId]) => {
      assert.ok(all.some((option) => option.cover.media_id === currentId));
      const image = (await call("get_goodfinds_image", { media_id: oldId })).content[0];
      assert.ok(image && image.type === "image");
      assert.equal(image.mimeType, "image/webp");
      assert.equal(
        createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"),
        currentId,
        "Previously saved cover IDs must resolve to the matching optimized illustration",
      );
    }),
  );
  const state = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  const original = state.config.searches[0];
  assert.ok(original);
  const search = {
    ...original,
    id: "generic-motorbike",
    name: "Motorbike",
    product: "motorbike",
    definition: { ...original.definition, category: "motorbike", title: "Motorbike" },
    discovery: { scope: "help_choose", model_attribute: "model" },
  };
  const saved = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: state.revisions.absent,
        search,
      })
    ).structuredContent,
  );
  assert.equal(saved.cover_follow_up, null);
  const cover = options.find((option) => option.preset === "motorbike")?.cover;
  assert.ok(cover);
  const attached = operations.set_search_cover.output.parse(
    (
      await call("set_goodfinds_search_cover", {
        search_id: search.id,
        expected_entity_revision: saved.revisions.searches[search.id],
        cover,
      })
    ).structuredContent,
  );
  assert.deepEqual(attached.search?.cover, cover);
  assert.equal(attached.cover_follow_up, null);
  const previousId = Object.entries(coverSources.media_id_aliases).find(
    ([, currentId]) => currentId === cover.media_id,
  )?.[0];
  assert.ok(previousId);
  const oldCover = { ...cover, media_id: previousId };
  const legacy = operations.set_search_cover.output.parse(
    (
      await call("set_goodfinds_search_cover", {
        search_id: search.id,
        expected_entity_revision: attached.revisions.searches[search.id],
        cover: oldCover,
      })
    ).structuredContent,
  );
  const restored = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  assert.deepEqual(restored.searches.find((item) => item.id === search.id)?.cover, oldCover);
  assert.equal(
    searchCoverFollowUp({
      id: search.id,
      product: "motorbike",
      discovery: { scope: "exact", reference_model: "Honda CB500F", model_attribute: "model" },
      cover: oldCover,
    })?.product,
    "Honda CB500F",
    "Legacy illustrations must still require a photo for a named model",
  );
  const named = operations.save_search.output.parse(
    (
      await call("save_goodfinds_search", {
        expected_entity_revision: legacy.revisions.searches[search.id],
        search: {
          ...legacy.search,
          discovery: { scope: "exact", reference_model: "Honda CB500F" },
        },
      })
    ).structuredContent,
  );
  assert.equal(named.search?.cover, undefined);
  assert.equal(named.cover_follow_up?.product, "Honda CB500F");
});

void test("regional rental covers are available locally, attach to searches and reset after an area edit", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-regional-covers-"));
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
  const catalog = await call("list_goodfinds_search_covers", { category: "rental" });
  const options = z
    .array(z.object({ preset: z.string(), cover: searchCoverSchema }))
    .parse(catalog.structuredContent?.["covers"]);
  assert.deepEqual(options.map((option) => option.preset).toSorted(), [
    "au",
    "ca",
    "de",
    "fr",
    "gb",
    "neutral",
    "us",
  ]);
  await Promise.all(
    options.map(async (option) => {
      const result = await call("get_goodfinds_image", { media_id: option.cover.media_id });
      assert.equal(result.isError, undefined, option.preset);
      assert.equal(result.content[0]?.type, "image", option.preset);
    }),
  );
  let state = stateFromToolResult(await call("get_goodfinds_workspace", {}));
  const definition = SEARCH_TEMPLATES.find((item) => item.category === "rental");
  assert.ok(definition);
  const search = {
    id: "regional-rental",
    name: "Example rental",
    product: "rental",
    enabled: true,
    definition,
    values: {
      area: "Austin, US",
      accommodation: "whole_property",
      property_type: ["house"],
      min_bedrooms: 2,
      max_price_minor: 120000,
    },
  };
  state = stateFromToolResult(
    await call("save_goodfinds_search", {
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", { search }),
      search,
    }),
  );
  const selected = options.find((option) => option.preset === "us");
  assert.ok(selected);
  const image = { ...searchCoverSchema.parse(selected.cover), location: search.values.area };
  state = stateFromToolResult(
    await call("set_goodfinds_search_cover", {
      expected_entity_revision: revisionFor(state, "set_goodfinds_search_cover", {
        search_id: search.id,
      }),
      search_id: search.id,
      cover: image,
    }),
  );
  assert.deepEqual(state.searches.find((item) => item.id === search.id)?.cover, image);
  state = stateFromToolResult(
    await call("save_goodfinds_search", {
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", {
        search: { ...search },
      }),
      search: { ...search, values: { ...search.values, max_price_minor: 130000 } },
    }),
  );
  assert.deepEqual(state.searches.find((item) => item.id === search.id)?.cover, image);
  state = stateFromToolResult(
    await call("save_goodfinds_search", {
      expected_entity_revision: revisionFor(state, "save_goodfinds_search", {
        search: { ...search },
      }),
      search: { ...search, values: { ...search.values, area: "London, Ontario, Canada" } },
    }),
  );
  const moved = state.searches.find((item) => item.id === search.id);
  assert.ok(moved);
  assert.equal(moved.cover, undefined);
  assert.equal(rentalCoverFor(moved.values).media_id, rentalCovers.ca.media_id);
  assert.equal(
    (
      await call("set_goodfinds_search_cover", {
        expected_entity_revision: revisionFor(state, "set_goodfinds_search_cover", {
          search_id: search.id,
        }),
        search_id: search.id,
        cover: image,
      })
    ).isError,
    true,
  );
  assert.equal(
    stateFromToolResult(await call("get_goodfinds_workspace", {})).revision,
    state.revision,
  );
});
