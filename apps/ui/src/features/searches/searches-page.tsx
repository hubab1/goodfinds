import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fulfilledSearches } from "@goodfinds/contracts/buying-next-steps";
import { monitoringSummary } from "@goodfinds/contracts/monitoring";
import type { SavedSearch } from "@goodfinds/contracts/state";
import type { SearchDraft } from "@goodfinds/contracts/search-definition";
import { SearchListRow } from "@/features/searches/search-list-row";
import { Empty } from "@/components/ui/empty-state";
import type { ViewProps } from "@/app/feature-props";

export function Searches({
  state,
  busy,
  action,
  edit,
  resume,
  onSearch,
  onListings,
}: ViewProps & {
  edit: (search?: SavedSearch) => void;
  resume: (draft: SearchDraft) => void;
  onSearch: (search?: SavedSearch) => void;
  onListings: (searchId: string, unseen: boolean) => void;
}) {
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Your searches</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Keep track of what you're looking for.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || state.mode === "sample" || state.counts.active_searches === 0}
            aria-label="Search all enabled searches"
            title="Search all enabled searches"
            onClick={() => onSearch()}
          >
            <Search aria-hidden="true" />
            Search all
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              edit();
            }}
          >
            <Plus aria-hidden="true" />
            New search
          </Button>
        </div>
      </div>
      {state.drafts.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-medium">Unfinished searches</h3>
          {state.drafts.map((draft) => (
            <Card key={draft.id} className="py-4">
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{draft.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {draft.definition.title} · saved for later
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void action(
                        "discard_goodfinds_search_draft",
                        { draft_id: draft.id, snapshot_revision: state.revision },
                        "Unfinished search discarded",
                      );
                    }}
                  >
                    Discard
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => resume(draft)}>
                    Continue
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {state.searches.length > 0 ? (
        <ul
          className="divide-y rounded-xl border bg-card px-4 @lg:px-5"
          aria-label="Saved searches"
        >
          {state.searches.map((search) => (
            <SearchListRow
              key={search.id}
              search={search}
              run={state.search_runs.find((run) => run.search_id === search.id)}
              workflow={state.search_workflows[search.id]}
              monitoring={
                state.monitoring.find((item) => item.search_id === search.id) ??
                monitoringSummary(
                  search,
                  state.config.monitoring,
                  state.config.schedule.interval_minutes,
                  fulfilledSearches(state.seller_conversations).has(search.id),
                  state.mode === "sample",
                )
              }
              fulfilled={fulfilledSearches(state.seller_conversations).has(search.id)}
              origin={state.config.origin}
              sample={state.mode === "sample"}
              revision={state.revision}
              busy={busy}
              action={action}
              edit={() => edit(search)}
              onSearch={() => onSearch(search)}
              onListings={(unseen) => onListings(search.id, unseen)}
            />
          ))}
        </ul>
      ) : (
        <Empty title="Start your first search">
          <p className="text-sm">Save what you're looking for and keep your finds in one place.</p>
        </Empty>
      )}
    </section>
  );
}
