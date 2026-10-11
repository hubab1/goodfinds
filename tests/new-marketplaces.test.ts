import { nativeBinary } from "./helpers/native-driver.ts";
// Deterministic storage/contract regressions. Live browser outcomes are in docs/us-marketplace-validation.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import {
  marketplaceSchema,
  marketHome,
  marketSearchUrl,
  isMarketplaceUrl,
} from "@goodfinds/contracts/integrations";
import { resolveRegion } from "@goodfinds/contracts/regional";
import { startConnectionCheckSchema } from "@goodfinds/contracts/connection-checks";
import cases from "./fixtures/new-marketplaces.json";

const ids = (country: string, fulfilment: "collection" | "delivery") =>
  resolveRegion({}, { country, fulfilment }, {}, "clothing").marketplaces.map((m) => m.id);

void test("country support is curated independently of brand availability", () => {
  for (const fixture of cases) {
    const source = marketplaceSchema.parse(fixture.source);
    assert.ok(marketSearchUrl(source, fixture.query, fixture.country));
    assert.ok(isMarketplaceUrl(fixture.url, source));
  }
  assert.equal(marketHome("depop", "GB"), "https://www.depop.com/gb/");
  assert.equal(
    marketSearchUrl("depop", "nike hoodie", "GB"),
    "https://www.depop.com/search/?q=nike%20hoodie",
  );
  for (const source of ["cargurus", "poshmark", "mercari", "cars_com", "autotrader_us"] as const) {
    assert.equal(marketHome(source, "GB"), undefined);
    assert.equal(marketHome(source, "DE"), undefined);
    assert.equal(marketHome(source), undefined);
  }
  assert.equal(isMarketplaceUrl("https://www.cargurus.co.uk/details/459673970", "cargurus"), false);
  for (const host of ["jp.mercari.com", "japan.us.mercari.com", "mercari.com.attacker.example"])
    assert.equal(isMarketplaceUrl(`https://${host}/us/item/m32963257828/`, "mercari"), false);
  assert.deepEqual(ids("US", "delivery"), ["poshmark", "depop", "mercari", "ebay"]);
  assert.deepEqual(ids("GB", "delivery"), ["vinted", "depop", "ebay"]);
  assert.deepEqual(ids("US", "collection"), ["ebay", "facebook_marketplace"]);
  assert.equal(
    startConnectionCheckSchema.parse({
      request_id: crypto.randomUUID(),
      expected_entity_revision: "a".repeat(64),
      marketplaces: marketplaceSchema.options,
    }).marketplaces?.length,
    12,
  );
});

