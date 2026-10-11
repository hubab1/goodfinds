import { appliesToSearch } from "@goodfinds/contracts/discovery";
import type { GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { HostAction } from "@/host-action";
import type { Action } from "@/lib/actions";

const SCOPE_LABELS: Record<FeedbackEvent["scope"], string> = {
  search: "This search",
  category: "This category",
  global: "All searches",
};

export function LearnedPreferences({
  search,
  state,
  busy,
  action,
}: {
  search: SavedSearch;
  state: GoodfindsState;
  busy: boolean;
  action: Action;
}) {
  const events = state.config.feedback.filter((event) => appliesToSearch(event, search));
  if (!events.length) return null;
  return (
    <Disclosure title={`Your preferences (${events.length})`}>
      <p className="text-xs text-muted-foreground">
        Preferences for this search. Undo any change below.
      </p>
      {events.toReversed().map((event) => (
        <div
          key={event.id}
          className="flex flex-wrap items-start justify-between gap-3 border-t pt-3"
        >
          <div className="space-y-1">
            <p className="text-sm">
              {event.rule?.label ??
                event.reason ??
                (event.action === "dismiss"
                  ? "Listing disregarded"
                  : event.action === "shortlist"
                    ? "Listing shortlisted"
                    : "Find similar listings")}
            </p>
            <p className="text-xs text-muted-foreground">
              {SCOPE_LABELS[event.scope]}
              {event.rule &&
                ` · ${event.rule.importance === "required" ? "Must have" : "Preference"}`}
            </p>
          </div>
          <div className="flex gap-2">
            <HostAction
              disabled={busy || !state.revisions.feedback[event.id]}
              request={`Use Goodfinds to review my feedback event ${JSON.stringify(event.id)} for search ${JSON.stringify(search.id)}. Read the current state, original reason and scope. Ask me only the missing preference details using native questions when available. Preserve listing versus model scope. Record an explicit replacement rule only after I state it, then undo the superseded event. Offer category/global scope only if I ask to reuse the preference.`}
            >
              Edit preference
            </HostAction>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void action(
                  "undo_goodfinds_listing_feedback",
                  { snapshot_revision: state.revision, feedback_id: event.id },
                  "Feedback undone",
                );
              }}
            >
              Undo
            </Button>
          </div>
        </div>
      ))}
    </Disclosure>
  );
}
