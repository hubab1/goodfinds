import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { operations } from "@goodfinds/contracts/operations";
import { stateSchema } from "@goodfinds/contracts/state";
import { nativeCall } from "./helpers/native-driver.ts";

void test("listing pages retain comparison peers but only detail reads load observation history", () => {
  const root = mkdtempSync(resolve(tmpdir(), "goodfinds-scoped-"));
  try {
    const state = z.object({ state: stateSchema }).parse(
      nativeCall({
        op: "operation",
        root,
        mode: "sample",
        action: "load_sample_workspace",
        args: {},
      }),
    ).state;
    const search = state.searches[0];
    assert.ok(search);
    const measure = (action: string, args: unknown) =>
      z
        .object({
          result: z.unknown(),
          measurements: z.object({ counts: z.record(z.string(), z.number()) }),
        })
        .parse(nativeCall({ op: "measure_operation", root, mode: "sample", action, args }));
    const page = measure("list_listings", { search_id: search.id, limit: 1 });
    const listings = operations.list_listings.output.parse(page.result).listings;
    assert.equal(listings.length, 1);
    assert.equal(page.measurements.counts["snapshots"] ?? 0, 0);
    assert.equal(page.measurements.counts["observations_loaded"] ?? 0, 0);
    assert.ok(
      (page.measurements.counts["listings_loaded"] ?? 0) > 1,
      "ranking still uses the complete product population",
    );
    const row = listings[0];
    assert.ok(row);
    const detail = measure("get_listing", { listing_key: row.key, search_id: search.id });
    assert.equal(
      detail.measurements.counts["observations_loaded"],
      1,
      "unrelated listing histories are not loaded",
    );
    assert.equal(detail.measurements.counts["snapshots"] ?? 0, 0);
    assert.equal(operations.get_listing.output.parse(detail.result).listing.key, row.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