void test(
  `native new marketplaces retain listing facts, identity and ordered media`,
  { timeout: 30000 },
  async (t) => {
    const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-new-marketplaces-"));
    const client = new Client({ name: "New marketplace regression", version: "1" });
    t.after(async () => {
      await client.close();
      await rm(folder, { recursive: true, force: true });
    });
    await client.connect(
      new StdioClientTransport({
        command: nativeBinary,
        args: [],
        env: { PATH: "", GOODFINDS_WORKSPACE_DIR: folder },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const importTool = (await client.listTools()).tools.find(
      (tool) => tool.name === "import_goodfinds_listing_observations",
    );
    assert.ok(importTool);
    const categoryContract = z
      .object({
        properties: z.object({
          observations: z.object({
            items: z.object({ properties: z.object({ category_path: z.unknown() }) }),
          }),
        }),
      })
      .parse(importTool.inputSchema).properties.observations.items.properties.category_path;
    assert.match(JSON.stringify(categoryContract), /"type":"string"/u);
    assert.match(JSON.stringify(categoryContract), /"type":"null"/u);
    assert.doesNotMatch(JSON.stringify(categoryContract), /"type":"array"/u);
    const path = resolve(folder, "fixture.png");
    await writeFile(
      path,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const media = z
      .object({ media: z.array(z.object({ id: z.string() })) })
      .parse(
        await call("cache_goodfinds_media", { files: [{ path, label: "Synthetic test photo" }] }),
      ).media[0];
    assert.ok(media);
    // Signature acceptance is separate from image decoding; live AVIF files are also tested in the audit.
    const avif = resolve(folder, "fixture.avif");
    await writeFile(avif, Buffer.from("00000018667479706176696600000000617669666d696631", "hex"));
    const cachedAvif = z.object({ media: z.array(z.object({ mime_type: z.string() })) }).parse(
      await call("cache_goodfinds_media", {
        files: [{ path: avif, label: "Synthetic AVIF container header" }],
      }),
    );
    assert.equal(cachedAvif.media[0]?.mime_type, "image/avif");
    const observed_at = new Date(Date.now() - 1000).toISOString();
    await Promise.all(
      cases.map(async (fixture) => {
        const observation = {
          source: fixture.source,
          listing_id: fixture.listing_id,
          url: `${fixture.url}?tracking=test#gallery`,
          title: `Regression fixture: ${fixture.query}`,
          product: fixture.category,
          category_path: fixture.category === "clothing" ? "Men > Tops > Hoodies" : null,
          description: fixture.description,
          location: fixture.location,
          attributes: fixture.attributes,
          price_minor: fixture.price_minor,
          price_kind: "asking",
          currency: fixture.currency,
          shipping_minor: 299,
          buyer_fee_minor: 130,
          costs_complete: false,
          seller_name: "Fixture seller",
          seller_profile_url: fixture.profile,
          provenance: "manual",
          collection_stage: "discovery",
          availability: "active",
          observed_at,
          evidence: {
            description: fixture.description,
            location: fixture.location ?? "Location not shown",
          },
          photos: [{ media_id: media.id, position: 1, caption: "Synthetic test fixture" }],
          media_capture: {
            status: "partial",
            expected_photos: fixture.expected_photos,
            expected_videos: 0,
            notes: "Synthetic fixture: only one captured photo",
          },
        };
        await call("import_goodfinds_listing_observations", { observations: [observation] });
        const listing_key = `manual:${fixture.source}:${fixture.listing_id}`;
        const saved = operations.get_listing.output.parse(
          await call("get_goodfinds_listing", { listing_key }),
        ).listing;
        assert.equal(saved.url, fixture.url.replace(/\/$/u, ""));
        assert.equal(saved.price_minor, fixture.price_minor);
        assert.equal(saved.currency, fixture.currency);
        assert.equal(saved.location, fixture.location);
        assert.equal(saved.description, fixture.description);
        assert.equal(saved["category_path"], observation.category_path);
        assert.deepEqual(saved.attributes, fixture.attributes);
        assert.equal(saved.seller_profile_url, fixture.profile);
        assert.equal(saved.photos?.[0]?.media_id, media.id);
        assert.equal(saved.photos?.[0]?.position, 1);
        assert.equal(saved.media_capture?.status, "partial");
        assert.notEqual(saved.image_review?.complete, true);
        assert.equal(saved.quality?.eligibility["deal_alert"]?.eligible, false);
        assert.ok(
          saved.quality?.eligibility["deal_alert"]?.reasons.includes(
            "Provisional discovery needs verification",
          ),
        );
        const bad = await client.callTool({
          name: "import_goodfinds_listing_observations",
          arguments: {
            observations: [{ ...observation, listing_id: `${fixture.listing_id}wrong` }],
          },
        });
        assert.equal(bad.isError, true, `${fixture.source} must reject a mismatched identifier`);
        const badCategory = await client.callTool({
          name: "import_goodfinds_listing_observations",
          arguments: { observations: [{ ...observation, category_path: ["Men", "Hoodies"] }] },
        });
        assert.equal(badCategory.isError, true, "Category arrays must not bypass the contract");
        const refresh = {
          ...observation,
          observed_at: new Date().toISOString(),
          photos: undefined,
          media_capture: undefined,
        };
        if (fixture.source === "autotrader_us")
          refresh.url = fixture.url.replace("/vehicle/", "/inventory/");
        await call("import_goodfinds_listing_observations", { observations: [refresh] });
        const refreshed = operations.get_listing.output.parse(
          await call("get_goodfinds_listing", { listing_key }),
        ).listing;
        assert.equal(refreshed.key, listing_key);
        assert.equal(refreshed.photos?.length, 1, "A later fact-only read retains media");
        if (fixture === cases[0]) {
          const verified = {
            ...observation,
            observed_at: new Date().toISOString(),
            collection_stage: "verification",
            image_review: { total_images: 1, reviewed_positions: [1], complete: true },
            media_capture: {
              status: "complete",
              expected_photos: 1,
              expected_videos: 0,
            },
          };
          await call("import_goodfinds_listing_observations", { observations: [verified] });
          const readEligibility = async () =>
            operations.get_listing.output.parse(
              await call("get_goodfinds_listing", { listing_key }),
            ).listing.quality?.eligibility["deal_alert"];
          assert.equal((await readEligibility())?.eligible, true);
          await call("import_goodfinds_listing_observations", {
            observations: [
              {
                ...verified,
                observed_at: new Date().toISOString(),
                media_capture: {
                  ...verified.media_capture,
                  status: "partial",
                  expected_videos: 1,
                },
                video_review: { total_videos: 1, reviewed_positions: [], complete: false },
              },
            ],
          });
          assert.deepEqual((await readEligibility())?.reasons, [
            "Every listing video needs inspection",
          ]);
          await call("import_goodfinds_listing_observations", {
            observations: [
              {
                ...verified,
                observed_at: new Date().toISOString(),
                image_review: { total_images: 1, reviewed_positions: [], complete: false },
                video_review: { total_videos: 0, reviewed_positions: [], complete: true },
              },
            ],
          });
          assert.deepEqual((await readEligibility())?.reasons, [
            "Every listing image needs inspection",
          ]);
        }
      }),
    );
  },
);
