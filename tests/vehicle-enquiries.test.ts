import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { savedSearchSchema, SEARCH_TEMPLATES } from "@goodfinds/contracts/search-definition";
import { openingDraft } from "@goodfinds/contracts/buying-next-steps";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";

const definition = SEARCH_TEMPLATES.find((template) => template.category === "vehicle");
assert.ok(definition);
const search = savedSearchSchema.parse({
  id: "vehicle-enquiry",
  name: "Automatic vehicle",
  product: "vehicle",
  enabled: true,
  marketplaces: ["gumtree"],
  definition,
  values: { transmission: "automatic", clean_history: true, fully_functioning: true },
  discovery: {
    scope: "alternatives",
    verification_checks: [
      { id: "clean_history", label: "Clean history", question: "Is the history clear?" },
      { id: "fully_functioning", label: "Functioning", question: "Does it run fault-free?" },
    ],
  },
});

function draft(t: TestContext, extra: Record<string, unknown>) {
  const dir = mkdtempSync(resolve(tmpdir(), "goodfinds-vehicle-enquiry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new NativeWorkspace(seedWorkspace(dir));
  const initial = Effect.runSync(store.request("get_workspace")).state;
  Effect.runSync(
    store.request("save_search", {
      search,
      expected_entity_revision: revisionFor(initial, "save_search", { search }),
    }),
  );
  const listing = Effect.runSync(
    store.request("import_listing_observations", {
      observations: [
        {
          source: "gumtree",
          provenance: "manual",
          listing_id: "1800429964",
          url: "https://www.gumtree.com/p/nissan/example/1800429964",
          title: "2015 Nissan Juke",
          product: "vehicle",
          observed_at: "2026-10-24T17:00:00Z",
          price_minor: 549500,
          price_kind: "asking",
          currency: "GBP",
          availability: "active",
          collection_stage: "verification",
          attributes: { transmission: "automatic" },
          ...extra,
        },
      ],
    }),
  ).state.listings[0];
  assert.ok(listing);
  const prepared = Effect.runSync(
    store.request("prepare_next_steps", { search_id: search.id }),
  ).state;
  const native = Effect.runSync(
    store.request("get_seller_conversation", { listing_key: listing.key }),
  ).state.seller_conversation;
  assert.ok(native);
  assert.ok(native.draft, JSON.stringify(prepared.decisions.map((item) => item.reasons)));
  const panel = openingDraft(listing, search);
  assert.deepEqual(native.draft?.verification_questions, panel.verification_questions);
  assert.equal(native.draft?.text, panel.text);
  assert.equal(native.draft?.price_minor, null);
  assert.equal(native.actions.length, 0, "Preparing an enquiry never authorizes sending");
  assert.ok((panel.verification_questions?.length ?? 0) <= 2);
  assert.doesNotMatch(panel.text, /listing evidence|observations|accessories/iu);
  return panel;
}

void test("vehicle enquiries prioritize history and functioning over minor mileage discrepancies", (t) => {
  const result = draft(t, {
    field_evidence: { mileage: { state: "conflicting", raw_text: "Advert98703, odometer98774" } },
  });
  assert.deepEqual(result.verification_questions, [
    "Has it ever been written off, categorised or accident-damaged?",
    "Does it run and drive without any faults?",
  ]);
});

void test("an unconfirmed required automatic gearbox is a useful first-contact question", (t) => {
  const result = draft(t, { attributes: { transmission: null } });
  assert.deepEqual(result.verification_questions, [
    "Has it ever been written off, categorised or accident-damaged?",
    "Can you confirm it has an automatic gearbox?",
  ]);
});

void test("answered vehicle checks are not repeated and conflict wording is concrete", (t) => {
  const result = draft(t, {
    functional: true,
    condition: "good",
    attributes: { transmission: "automatic", clean_history: true, fully_functioning: true },
    evidence: { clean_history: "History checked", fully_functioning: "Functions checked" },
    field_evidence: {
      mileage_unit: { state: "conflicting", raw_text: "Km in fields, miles in description" },
    },
  });
  assert.deepEqual(result.verification_questions, ["Is the mileage shown in miles or kilometres?"]);
});
