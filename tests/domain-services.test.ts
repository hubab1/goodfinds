import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import type { Conversation, SellerMessageDraft } from "@goodfinds/contracts/seller-conversation";
import { SearchRuns } from "./reference-server/src/searches/runs.ts";
import { SearchRunRepository } from "./reference-server/src/searches/repository.ts";
import type { SearchRunStorage } from "./reference-server/src/searches/repository.ts";
import { SellerConversations } from "./reference-server/src/sellers/conversations.ts";
import { SellerConversationRepository } from "./reference-server/src/sellers/repository.ts";
import {
  normalizeObservations,
  validateConfiguration,
} from "./reference-server/src/listings/evaluation.ts";
import exampleConfig from "../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import sampleRows from "../skills/marketplace-shopping/assets/demo-listings.json" with { type: "json" };

function searchStorage(): SearchRunStorage {
  const saved = new Map<string, SearchRun>();
  const find = (id: string) => Effect.sync(() => structuredClone(saved.get(id)));
  return {
    list: (searchId, limit = 50) =>
      Effect.sync(() => {
        const runs = [...saved.values()].filter(
          (run) => searchId === undefined || run.search_id === searchId,
        );
        return structuredClone(limit === null ? runs : runs.slice(0, limit));
      }),
    find,
    latestScheduled: (searchId) =>
      Effect.sync(() =>
        structuredClone(
          [...saved.values()]
            .filter((run) => run.search_id === searchId && run.scheduled_at !== null)
            .toSorted((a, b) => (b.scheduled_at ?? "").localeCompare(a.scheduled_at ?? ""))[0],
        ),
      ),
    save: (run) =>
      Effect.sync(() => {
        saved.set(run.id, structuredClone(run));
      }),
    saveIfVersion: (run, version) =>
      Effect.gen(function* () {
        if (saved.get(run.id)?.version === version) saved.set(run.id, structuredClone(run));
        return yield* find(run.id);
      }),
    recordDiscoveries: () => Effect.void,
  };
}

void test("search modules capture their repository and fence stale workers with an in-memory adapter", () => {
  const config = Effect.runSync(validateConfiguration(exampleConfig));
  const search = config.searches[0];
  assert.ok(search);
  const repository = searchStorage();
  const searches = Effect.runSync(
    SearchRuns.pipe(
      Effect.provide(
        SearchRuns.layer.pipe(Layer.provide(Layer.succeed(SearchRunRepository, repository))),
      ),
    ),
  );
  const now = Date.now();
  const run = Effect.runSync(
    searches.searchAction(
      "start",
      {
        search_id: search.id,
        request_id: randomUUID(),
      },
      config.searches,
      now,
    ),
  );
  const worker = randomUUID();
  const claimed = Effect.runSync(
    searches.searchAction(
      "claim",
      {
        run_id: run.id,
        expected_version: run.version,
        worker_id: worker,
        agent_id: randomUUID(),
      },
      config.searches,
      now,
    ),
  );
  assert.equal(claimed.worker?.id, worker);
  assert.throws(
    () =>
      Effect.runSync(searches.recordSearchImport(run.id, [{ key: "listing" }], now, randomUUID())),
    /owned|worker|lease/,
  );
  assert.deepEqual(Effect.runSync(searches.find(run.id))?.listing_keys, []);
  Effect.runSync(searches.recordSearchImport(run.id, [{ key: "listing" }], now, worker));
  assert.deepEqual(Effect.runSync(searches.find(run.id))?.listing_keys, ["listing"]);
  Effect.runSync(searches.fulfilGoals([search.id], now));
  assert.equal(Effect.runSync(searches.find(run.id))?.phase, "cancelled");
  assert.throws(
    () => Effect.runSync(searches.recordSearchImport(run.id, [{ key: "late" }], now, worker)),
    /finished/,
  );
});

void test("seller modules retain drafts and reject stale edits without a database dependency", () => {
  const saved = new Map<string, Conversation>();
  const sellers = Effect.runSync(
    SellerConversations.pipe(
      Effect.provide(
        SellerConversations.layer.pipe(
          Layer.provide(
            Layer.succeed(SellerConversationRepository, {
              list: () => Effect.sync(() => structuredClone([...saved.values()])),
              find: (key) => Effect.sync(() => structuredClone(saved.get(key))),
              save: (conversation) =>
                Effect.sync(() => {
                  saved.set(conversation.listing_key, structuredClone(conversation));
                }),
            }),
          ),
        ),
      ),
    ),
  );
  const config = Effect.runSync(validateConfiguration(exampleConfig));
  const now = Date.now();
  const row = Effect.runSync(normalizeObservations([sampleRows[0]], true, now))[0];
  assert.ok(row);
  const draft: SellerMessageDraft = {
    price_minor: null,
    currency: row.currency ?? "GBP",
    price_period: row.price_period ?? "once",
    collection: null,
    text: "Hello, is this available?",
    intent: "message",
    responds_to: null,
  };
  const before = Effect.runSync(
    sellers.handle("get", { listing_key: row.key }, row, config, "sample", "test", now),
  );
  const result = Effect.runSync(
    sellers.handle(
      "save",
      { listing_key: row.key, expected_version: before.conversation.version, draft },
      row,
      config,
      "sample",
      "test",
      now,
    ),
  );
  assert.equal(result.conversation.draft?.text, draft.text);
  assert.equal(result.conversation.first_sent_at, null);
  assert.equal(Effect.runSync(sellers.summaries(now))[0]?.label, "Draft");
  assert.throws(
    () =>
      Effect.runSync(
        sellers.handle(
          "save",
          {
            listing_key: row.key,
            expected_version: before.conversation.version,
            draft: { ...draft, text: "Stale edit" },
          },
          row,
          config,
          "sample",
          "test",
          now,
        ),
      ),
    /changed|version/,
  );
  const retained = Effect.runSync(
    sellers.handle("get", { listing_key: row.key }, row, config, "sample", "test", now),
  );
  assert.equal(retained.conversation.draft?.text, draft.text);
  assert.deepEqual(retained.conversation.actions, []);
});
