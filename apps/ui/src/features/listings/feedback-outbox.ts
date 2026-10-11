import { z } from "zod";
import {
  feedbackEventSchema,
  feedbackInputSchema,
  modelExclusionRule,
} from "@goodfinds/contracts/discovery";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { errorMessage } from "@goodfinds/contracts/state";
import { selectListings, EMPTY_SELLER_FILTERS } from "@goodfinds/contracts/listing-query";
import { listingSearchIds, unseenSearchIds } from "@goodfinds/contracts/listing-reading";

const recordArgumentsSchema = z
  .object({
    mode: z.enum(["live", "sample"]),
    feedback: feedbackInputSchema,
    request_id: z.uuid(),
    expected_entity_revision: z.string(),
  })
  .strict();
const undoArgumentsSchema = z
  .object({
    mode: z.enum(["live", "sample"]),
    feedback_id: z.string(),
    request_id: z.uuid(),
    expected_entity_revision: z.string(),
  })
  .strict();
const entrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["record", "undo"]),
  event: feedbackEventSchema,
  args: z.union([recordArgumentsSchema, undoArgumentsSchema]),
  status: z.enum(["queued", "saving", "failed"]),
  attempts: z.number().int().nonnegative(),
  retry_at: z.number(),
  undo_requested: z.boolean(),
  undo_request_id: z.uuid().default(() => crypto.randomUUID()),
  sent: z.boolean(),
  error: z.string(),
});
export type FeedbackEntry = z.infer<typeof entrySchema>;
export type FeedbackResponse = { state: GoodfindsState; feedback: FeedbackEvent };
type Ports = {
  save: (
    name: "record_goodfinds_listing_feedback" | "undo_goodfinds_listing_feedback",
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<FeedbackResponse>;
  saved: (response: FeedbackResponse) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length"> | undefined;
  now?: () => number;
  timeout?: number;
};

export function feedbackScope(state: GoodfindsState) {
  return `${state.workspace_id ?? state.access_context}:${state.mode}`;
}

function withFeedback(state: GoodfindsState, feedback: FeedbackEvent[]): GoodfindsState {
  const next = { ...state, config: { ...state.config, feedback } };
  return {
    ...next,
    searches: state.searches.map((search) => {
      const related = selectListings(next, {
        search_id: search.id,
        sellerFilters: EMPTY_SELLER_FILTERS,
      }).filter((listing) => listingSearchIds(listing, [search]).length > 0);
      const unseen_count = related.filter(
        (listing) => unseenSearchIds(listing, [search]).length > 0,
      ).length;
      return { ...search, unseen_count, seen_count: related.length - unseen_count };
    }),
  };
}

export function projectFeedback(
  state: GoodfindsState,
  entries: readonly FeedbackEntry[],
): GoodfindsState {
  if (!entries.length) return state;
  const feedback = new Map(state.config.feedback.map((event) => [event.id, event]));
  for (const entry of entries) {
    const committed =
      entry.kind === "record"
        ? state.config.feedback.find(
            (event) => event.id !== entry.event.id && event.request_id === entry.args.request_id,
          )
        : undefined;
    if (committed) feedback.delete(entry.event.id);
    feedback.set(committed?.id ?? entry.event.id, {
      ...entry.event,
      ...committed,
      undone: entry.undo_requested || entry.event.undone || Boolean(committed?.undone),
    });
  }
  return withFeedback(state, [...feedback.values()]);
}

export function mergeFeedback(current: GoodfindsState, response: FeedbackResponse): GoodfindsState {
  if (feedbackScope(current) !== feedbackScope(response.state)) return current;
  const existing = current.config.feedback.find((item) => item.id === response.feedback.id);
  if (existing && Date.parse(response.state.generated_at) < Date.parse(current.generated_at))
    return current;
  const event =
    response.state.config.feedback.find((item) => item.id === response.feedback.id) ??
    response.feedback;
  const feedback = existing
    ? current.config.feedback.map((item) => (item.id === event.id ? event : item))
    : [...current.config.feedback, event].toSorted(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
      );
  return {
    ...withFeedback(current, feedback),
    generated_at:
      Date.parse(response.state.generated_at) > Date.parse(current.generated_at)
        ? response.state.generated_at
        : current.generated_at,
    revisions: {
      ...current.revisions,
      feedback: {
        ...current.revisions.feedback,
        [event.id]: response.state.revisions.feedback[event.id] ?? response.state.revisions.absent,
      },
    },
  };
}

function failure(error: unknown) {
  const message = errorMessage(error);
  try {
    const parsed = z
      .object({ error: z.object({ message: z.string(), retryable: z.boolean() }) })
      .safeParse(JSON.parse(message));
    if (parsed.success) return parsed.data.error;
  } catch {
    /* Transport failures usually have plain text messages. */
  }
  return { message, retryable: true };
}

function undoArguments(id: string, state: GoodfindsState, requestId: string = crypto.randomUUID()) {
  return {
    mode: state.mode,
    feedback_id: id,
    request_id: requestId,
    expected_entity_revision: state.revisions.feedback[id] ?? state.revisions.absent,
  };
}

async function saveWithSignal(ports: Ports, entry: FeedbackEntry, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_accept, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([
      ports.save(
        entry.kind === "record"
          ? "record_goodfinds_listing_feedback"
          : "undo_goodfinds_listing_feedback",
        entry.args,
        signal,
      ),
      aborted,
    ]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}

export function createFeedbackOutbox(scope: string, ports: Ports) {
  const prefix = `goodfinds:feedback-outbox:v2:${scope}:`;
  const now = ports.now ?? Date.now;
  let entries: FeedbackEntry[] = [];
  let storageError = !ports.storage;
  let active = false;
  let generation = 0;
  let working = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  let persisted = new Set<string>();
  try {
    const storage = ports.storage;
    if (storage)
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const value = storage.getItem(key);
        if (!value) continue;
        const entry = entrySchema.parse(JSON.parse(value));
        if (key !== `${prefix}${entry.id}`) throw new Error("Invalid saved change");
        entries.push(entry);
      }
    entries = [...new Map(entries.map((entry) => [entry.id, entry])).values()].toSorted(
      (a, b) => Date.parse(a.event.created_at) - Date.parse(b.event.created_at),
    );
    for (const entry of entries) {
      if (
        !scope.endsWith(`:${entry.args.mode}`) ||
        (entry.kind === "record"
          ? !("feedback" in entry.args) || entry.args.request_id !== entry.id
          : !("feedback_id" in entry.args))
      )
        throw new Error("Invalid saved change");
      if (entry.status === "saving") entry.status = "queued";
    }
    persisted = new Set(entries.map((entry) => entry.id));
  } catch {
    entries = [];
    storageError = true;
  }
  let snapshot = { entries, storageError };
  function publish() {
    entries = [...entries];
    try {
      const current = new Set(entries.map((entry) => entry.id));
      for (const entry of entries)
        ports.storage?.setItem(`${prefix}${entry.id}`, JSON.stringify(entry));
      for (const id of persisted) if (!current.has(id)) ports.storage?.removeItem(`${prefix}${id}`);
      persisted = current;
    } catch {
      storageError = true;
    }
    snapshot = { entries, storageError };
    for (const listener of listeners) listener();
  }
  function schedule() {
    clearTimeout(timer);
    if (!active || working) return;
    const queued = entries.filter((entry) => entry.status === "queued");
    if (!queued.length) return;
    const delay = Math.max(0, Math.min(...queued.map((entry) => entry.retry_at)) - now());
    timer = setTimeout(() => {
      void flush();
    }, delay);
  }
  async function flush() {
    if (!active || working) return;
    const entry = entries.find((item) => item.status === "queued" && item.retry_at <= now());
    if (!entry) {
      schedule();
      return;
    }
    working = true;
    const epoch = generation;
    controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(ports.timeout ?? 20_000),
    ]);
    entry.status = "saving";
    entry.sent = true;
    entry.attempts += 1;
    publish();
    try {
      const response = await saveWithSignal(ports, entry, signal);
      if (!active || epoch !== generation) return;
      if (feedbackScope(response.state) !== scope)
        throw new Error(
          "The workspace changed. Reopen the original workspace to save this change.",
        );
      ports.saved(response);
      if (entry.kind === "record" && entry.undo_requested) {
        const event =
          response.state.config.feedback.find((item) => item.id === response.feedback.id) ??
          response.feedback;
        if (event.undone) {
          entries = entries.filter((item) => item.id !== entry.id);
          return;
        }
        entry.kind = "undo";
        entry.event = { ...event, undone: true };
        entry.args = undoArguments(event.id, response.state, entry.undo_request_id);
        entry.status = "queued";
        entry.attempts = 0;
        entry.retry_at = now();
        entry.error = "";
        entry.sent = false;
      } else entries = entries.filter((item) => item.id !== entry.id);
    } catch (error) {
      if (!active || epoch !== generation) return;
      const details = failure(error);
      entry.error = details.message;
      entry.status = details.retryable && entry.attempts < 3 ? "queued" : "failed";
      entry.retry_at = now() + 1000 * 2 ** (entry.attempts - 1);
    } finally {
      if (active && epoch === generation) {
        working = false;
        controller = undefined;
        publish();
        schedule();
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      active = true;
      schedule();
    },
    stop: () => {
      active = false;
      generation += 1;
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
      working = false;
      for (const entry of entries) if (entry.status === "saving") entry.status = "queued";
      publish();
    },
    record: (input: z.input<typeof feedbackInputSchema>, state: GoodfindsState) => {
      if (feedbackScope(state) !== scope)
        throw new Error("Reopen the original workspace to save this change.");
      const feedback = feedbackInputSchema.parse(input);
      const search = state.searches.find((item) => item.id === feedback.search_id);
      const listing = state.listings.find(
        (item) => item.key === feedback.listing_key && item.product === search?.product,
      );
      if (!search || !listing) throw new Error("Choose a listing from this search.");
      const rule = feedback.exclude_model ? modelExclusionRule(listing, search) : undefined;
      if (feedback.exclude_model && !rule)
        throw new Error("Confirm the model before excluding it.");
      const existing = entries.find(
        (entry) =>
          entry.kind === "record" &&
          !entry.undo_requested &&
          entry.event.search_id === search.id &&
          entry.event.action === feedback.action &&
          entry.event.listing_key === listing.key,
      );
      if (existing) return projectFeedback(state, entries);
      const id = crypto.randomUUID();
      entries.push({
        id,
        kind: "record",
        event: {
          ...feedback,
          ...(rule ? { rule } : {}),
          id,
          request_id: id,
          category: search.product,
          created_at: new Date(now()).toISOString(),
          undone: false,
        },
        args: {
          mode: state.mode,
          feedback,
          request_id: id,
          expected_entity_revision: state.revisions.absent,
        },
        status: "queued",
        attempts: 0,
        retry_at: now(),
        undo_requested: false,
        undo_request_id: crypto.randomUUID(),
        sent: false,
        error: "",
      });
      publish();
      schedule();
      return projectFeedback(state, entries);
    },
    undo: (id: string, state: GoodfindsState) => {
      if (feedbackScope(state) !== scope)
        throw new Error("Reopen the original workspace to save this change.");
      const event = state.config.feedback.find((item) => item.id === id);
      const pending = entries.find(
        (entry) =>
          entry.event.id === id ||
          (entry.kind === "record" && event?.request_id === entry.args.request_id),
      );
      if (pending) {
        if (pending.kind === "record" && !pending.sent)
          entries = entries.filter((entry) => entry.id !== pending.id);
        else if (pending.kind === "record") {
          pending.undo_requested = true;
          if (pending.status === "failed") {
            pending.status = "queued";
            pending.attempts = 0;
            pending.retry_at = now();
          }
        }
      } else {
        if (!event) throw new Error("That preference is no longer available.");
        const args = undoArguments(id, state);
        entries.push({
          id: args.request_id,
          kind: "undo",
          event: { ...event, undone: true },
          args,
          status: "queued",
          attempts: 0,
          retry_at: now(),
          undo_requested: false,
          undo_request_id: args.request_id,
          sent: false,
          error: "",
        });
      }
      publish();
      schedule();
      return projectFeedback(state, entries);
    },
    retry: () => {
      for (const entry of entries)
        if (entry.status === "failed") {
          entry.status = "queued";
          entry.attempts = 0;
          entry.retry_at = now();
          entry.error = "";
        }
      publish();
      schedule();
    },
  };
}
