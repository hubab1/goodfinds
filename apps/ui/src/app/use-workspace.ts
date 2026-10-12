import { startPanelMeasure, finishPanelMeasure } from "@/lib/panel-performance";
import { requestSearches } from "@/features/searches/search-actions";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  invoke,
  requestBrowserSearch,
  subscribeToState,
  readSearchRuns,
  readMonitoring,
  requireHostActions,
  readInitialWorkspace,
} from "@/lib/client";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { errorMessage } from "@goodfinds/contracts/state";
import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";
import { feedbackInputSchema } from "@goodfinds/contracts/discovery";
import { mergeSeen, useSeenRecorder } from "@/features/listings/listing-seen";
import { useFeedbackOutbox } from "@/features/listings/use-feedback-outbox";
import { feedbackScope, mergeFeedback } from "@/features/listings/feedback-outbox";
import type { FeedbackResponse } from "@/features/listings/feedback-outbox";
import type { Dispatch, SetStateAction } from "react";
import type { PanelPresentation } from "@goodfinds/contracts/panel-presentation";

export function useWorkspace(
  onSampleLoaded: () => void,
  onPanelOpened?: (target: PanelPresentation) => void,
) {
  const [baseState, setBaseState] = useState<GoodfindsState>();
  const setState = useCallback<Dispatch<SetStateAction<GoodfindsState | undefined>>>(
    (update) =>
      setBaseState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        if (
          current &&
          next &&
          feedbackScope(current) === feedbackScope(next) &&
          Date.parse(next.generated_at) < Date.parse(current.generated_at)
        )
          return current;
        return next;
      }),
    [],
  );
  const savedFeedback = useCallback((response: FeedbackResponse) => {
    setBaseState((current) => (current ? mergeFeedback(current, response) : current));
  }, []);
  const outbox = useFeedbackOutbox(baseState, savedFeedback);
  const state = outbox.state;
  const feedbackQueue = outbox.queue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const mode = state?.mode ?? "live";
  const recordSeen = useSeenRecorder(mode, (next, pairs) =>
    setState((current) => (current ? mergeSeen(current, next, pairs) : current)),
  );
  const searchNow = async (search?: SavedSearch) => {
    if (running.current || mode === "sample") return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!state) return;
      await requestSearches(state, search, {
        invoke,
        requireHostActions,
        requestBrowserSearch,
        update: setState,
      });
      setNotice("Search queued. Results will update here.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const action: Action = useCallback(
    async (name, args, message = "") => {
      if (
        state &&
        feedbackQueue &&
        (name === "record_goodfinds_listing_feedback" || name === "undo_goodfinds_listing_feedback")
      ) {
        try {
          const feedback =
            "feedback" in args ? feedbackInputSchema.parse(args.feedback) : undefined;
          if (
            name === "undo_goodfinds_listing_feedback" ||
            feedback?.action === "dismiss" ||
            feedback?.action === "shortlist"
          ) {
            let next;
            if (name === "undo_goodfinds_listing_feedback" && "feedback_id" in args)
              next = feedbackQueue.undo(args.feedback_id, state);
            else if (feedback) next = feedbackQueue.record(feedback, state);
            else throw new Error("Choose a listing to disregard.");
            setError("");
            setNotice(message);
            return next;
          }
        } catch (failure) {
          setError(errorMessage(failure));
          return undefined;
        }
      }
      if (running.current) return undefined;
      running.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const next = await invoke(name, { mode, ...args });
        setState(next);
        setNotice(message);
        if (name === "load_goodfinds_sample_workspace") onSampleLoaded();
        return next;
      } catch (failure) {
        setError(errorMessage(failure));
        return undefined;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [mode, onSampleLoaded, state, feedbackQueue, setState],
  );

  const presentSearch = useEffectEvent((target: PanelPresentation) => onPanelOpened?.(target));
  useEffect(() => {
    let active = true;
    let receivedHostState = false;
    const unsubscribe = subscribeToState((next, presentation) => {
      receivedHostState = true;
      if (active) {
        setState(next);
        if (presentation) presentSearch(presentation);
      }
    });
    // Hosts can deliver the opening tool result before this fallback read resolves.
    // Preserve that result's workspace (especially sample mode) in either ordering.
    startPanelMeasure("workspace-read");
    void readInitialWorkspace()
      .then((next) => {
        finishPanelMeasure("workspace-read");
        if (active && !receivedHostState) {
          setState(next);
        }
      })
      .catch((failure: unknown) => {
        if (active && !receivedHostState) setError(errorMessage(failure));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [setState]);

  const loaded = state !== undefined;
  useEffect(() => {
    if (!loaded) return undefined;
    const frame = window.requestAnimationFrame(() => finishPanelMeasure("startup"));
    return () => window.cancelAnimationFrame(frame);
  }, [loaded]);
  const hasSavedSearches = (state?.searches.length ?? 0) > 0;
  const reloadChangedConfig = useEffectEvent(async (revision: string) => {
    return state?.revision !== revision ? invoke("get_goodfinds_workspace", { mode }) : null;
  });
  useEffect(() => {
    if (mode === "sample" || !loaded) return undefined;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling || running.current || document.hidden) return;
      polling = true;
      try {
        const next = await readMonitoring(mode);
        if (active && !running.current) {
          const full = await reloadChangedConfig(next.revision);
          if (active && !running.current) {
            if (full) setState(full);
            else
              setState((current) => {
                if (!current || current.mode !== mode || current.revision !== next.revision)
                  return current;
                const activeSchedules = next.monitoring.filter(scheduleIsActive);
                return {
                  ...current,
                  monitoring: next.monitoring,
                  monitor: {
                    ...current.monitor,
                    scheduler_available: activeSchedules.length > 0,
                    next_run_at:
                      activeSchedules
                        .flatMap((item) =>
                          item.schedule?.next_run_at ? [item.schedule.next_run_at] : [],
                        )
                        .toSorted((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
                  },
                };
              });
          }
        }
      } catch {
        if (active && !running.current)
          setState((current) =>
            current && current.mode === mode
              ? {
                  ...current,
                  monitoring: current.monitoring.map((item) =>
                    item.schedule?.automation_id
                      ? {
                          ...item,
                          status: "unverified",
                          label: "Schedule unverified",
                          next_action: "check",
                          host_schedule: null,
                        }
                      : item,
                  ),
                  monitor: { ...current.monitor, scheduler_available: false, next_run_at: null },
                }
              : current,
          );
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, 30_000);
    const onVisible = () => {
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [mode, loaded, setState]);

  const progressKey =
    state?.search_runs
      .map((run) => `${run.id}:${state.search_run_refresh_keys[run.id] ?? run.version}`)
      .join(",") ?? "";
  const searching = state?.search_runs.some((run) => ACTIVE_SEARCH_PHASES.has(run.phase)) ?? false;
  useEffect(() => {
    if (!hasSavedSearches) return undefined;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling || running.current || document.hidden) return;
      polling = true;
      try {
        const runs = await readSearchRuns(mode);
        if (active && !running.current) {
          if (
            runs.map((run) => `${run.id}:${run.refresh_key ?? run.version}`).join(",") !==
            progressKey
          ) {
            const next = await invoke("get_goodfinds_workspace", { mode });
            if (active && !running.current) setState(next);
          } else {
            setState((current) => {
              if (!current || current.mode !== mode) return current;
              const changed = runs.some((run) =>
                current.search_runs.some(
                  (saved) => saved.id === run.id && saved.version < run.version,
                ),
              );
              if (!changed) return current;
              return {
                ...current,
                search_runs: current.search_runs.map((saved) => {
                  const run = runs.find(
                    (candidate) =>
                      candidate.id === saved.id &&
                      candidate.refresh_key === current.search_run_refresh_keys[saved.id] &&
                      candidate.version > saved.version,
                  );
                  return run
                    ? {
                        ...saved,
                        version: run.version,
                        updated_at: run.updated_at ?? saved.updated_at,
                        worker: run.worker === undefined ? saved.worker : run.worker,
                      }
                    : saved;
                }),
              };
            });
          }
        }
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(
      () => {
        void poll();
      },
      searching ? 5000 : 30_000,
    );
    const onVisible = () => {
      void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [mode, progressKey, searching, hasSavedSearches, setState]);

  return {
    state,
    busy,
    error,
    notice,
    mode,
    action,
    searchNow,
    recordSeen,
    feedbackSaves: {
      pending: outbox.pending,
      failed: outbox.failed,
      storageError: outbox.storageError,
      retry: () => feedbackQueue?.retry(),
    },
    clearError: () => setError(""),
  };
}
