import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { NativeWorkspace } from "./helpers/native-workspace.ts";
import { feedbackEventSchema } from "@goodfinds/contracts/discovery";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import {
  createFeedbackOutbox,
  feedbackScope,
  projectFeedback,
  mergeFeedback,
} from "../apps/ui/src/features/listings/feedback-outbox.ts";
import type { FeedbackResponse } from "../apps/ui/src/features/listings/feedback-outbox.ts";
import type { GoodfindsState } from "@goodfinds/contracts/state";

function fixture() {
  const folder = mkdtempSync(resolve(tmpdir(), "goodfinds-outbox-"));
  const store = new NativeWorkspace(folder, "sample");
  const initial = Effect.runSync(store.request("load_sample_workspace")).state;
  const search = initial.searches[0];
  assert.ok(search);
  const rows = initial.listings.filter((listing) => listing.product === search.product);
  const first = rows[0];
  const second = rows[1];
  assert.ok(first && second);
  const storageMap = new Map<string, string>();
  return {
    initial,
    first,
    second,
    search,
    close: () => rmSync(folder, { recursive: true, force: true }),
    read: () => Effect.runSync(store.request("get_workspace")).state,
    storage: {
      get length() {
        return storageMap.size;
      },
      key: (index: number) => [...storageMap.keys()][index] ?? null,
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, value);
      },
      removeItem: (key: string) => {
        storageMap.delete(key);
      },
    },
    input: (listingKey = first.key) => ({
      search_id: search.id,
      listing_key: listingKey,
      action: "dismiss" as const,
      reason: "Too expensive",
      scope: "search" as const,
    }),
    save: async (name: string, args: Record<string, unknown>): Promise<FeedbackResponse> => {
      const operation =
        name === "record_goodfinds_listing_feedback"
          ? "record_listing_feedback"
          : "undo_listing_feedback";
      const result = Effect.runSync(store.request(operation, args));
      return {
        state: result.state,
        feedback: z.object({ feedback: feedbackEventSchema }).parse(result["operation_result"])
          .feedback,
      };
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 1500;
  while (!check()) {
    assert.ok(Date.now() < end, "Outbox did not reach the expected state");
    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll the same queue until its asynchronous transition completes.
    await new Promise((done) => setTimeout(done, 2));
  }
}
function visible(state: GoodfindsState, searchId: string, key: string) {
  return selectListings(state, { search_id: searchId, sellerFilters: EMPTY_SELLER_FILTERS }).some(
    (listing) => listing.key === key,
  );
}

void test("bookmark and dismissal requests keep independent identities in the outbox", (t) => {
  const f = fixture();
  t.after(f.close);
  const queue = createFeedbackOutbox(feedbackScope(f.initial), {
    storage: f.storage,
    save: f.save,
    saved: () => {},
  });
  t.after(queue.stop);
  const shortlisted = queue.record(
    {
      search_id: f.search.id,
      listing_key: f.first.key,
      action: "shortlist",
      scope: "search",
    },
    f.initial,
  );
  const bookmark = shortlisted.config.feedback.at(-1);
  assert.ok(bookmark);
  queue.record(f.input(), shortlisted);
  assert.equal(queue.getSnapshot().entries.length, 2);
  queue.undo(bookmark.id, shortlisted);
  assert.deepEqual(
    queue.getSnapshot().entries.map((entry) => entry.event.action),
    ["dismiss"],
  );
});

