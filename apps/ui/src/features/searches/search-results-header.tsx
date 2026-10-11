import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchCover } from "@/features/searches/search-cover";
import { searchSummary } from "@/lib/search-presentation";
import { MARKETPLACES } from "@goodfinds/contracts/integrations";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type { Action } from "@/lib/actions";

const labels: Record<SearchRun["phase"], string> = {
  requested: "Waiting to start",
  discovering: "Searching marketplaces",
  verifying: "Checking the best matches",
  completed: "Search finished",
  partial: "Search partly completed",
  blocked: "Search needs attention",
  cancelled: "Search stopped",
  deferred: "Waiting for the next search time",
};

export function SearchResultsHeader({
  search,
  run,
  busy,
  action,
}: {
  search: SavedSearch;
  run: SearchRun | undefined;
  busy: boolean;
  action: Action;
}) {
  const active = run && ACTIVE_SEARCH_PHASES.has(run.phase);
  const attention = run?.phase === "blocked" || run?.phase === "partial";
  return (
    <section className="rounded-xl border bg-card p-4" aria-label="Current search">
      <div className="flex items-start gap-4">
        <SearchCover search={search} compact />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h2 className="text-lg font-semibold">{search.name}</h2>
          <p className="text-sm text-muted-foreground">{searchSummary(search)}</p>
          <p className="text-xs text-muted-foreground">
            {(search.marketplaces ?? ["facebook_marketplace"])
              .map((id) => MARKETPLACES.find((marketplace) => marketplace.id === id)?.name ?? id)
              .join(" · ")}
          </p>
          <output className="flex items-center gap-2 text-sm font-medium">
            {active && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
            {run ? labels[run.phase] : "Ready to search"}
          </output>
        </div>
        {active && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void action(
                "cancel_goodfinds_search_run",
                { request: { run_id: run.id } },
                "Search stopped. Your finds are saved.",
              );
            }}
          >
            Stop
          </Button>
        )}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {attention
          ? (run.interruption ??
            "The search stopped before it finished. Check the chat for the next step.")
          : active
            ? "Listings appear here as they’re saved. Early finds still need their details checked. You can keep chatting while this updates."
            : "Your finds stay here. Compare listings, open their photos, or ask in chat to refine this search."}
      </p>
    </section>
  );
}
