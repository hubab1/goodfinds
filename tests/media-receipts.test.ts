import { nativeBinary } from "./helpers/native-driver.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

void test(`native accepts and replays media attachment receipts`, { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(resolve(tmpdir(), "goodfinds-media-receipts-"));
  const client = new Client({ name: "Media receipt test", version: "1" });
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
  const path = resolve(folder, "photo.png");
  await writeFile(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const cached = await client.callTool({
    name: "cache_goodfinds_media",
    arguments: { files: [{ path, label: "Fictional test photo" }] },
  });
  const media = z
    .object({ media: z.array(z.object({ id: z.string() })) })
    .parse(cached.structuredContent).media[0];
  assert.ok(media);
  const imported = await client.callTool({
    name: "import_goodfinds_listing_observations",
    arguments: {
      observations: [
        {
          source: "vinted",
          provenance: "manual",
          listing_id: "123456789",
          url: "https://www.vinted.co.uk/items/123456789-fictional-hoodie",
          title: "Fictional hoodie",
          product: "clothing",
          price_minor: 1000,
          currency: "GBP",
          price_kind: "asking",
          collection_stage: "discovery",
          observed_at: new Date().toISOString(),
        },
      ],
    },
  });
  assert.equal(imported.isError, undefined, JSON.stringify(imported.structuredContent));
  const args = {
    request_id: randomUUID(),
    listing_key: "manual:vinted:123456789",
    photos: [{ media_id: media.id, position: 1, caption: "Fictional thumbnail" }],
    media_capture: { status: "partial", notes: "Search thumbnail only; gallery unknown" },
  };
  const receipt = z.object({
    receipt: z.object({ replayed: z.boolean() }),
    photos_count: z.number(),
  });
  const first = await client.callTool({
    name: "attach_goodfinds_listing_media",
    arguments: args,
  });
  assert.equal(first.isError, undefined, JSON.stringify(first.content));
  const committed = receipt.parse(first.structuredContent);
  assert.equal(committed.receipt.replayed, false);
  const second = await client.callTool({
    name: "attach_goodfinds_listing_media",
    arguments: args,
  });
  assert.equal(second.isError, undefined, JSON.stringify(second.structuredContent));
  const replayed = receipt.parse(second.structuredContent);
  assert.equal(replayed.receipt.replayed, true);
  assert.equal(replayed.photos_count, 1);
  const changed = await client.callTool({
    name: "attach_goodfinds_listing_media",
    arguments: { ...args, photos: [] },
  });
  assert.equal(changed.isError, true, "A receipt cannot authorize different media arguments");
});
