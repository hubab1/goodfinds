import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { seedWorkspace } from "./helpers/workspace.ts";
import { NativeWorkspace } from "./helpers/native-workspace.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-evidence-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(dir));
  const identity = {
    source: "gumtree",
    provenance: "manual",
    listing_id: "1804138440",
    url: "https://www.gumtree.com/p/mazda/example/1804138440",
    product: "vehicle",
  };
  const original = {
    ...identity,
    title: "2015 Mazda 3",
    price_minor: 199500,
    currency: "GBP",
    price_kind: "asking",
    availability: "active",
    collection_stage: "verification",
    observed_at: "2026-10-24T17:00:00Z",
    attributes: { transmission: "automatic" },
  };
  const save = (observation: Record<string, unknown>) => {
    const row = Effect.runSync(
      store.request("import_listing_observations", { observations: [observation] }),
    ).state.listings[0];
    assert.ok(row);
    return row;
  };
  return {
    original,
    save,
    availability: (at: string) =>
      save({
        ...identity,
        collection_stage: "availability",
        observed_at: at,
        availability: "active",
        availability_text: "Current whole-car offer and seller contact controls",
      }),
  };
}

void test("later verification resolves an old content collision without erasing its audit event", (t) => {
  const { original, save, availability } = fixture(t);
  save(original);
  const collision = save({ ...original, attributes: { transmission: "manual" } });
  assert.equal(collision["observation_conflict"], true);
  assert.equal(
    collision.quality?.eligibility["current_stock"]?.eligible,
    true,
    "A gearbox conflict is not an availability conflict",
  );
  const statusOnly = availability("2026-10-24T17:01:00Z");
  assert.equal(
    statusOnly["observation_conflict"],
    true,
    "Availability alone cannot resolve vehicle facts",
  );
  const checked = save({
    ...original,
    observed_at: "2026-10-24T17:02:00Z",
    attributes: { transmission: null },
    field_evidence: {
      transmission: { state: "unknown", raw_text: "Selector markings unreadable" },
    },
  });
  assert.equal(checked["observation_conflict"], false);
  assert.equal(checked.attributes?.["transmission"], null);
  assert.ok(
    checked.events?.some(
      (event) => event.kind === "observation_conflict" && event["scope"] === "content",
    ),
  );
  assert.equal(checked.price_history.length, 3, "Both original observations remain in history");
  assert.equal(
    checked.quality?.eligibility["deal_alert"]?.eligible,
    false,
    "Resolving a collision does not verify the car",
  );
});

void test("a fresh availability check resolves current stock while ambiguous duration stays historical", (t) => {
  const { original, save, availability } = fixture(t);
  save(original);
  const collision = save({ ...original, availability: "sold" });
  assert.equal(collision["observation_conflict"], true);
  assert.equal(collision.quality?.eligibility["current_stock"]?.eligible, false);
  const checked = availability("2026-10-24T17:01:00Z");
  assert.equal(checked["observation_conflict"], false);
  assert.equal(checked.availability, "active");
  assert.equal(checked.quality?.eligibility["current_stock"]?.eligible, true);
  assert.equal(checked.quality?.eligibility["duration_analysis"]?.eligible, false);
  assert.ok(
    checked.events?.some(
      (event) => event.kind === "observation_conflict" && event["scope"] === "availability",
    ),
  );
});

void test("fresh verification retains explicit current evidence conflicts", (t) => {
  const { original, save } = fixture(t);
  save(original);
  save({ ...original, attributes: { transmission: "manual" } });
  const checked = save({
    ...original,
    observed_at: "2026-10-24T17:02:00Z",
    field_evidence: {
      transmission: {
        state: "conflicting",
        raw_text: "Seller automatic, explicit manual shift pattern in photo",
      },
    },
  });
  assert.equal(checked["observation_conflict"], false);
  assert.ok(checked.quality?.flags.some((flag) => flag.code === "conflicting_evidence"));
  assert.equal(checked.quality?.eligibility["price_baseline"]?.eligible, false);
});

void test("failed checks and discovery sightings cannot resolve detail collisions", (t) => {
  const { original, save } = fixture(t);
  save(original);
  save({ ...original, attributes: { transmission: "manual" } });
  const failed = save({
    ...original,
    observed_at: "2026-10-24T17:01:00Z",
    check_outcome: "not_found",
  });
  assert.equal(failed["observation_conflict"], true);
  const sighting = save({
    ...original,
    observed_at: "2026-10-24T17:02:00Z",
    collection_stage: "discovery",
  });
  assert.equal(sighting["observation_conflict"], true);
});
