import { seedWorkspace } from "./helpers/workspace.ts";
import { revisionFor } from "./helpers/revisions.ts";
// Feedback writes and Undo must use the revision returned by the previous operation.
/* oxlint-disable eslint/no-await-in-loop */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createGoodfindsServer } from "@goodfinds/reference-server/mcp";
import { stateFromToolResult } from "@goodfinds/contracts/state";
import { listingIsDismissed, DISREGARD_REASONS } from "../apps/ui/src/lib/listing-feedback.ts";

void test("disregard reasons hide one listing in its search and Undo restores it without banning a model", async (t) => {
  const data = await mkdtemp(resolve(tmpdir(), "goodfinds-disregard-"));
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
  let state = stateFromToolResult(await call("load_goodfinds_sample_workspace", {}));
  const search = state.searches[0];
  assert.ok(search);
  const listing = state.listings.find((row) => row.product === search.product);
  assert.ok(listing);
  const another = { ...search, id: "another-search" };
  assert.ok(DISREGARD_REASONS.includes("Exclude this model from this search"));
  for (const reason of DISREGARD_REASONS.filter(
    (item) => item !== "Exclude this model from this search",
  )) {
    state = stateFromToolResult(
      await call("record_goodfinds_listing_feedback", {
        mode: "sample",
        expected_entity_revision: revisionFor(state, "record_goodfinds_listing_feedback"),
        feedback: {
          search_id: search.id,
          listing_key: listing.key,
          action: "dismiss",
          reason,
          scope: "search",
        },
      }),
    );
    const feedback = state.config.feedback.at(-1);
    assert.ok(feedback);
    assert.equal(feedback.reason, reason);
    assert.equal(feedback.rule, undefined);
    assert.equal(listingIsDismissed(listing, [search], state.config.feedback), true);
    assert.equal(
      listingIsDismissed(listing, state.searches, state.config.feedback),
      true,
      "All-search view should honor dismissal",
    );
    assert.equal(listingIsDismissed(listing, [another], state.config.feedback), false);
    assert.equal(
      listingIsDismissed(listing, [search, another], state.config.feedback),
      false,
      "Other searches keep this listing",
    );
    assert.equal(
      listingIsDismissed({ ...listing, key: "other-same-model" }, [search], state.config.feedback),
      false,
    );
    state = stateFromToolResult(
      await call("undo_goodfinds_listing_feedback", {
        mode: "sample",
        expected_entity_revision: revisionFor(state, "undo_goodfinds_listing_feedback", {
          feedback_id: feedback.id,
        }),
        feedback_id: feedback.id,
      }),
    );
    assert.equal(listingIsDismissed(listing, [search], state.config.feedback), false);
  }
});