void test("queued Undo cancels locally; in-flight Undo restores immediately and saves the exact event", async (t) => {
  const f = fixture();
  t.after(f.close);
  let state = f.initial;
  const pending = Promise.withResolvers<FeedbackResponse>();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const queue = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    save: async (name, args) => {
      calls.push({ name, args });
      return calls.length === 1 ? pending.promise : f.save(name, args);
    },
    saved: (response) => {
      state = mergeFeedback(state, response);
    },
  });
  t.after(queue.stop);
  const projected = queue.record(f.input(), state);
  const id = projected.config.feedback.at(-1)?.id;
  assert.ok(id);
  assert.equal(visible(projected, f.search.id, f.first.key), false);
  assert.equal(
    projected.searches.find((search) => search.id === f.search.id)?.unseen_count,
    f.search.unseen_count - 1,
  );
  assert.equal(visible(queue.undo(id, state), f.search.id, f.first.key), true);
  assert.equal(
    projectFeedback(state, queue.getSnapshot().entries).searches.find(
      (search) => search.id === f.search.id,
    )?.unseen_count,
    f.search.unseen_count,
  );
  queue.start();
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(calls.length, 0);
  const nextId = queue.record(f.input(), state).config.feedback.at(-1)?.id;
  assert.ok(nextId);
  await until(() => calls.length === 1);
  assert.equal(visible(queue.undo(nextId, state), f.search.id, f.first.key), true);
  const call = calls[0];
  assert.ok(call);
  const response = await f.save(call.name, call.args);
  pending.resolve(response);
  await until(() => queue.getSnapshot().entries.length === 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.args["feedback_id"], response.feedback.id);
  assert.equal(
    calls[1]?.args["expected_entity_revision"],
    response.state.revisions.feedback[response.feedback.id],
  );
  assert.equal(visible(state, f.search.id, f.first.key), true);
  assert.equal(state.config.feedback.filter((item) => item.listing_key === f.first.key).length, 1);
  assert.equal(
    state.config.feedback.find((item) => item.id === response.feedback.id)?.undone,
    true,
  );
});

void test("a lost response replays one durable dismissal and preserves newer unrelated data", async (t) => {
  const f = fixture();
  t.after(f.close);
  let state = f.initial;
  let clock = Date.now();
  const payloads: string[] = [];
  const queue = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    now: () => clock,
    save: async (name, args) => {
      payloads.push(JSON.stringify(args));
      const response = await f.save(name, args);
      if (payloads.length === 1) throw new Error("Response lost after commit");
      return response;
    },
    saved: (response) => {
      state = mergeFeedback(state, response);
    },
  });
  t.after(queue.stop);
  queue.start();
  queue.record(f.input(), state);
  await until(
    () =>
      queue.getSnapshot().entries[0]?.attempts === 1 &&
      queue.getSnapshot().entries[0]?.status === "queued",
  );
  state = {
    ...state,
    config: { ...state.config, origin: "A newer location" },
    generated_at: new Date(clock + 10000).toISOString(),
  };
  clock += 2000;
  queue.start();
  await until(() => queue.getSnapshot().entries.length === 0);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0], payloads[1], "Retries preserve request ID and every argument");
  assert.equal(state.config.feedback.filter((item) => item.listing_key === f.first.key).length, 1);
  assert.equal(state.config.origin, "A newer location");
  assert.equal(visible(state, f.search.id, f.first.key), false);
  const response = await f.save(
    "record_goodfinds_listing_feedback",
    z.record(z.string(), z.unknown()).parse(JSON.parse(payloads[0] ?? "{}")),
  );
  assert.equal(
    response.state.config.feedback.filter((item) => item.listing_key === f.first.key).length,
    1,
  );
});

void test("pending saves survive reload, remain workspace scoped, and ignore stopped callbacks", async (t) => {
  const f = fixture();
  t.after(f.close);
  const abandoned = Promise.withResolvers<FeedbackResponse>();
  let oldCallbacks = 0;
  let payload: Record<string, unknown> | undefined;
  const old = createFeedbackOutbox(feedbackScope(f.initial), {
    storage: f.storage,
    save: (_name, args) => {
      payload = args;
      return abandoned.promise;
    },
    saved: () => {
      oldCallbacks += 1;
    },
  });
  old.start();
  old.record(f.input(), f.initial);
  await until(() => Boolean(payload));
  old.stop();
  let state = f.initial;
  const restored = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    save: f.save,
    saved: (response) => {
      state = mergeFeedback(state, response);
    },
  });
  t.after(restored.stop);
  assert.equal(restored.getSnapshot().entries.length, 1);
  assert.deepEqual(restored.getSnapshot().entries[0]?.args, payload);
  assert.equal(
    visible(projectFeedback(state, restored.getSnapshot().entries), f.search.id, f.first.key),
    false,
  );
  const other = createFeedbackOutbox(`${"b".repeat(64)}:sample`, {
    storage: f.storage,
    save: f.save,
    saved: () => {},
  });
  t.after(other.stop);
  assert.equal(other.getSnapshot().entries.length, 0);
  assert.throws(() => other.record(f.input(), state), /original workspace/u);
  restored.start();
  await until(() => restored.getSnapshot().entries.length === 0);
  assert.ok(payload);
  abandoned.resolve(await f.save("record_goodfinds_listing_feedback", payload));
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(oldCallbacks, 0);
  assert.equal(state.config.feedback.length, 1);
});

