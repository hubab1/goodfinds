import { useEffect, useMemo, useSyncExternalStore } from "react";
import { invokeFeedback } from "@/lib/client";
import type { GoodfindsState } from "@goodfinds/contracts/state";
import { createFeedbackOutbox, feedbackScope, projectFeedback } from "./feedback-outbox";
import type { FeedbackResponse, FeedbackEntry } from "./feedback-outbox";

const EMPTY = { entries: [] as FeedbackEntry[], storageError: false };
const subscribeEmpty = () => () => {};
const emptySnapshot = () => EMPTY;

export function useFeedbackOutbox(
  state: GoodfindsState | undefined,
  saved: (response: FeedbackResponse) => void,
) {
  const scope = state ? feedbackScope(state) : undefined;
  const queue = useMemo(() => {
    if (!scope) return undefined;
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* Restricted hosts can still save in this session. */
    }
    return createFeedbackOutbox(scope, { save: invokeFeedback, saved, storage });
  }, [scope, saved]);
  const snapshot = useSyncExternalStore(
    queue?.subscribe ?? subscribeEmpty,
    queue?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  useEffect(() => {
    if (!queue) return undefined;
    queue.start();
    const retry = () => queue.retry();
    window.addEventListener("online", retry);
    return () => {
      window.removeEventListener("online", retry);
      queue.stop();
    };
  }, [queue]);
  return {
    state: useMemo(
      () => (state ? projectFeedback(state, snapshot.entries) : undefined),
      [state, snapshot.entries],
    ),
    queue,
    pending: snapshot.entries.length,
    failed: snapshot.entries.filter((entry) => entry.status === "failed").length,
    storageError: snapshot.storageError,
  };
}
