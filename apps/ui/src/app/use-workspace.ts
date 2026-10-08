import { requestSearches } from "@/features/searches/search-actions";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  invoke,
  requestBrowserSearch,
  subscribeToState,
  readSearchRuns,
  readMonitoring,
  requireHostActions,
} from "@/lib/client";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { scheduleIsActive } from "@goodfinds/contracts/monitoring";
import { errorMessage } from "@goodfinds/contracts/state";
import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";
import { mergeSeen, useSeenRecorder } from "@/features/listings/listing-seen";

export function useWorkspace(onSampleLoaded: () => void) {
  const [state, setState] = useState<GoodfindsState>();
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
    [mode, onSampleLoaded],
  );

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeToState((next) => {
      if (active) setState(next);
    });
    void invoke("get_goodfinds_workspace", { mode: "live" })
      .then((next) => {
        if (active) setState(next);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorMessage(failure));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const hasSavedSearches = (state?.searches.length ?? 0) > 0;
  const reloadChangedConfig = useEffectEvent(async (revision: string) => {
    return state?.revision !== revision ? invoke("get_goodfinds_workspace", { mode }) : null;
  });
  useEffect(() => {
    if (mode === "sample" || !hasSavedSearches) return undefined;
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
  }, [mode, hasSavedSearches]);

  const progressKey = state?.search_runs.map((run) => `${run.id}:${run.version}`).join(",") ?? "";
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
        if (active && runs.map((run) => `${run.id}:${run.version}`).join(",") !== progressKey) {
          const next = await invoke("get_goodfinds_workspace", { mode });
          if (active) setState(next);
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
  }, [mode, progressKey, searching, hasSavedSearches]);

  return {
    state,
    busy,
    error,
    notice,
    mode,
    action,
    searchNow,
    recordSeen,
    clearError: () => setError(""),
  };
}