void test("timeouts and rejected saves do not block other dismissals; manual retry keeps the same request", async (t) => {
  const f = fixture();
  t.after(f.close);
  let state = f.initial;
  const firstPayloads: string[] = [];
  let retryWorks = false;
  const queue = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    timeout: 15,
    save: (name, args) => {
      if (
        "feedback" in args &&
        z.object({ listing_key: z.string() }).parse(args["feedback"]).listing_key === f.first.key
      ) {
        firstPayloads.push(JSON.stringify(args));
        if (!retryWorks) return new Promise<FeedbackResponse>(() => {});
      }
      return f.save(name, args);
    },
    saved: (response) => {
      state = mergeFeedback(state, response);
    },
  });
  t.after(queue.stop);
  queue.start();
  queue.record(f.input(), state);
  queue.record(f.input(f.second.key), state);
  await until(() => state.config.feedback.some((event) => event.listing_key === f.second.key));
  assert.equal(queue.getSnapshot().entries.length, 1);
  assert.equal(queue.getSnapshot().entries[0]?.attempts, 1);
  queue.stop();
  const stopped = queue.getSnapshot().entries[0];
  assert.ok(stopped);
  // Restore the same request as a terminal server rejection to exercise explicit Retry.
  const rejected = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    now: () => Date.now() + 10000,
    save: async (name, args) => {
      firstPayloads.push(JSON.stringify(args));
      if (!retryWorks)
        throw new Error(JSON.stringify({ error: { message: "Rejected", retryable: false } }));
      return f.save(name, args);
    },
    saved: (response) => {
      state = mergeFeedback(state, response);
    },
  });
  t.after(rejected.stop);
  rejected.start();
  await until(() => rejected.getSnapshot().entries[0]?.status === "failed");
  retryWorks = true;
  rejected.retry();
  await until(() => rejected.getSnapshot().entries.length === 0);
  assert.equal(new Set(firstPayloads).size, 1);
  assert.equal(state.config.feedback.length, 2);
});

void test("feedback acknowledgements preserve chronological order and newer Undo state", (t) => {
  const f = fixture();
  t.after(f.close);
  const event = {
    ...f.input(),
    id: "first",
    category: f.search.product,
    created_at: "2026-10-01T10:00:00.000Z",
    undone: false,
  };
  const newer = { ...event, id: "second", created_at: "2026-10-01T11:00:00.000Z" };
  const state = {
    ...f.initial,
    generated_at: "2026-10-01T12:00:00.000Z",
    config: { ...f.initial.config, feedback: [{ ...event, undone: true }, newer] },
  };
  const old = {
    ...state,
    generated_at: "2026-10-01T11:00:00.000Z",
    config: { ...state.config, feedback: [event, newer] },
  };
  assert.equal(mergeFeedback(state, { state: old, feedback: event }), state);
  const fresh = { ...state, generated_at: "2026-10-01T13:00:00.000Z" };
  const merged = mergeFeedback(state, { state: fresh, feedback: event });
  assert.deepEqual(
    merged.config.feedback.map((item) => item.id),
    ["first", "second"],
  );
  assert.equal(merged.config.feedback[0]?.undone, true);
  const empty = { ...state, config: { ...state.config, feedback: [newer] } };
  assert.deepEqual(
    mergeFeedback(empty, { state: fresh, feedback: event }).config.feedback.map((item) => item.id),
    ["first", "second"],
  );
});

