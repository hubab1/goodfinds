import { useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { errorMessage } from "@goodfinds/contracts/state";
import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import { hostRequest } from "@goodfinds/contracts/host-request";
import { requestHostAction } from "@/lib/client";
import type { Action } from "@/lib/actions";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";

export function SearchDeleteDialog({
  search,
  state,
  action,
  busy,
  close,
  returnFocus,
}: {
  search: SavedSearch;
  state: GoodfindsState;
  action: Action;
  busy: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const id = useId();
  const linkedSchedule = state.config.dispatchers.some(
    (dispatcher) =>
      dispatcher.search_ids.includes(search.id) &&
      dispatcher.schedule &&
      dispatcher.schedule.status !== "removed",
  );
  async function remove() {
    if (busy || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      if (linkedSchedule && state.mode !== "sample") {
        await requestHostAction(
          hostRequest(
            `Use Goodfinds's marketplace-shopping skill to delete only search_id ${JSON.stringify(search.id)}. The buyer has confirmed deleting this search and stopping its automatic checks. Read get_goodfinds_search_context and get_goodfinds_dispatcher_context with fresh revisions. Set this search's monitoring preference to once and disable only this search. Cancel any unfinished run for this search. Reconcile its linked dispatcher in the original buying chat: preserve every other search's timing, monitoring choice and notification policy, and never resume a paused host schedule. If no eligible members remain, pause and verify the host automation before recording its schedule receipt. Otherwise reconcile the remaining members using the compiled shared plan. Then call remove_goodfinds_search with the fresh search entity revision. Keep saved listings, their history and seller conversations. Do not run marketplace searches or contact sellers. Confirm when this search is deleted.`,
          ),
        );
        close();
      } else {
        const run = state.search_runs.find(
          (item) => item.search_id === search.id && ACTIVE_SEARCH_PHASES.has(item.phase),
        );
        const latest = run
          ? await action("cancel_goodfinds_search_run", {
              request: { run_id: run.id },
            })
          : state;
        if (!latest) {
          setError("Couldn’t stop this search. Try again.");
          return;
        }
        const next = await action(
          "remove_goodfinds_search",
          {
            search_id: search.id,
            snapshot_revision: latest.revision,
          },
          "Search deleted",
        );
        if (next) close();
        else setError("Couldn’t delete this search. Try again.");
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return (
    <ResponsiveOverlay
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Delete ${search.name}?`}
      description="Your saved listings and their history will be kept."
      returnFocus={returnFocus}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form={id} disabled={busy || saving}>
            {saving ? "Deleting…" : "Delete search"}
          </Button>
        </>
      }
    >
      <form
        id={id}
        onSubmit={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        <p className="text-sm">
          This search will be removed from your list, and its automatic checks will stop.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm">
            {error}
          </p>
        )}
      </form>
    </ResponsiveOverlay>
  );
}
