import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import { errorMessage } from "@goodfinds/contracts/state";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import type { PanelInput, PanelTool } from "@/lib/actions";

type SearchDependencies = {
  invoke: <K extends PanelTool>(name: K, input: PanelInput<K>) => Promise<GoodfindsState>;
  requireHostActions: () => Promise<unknown>;
  requestBrowserSearch: (searchId?: string, runIds?: string[]) => Promise<unknown>;
  update: (state: GoodfindsState) => void;
};

/** Save requests before dispatch; reconcile only unclaimed requests if dispatch fails. */
export async function requestSearches(
  state: GoodfindsState,
  search: SavedSearch | undefined,
  client: SearchDependencies,
): Promise<void> {
  if (state.mode === "sample") return;
  const queued: GoodfindsState["search_runs"] = [];
  try {
    await client.requireHostActions();
    let latest = state;
    const runIds: string[] = [];
    const fulfilled = fulfilledSearches(state.seller_conversations);
    for (const selected of search
      ? [search]
      : state.searches.filter((item) => item.enabled && !fulfilled.has(item.id))) {
      // oxlint-disable-next-line no-await-in-loop -- Consume each authoritative snapshot before the next mutation.
      latest = await client.invoke("request_goodfinds_search_run", {
        mode: state.mode,
        request: {
          search_id: selected.id,
          request_id: crypto.randomUUID(),
          resume: true,
          trigger: "manual",
        },
      });
      const run = latest.search_runs.find(
        (item) => item.search_id === selected.id && ACTIVE_SEARCH_PHASES.has(item.phase),
      );
      if (run) {
        runIds.push(run.id);
        if (!run.worker && run.phase === "requested") queued.push(run);
      }
    }
    client.update(latest);
    await client.requestBrowserSearch(search?.id, runIds);
  } catch (failure) {
    for (const run of queued) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- Reconcile each request independently; a worker may have claimed one already.
        const next = await client.invoke("update_goodfinds_search_run", {
          mode: state.mode,
          request: {
            run_id: run.id,
            expected_version: run.version,
            phase: "blocked",
            interruption: errorMessage(failure),
            next_step: "Try this search again from the connected app.",
          },
        });
        client.update(next);
      } catch {
        /* Retain the original dispatch error and any worker's newer activity. */
      }
    }
    throw failure;
  }
}
