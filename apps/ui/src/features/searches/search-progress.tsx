import { searchProgress } from "@goodfinds/contracts/search-workflow";
import { canProposeAction, canProposeEvent } from "@goodfinds/contracts/workflow-model";
import type { Workflow } from "@goodfinds/contracts/workflow-model";
import type { SearchRun } from "@goodfinds/contracts/search-workflow";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { Button } from "@/components/ui/button";

export function SearchProgress({
  runs,
  searches,
  busy,
  workflows,
  resume,
  cancel,
}: {
  runs: SearchRun[];
  searches: SavedSearch[];
  busy: boolean;
  workflows: Record<string, Workflow>;
  resume: (search: SavedSearch) => void;
  cancel: (run: SearchRun) => void;
}) {
  const latest = runs.filter(
    (run, index) => runs.findIndex((item) => item.search_id === run.search_id) === index,
  );
  return (
    <div className="mt-4 space-y-3" aria-label="Search progress" aria-live="polite">
      {latest.map((run) => {
        const search = searches.find((item) => item.id === run.search_id);
        if (!search) return null;
        const progress = searchProgress(run);
        const view = workflows[run.id];
        const resumable = canProposeEvent(view, "resume");
        return (
          <section key={run.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>
                {search.name} ·{" "}
                {run.phase === "requested"
                  ? "Waiting for chat"
                  : run.phase === "deferred"
                    ? "Waiting for active hours"
                    : run.phase}
              </strong>
              <div className="flex gap-2">
                {resumable && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => resume(search)}
                  >
                    Resume
                  </Button>
                )}
                {canProposeAction(view, "cancel_search_run") && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => cancel(run)}>
                    Stop run
                  </Button>
                )}
              </div>
            </div>
            <p>
              {progress.checked_queries}/{progress.total_queries} queries checked ·{" "}
              {progress.discovered} listings saved · {progress.verified} galleries reviewed
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {run.interruption ?? run.next_step}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer">Query coverage</summary>
              <ul className="mt-2 space-y-1">
                {run.queries.map((query) => (
                  <li key={query.id}>
                    {query.text} · {query.purpose} · {query.marketplace.replaceAll("_", " ")} ·{" "}
                    {query.status}
                    {query.unique_relevant_count !== null
                      ? ` · ${query.unique_relevant_count} new relevant listings`
                      : ""}
                    {query.reason ? ` · ${query.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}
