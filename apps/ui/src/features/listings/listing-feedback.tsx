import { useState } from "react";
import { appliesToSearch } from "@goodfinds/contracts/discovery";
import type { Listing, GoodfindsState, SavedSearch } from "@goodfinds/contracts/state";
import type { FeedbackEvent } from "@goodfinds/contracts/discovery";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { requestHostAction } from "@/lib/client";
import { errorMessage } from "@goodfinds/contracts/state";
import { hostRequest } from "@goodfinds/contracts/host-request";
import { HostAction } from "@/host-action";
import type { Action } from "@/lib/actions";

const SCOPE_LABELS: Record<FeedbackEvent["scope"], string> = {
  search: "This search",
  category: "This category",
  global: "All searches",
};

export function ListingFeedback({
  listing,
  search,
  state,
  busy,
  action,
}: {
  listing: Listing;
  search: SavedSearch;
  state: GoodfindsState;
  busy: boolean;
  action: Action;
}) {
  const [message, setMessage] = useState("");
  const latest = state.config.feedback.findLast(
    (event) => appliesToSearch(event, search) && event.listing_key === listing.key,
  );
  async function record(kind: "shortlist" | "more_like") {
    const next = await action(
      "record_goodfinds_listing_feedback",
      {
        snapshot_revision: state.revision,
        feedback: {
          search_id: search.id,
          listing_key: listing.key,
          action: kind,
          scope: "search",
        },
      },
      kind === "shortlist" ? "Listing shortlisted" : "Preference saved for this search",
    );
    if (next && kind === "more_like") {
      const prompt = hostRequest(
        `Use Goodfinds's marketplace-shopping skill to show more like listing ${JSON.stringify(listing.key)} for search ${JSON.stringify(search.id)}. Read saved research and my latest feedback. Use built-in web search to identify suitable analogous models or features, preserve must-haves and exclusions, and update the sourced discovery queries/candidates with fresh revision checks. Explain trade-offs. A click does not make every attribute a requirement. Then check available selected marketplace routes; ask at most one decisive clarification if needed.`,
      );
      try {
        await requestHostAction(prompt);
        setMessage("Finding similar options.");
      } catch (error) {
        setMessage(errorMessage(error));
      }
    }
  }
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      {message && <output className="block text-xs">{message}</output>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || latest?.action === "shortlist"}
          onClick={() => {
            void record("shortlist");
          }}
        >
          {latest?.action === "shortlist" ? "Shortlisted" : "Shortlist"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || latest?.action === "more_like"}
          onClick={() => {
            void record("more_like");
          }}
        >
          Show more like this
        </Button>
      </div>
    </div>
  );
}
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
              disabled={busy}
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