void test("transient failures stop after three automatic attempts and can be retried explicitly", async (t) => {
  const f = fixture();
  t.after(f.close);
  let clock = Date.now();
  let calls = 0;
  let recovered = false;
  const payloads: string[] = [];
  const queue = createFeedbackOutbox(feedbackScope(f.initial), {
    storage: f.storage,
    now: () => clock,
    save: async (name, args) => {
      calls += 1;
      payloads.push(JSON.stringify(args));
      if (!recovered) throw new Error("Temporarily offline");
      return f.save(name, args);
    },
    saved: () => {},
  });
  t.after(queue.stop);
  queue.start();
  queue.record(f.input(), f.initial);
  await until(() => calls === 1 && queue.getSnapshot().entries[0]?.status === "queued");
  clock += 1100;
  queue.start();
  await until(() => calls === 2 && queue.getSnapshot().entries[0]?.status === "queued");
  clock += 2100;
  queue.start();
  await until(() => queue.getSnapshot().entries[0]?.status === "failed");
  clock += 10000;
  queue.start();
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(calls, 3);
  recovered = true;
  queue.retry();
  await until(() => queue.getSnapshot().entries.length === 0);
  assert.equal(calls, 4);
  assert.equal(new Set(payloads).size, 1);
});

void test("separate panels cannot overwrite or clear each other's queued dismissals", async (t) => {
  const f = fixture();
  t.after(f.close);
  const ports = { storage: f.storage, save: f.save, saved: () => {} };
  const firstPanel = createFeedbackOutbox(feedbackScope(f.initial), ports);
  const secondPanel = createFeedbackOutbox(feedbackScope(f.initial), ports);
  const idlePanel = createFeedbackOutbox(feedbackScope(f.initial), ports);
  t.after(firstPanel.stop);
  t.after(secondPanel.stop);
  firstPanel.record(f.input(), f.initial);
  secondPanel.record(f.input(f.second.key), f.initial);
  idlePanel.stop();
  assert.equal(f.storage.length, 2);
  firstPanel.start();
  await until(() => firstPanel.getSnapshot().entries.length === 0);
  assert.equal(
    f.storage.length,
    1,
    "Acknowledging one panel's change retains the other panel's intent",
  );
  const restarted = createFeedbackOutbox(feedbackScope(f.initial), ports);
  t.after(restarted.stop);
  assert.equal(restarted.getSnapshot().entries[0]?.event.listing_key, f.second.key);
  secondPanel.start();
  restarted.start();
  await until(
    () =>
      secondPanel.getSnapshot().entries.length === 0 &&
      restarted.getSnapshot().entries.length === 0,
  );
  assert.equal(f.storage.length, 0);
  assert.equal(f.read().config.feedback.filter((event) => event.action === "dismiss").length, 2);
});

void test("Undo stays optimistic when a host snapshot arrives before the save response", async (t) => {
  const f = fixture();
  t.after(f.close);
  const response = Promise.withResolvers<FeedbackResponse>();
  let args: Record<string, unknown> | undefined;
  let state = f.initial;
  let calls = 0;
  const queue = createFeedbackOutbox(feedbackScope(state), {
    storage: f.storage,
    save: (name, input) => {
      calls += 1;
      args = input;
      return calls === 1 ? response.promise : f.save(name, input);
    },
    saved: (saved) => {
      state = mergeFeedback(state, saved);
    },
  });
  t.after(queue.stop);
  queue.start();
  const projected = queue.record(f.input(), state);
  const temporaryId = projected.config.feedback.at(-1)?.id;
  assert.ok(temporaryId);
  await until(() => Boolean(args));
  assert.ok(args);
  const committed = await f.save("record_goodfinds_listing_feedback", args);
  state = committed.state; // A polling/host notification can beat the original response.
  const restored = queue.undo(temporaryId, state);
  assert.equal(
    visible(restored, f.search.id, f.first.key),
    true,
    "A committed snapshot must not override pending Undo",
  );
  assert.equal(
    restored.config.feedback.filter((event) => event.listing_key === f.first.key).length,
    1,
  );
  response.resolve(committed);
  await until(() => queue.getSnapshot().entries.length === 0);
  assert.equal(visible(state, f.search.id, f.first.key), true);
});
