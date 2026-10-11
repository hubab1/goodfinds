import { useId, useMemo, useRef, useState } from "react";
import { Bookmark, Ellipsis, MessageCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { FormField } from "@/components/ui/form-field";
import { SelectControl } from "@/components/ui/select";
import { ResponsiveOverlay } from "@/components/ui/responsive-overlay";
import { shortlistEvents } from "@goodfinds/contracts/listing-query";
import { errorMessage } from "@goodfinds/contracts/state";
import type { GoodfindsState, Listing, SavedSearch } from "@goodfinds/contracts/state";
import { hostRequest } from "@goodfinds/contracts/host-request";
import { requestHostAction } from "@/lib/client";
import type { Action } from "@/lib/actions";

type FeedbackAction = "shortlist" | "more_like";

export function ListingActions({
  listing,
  state,
  action,
  busy,
  preferredSearchId,
  messageLabel,
  onMessage,
}: {
  listing: Listing;
  state: GoodfindsState;
  action?: Action | undefined;
  busy: boolean;
  preferredSearchId?: string | undefined;
  messageLabel?: string | undefined;
  onMessage?: ((button: HTMLElement) => void) | undefined;
}) {
  const searches = useMemo(
    () => state.searches.filter((search) => search.product === listing.product),
    [state.searches, listing.product],
  );
  const selectedSearch = searches.find((search) => search.id === preferredSearchId);
  const directSearch = selectedSearch ?? (searches.length === 1 ? searches[0] : undefined);
  const searchOptions = useMemo(
    () => [
      { value: "", label: "Choose a search" },
      ...searches.map((search) => ({ value: search.id, label: search.name })),
    ],
    [searches],
  );
  const events = shortlistEvents(
    listing,
    selectedSearch ? [selectedSearch] : searches,
    state.config.feedback,
  );
  const shortlisted = events.length > 0;
  const [pending, setPending] = useState<FeedbackAction | null>(null);
  const [searchId, setSearchId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const bookmark = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const openingMessage = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();

  async function record(kind: FeedbackAction, search: SavedSearch) {
    if (!action || busy || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const next = await action("record_goodfinds_listing_feedback", {
        snapshot_revision: state.revision,
        feedback: {
          search_id: search.id,
          listing_key: listing.key,
          action: kind,
          scope: "search",
        },
      });
      if (!next) return;
      setPending(null);
      if (kind === "more_like")
        await requestHostAction(
          hostRequest(
            `Use Goodfinds's marketplace-shopping skill to find similar options to listing ${JSON.stringify(listing.key)} for search ${JSON.stringify(search.id)}. Read saved research and my latest feedback. Use built-in web search to identify suitable analogous models or features, preserve must-haves and exclusions, and update the sourced discovery queries/candidates with fresh revision checks. Explain trade-offs. A click does not make every attribute a requirement. Then check available selected marketplace routes; ask at most one decisive clarification if needed.`,
          ),
        );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  async function remove() {
    if (!action || busy || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      // Older panels could save duplicate bookmarks. Clear each active mark for this view.
      for (const event of events) {
        // Await each Undo because the fallback transport serializes mutations.
        // oxlint-disable-next-line no-await-in-loop
        const next = await action("undo_goodfinds_listing_feedback", {
          snapshot_revision: state.revision,
          feedback_id: event.id,
        });
        if (!next) break;
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  function choose(kind: FeedbackAction) {
    returnFocus.current = kind === "shortlist" ? bookmark.current : menu.current;
    setError("");
    if (directSearch) void record(kind, directSearch);
    else {
      setSearchId("");
      setPending(kind);
    }
  }

  return (
    <>
      {action && (
        <Button
          ref={bookmark}
          size="icon-sm"
          aria-label={
            shortlisted ? `Remove ${listing.title} from shortlist` : `Shortlist ${listing.title}`
          }
          title={shortlisted ? "Remove from shortlist" : "Shortlist"}
          aria-pressed={shortlisted}
          disabled={busy || saving || !searches.length}
          onClick={() => {
            if (shortlisted) void remove();
            else choose("shortlist");
          }}
        >
          <Bookmark fill={shortlisted ? "currentColor" : "none"} aria-hidden="true" />
        </Button>
      )}
      <Menu
        disabled={busy || saving}
        onOpenChange={(open) => {
          if (open) openingMessage.current = false;
        }}
      >
        <MenuTrigger
          ref={menu}
          render={<Button size="icon-sm" />}
          aria-label={`More options for ${listing.title}`}
          title="More options"
        >
          <Ellipsis aria-hidden="true" />
        </MenuTrigger>
        <MenuContent
          aria-label="Listing actions"
          finalFocus={() => pending === null && !openingMessage.current}
        >
          {onMessage && (
            <MenuItem
              onClick={() => {
                if (menu.current) {
                  openingMessage.current = true;
                  onMessage(menu.current);
                }
              }}
            >
              <MessageCircle aria-hidden="true" /> {messageLabel ?? "Prepare message"}
            </MenuItem>
          )}
          {action && (
            <MenuItem disabled={!searches.length} onClick={() => choose("more_like")}>
              <Search aria-hidden="true" /> Find similar
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {error && (
        <p role="alert" className="basis-full text-xs">
          {error}
        </p>
      )}
      <ResponsiveOverlay
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending === "more_like" ? "Find similar" : "Shortlist listing"}
        description="Choose the search this applies to."
        returnFocus={returnFocus}
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button type="submit" form={id} disabled={busy || saving || !searchId}>
              {pending === "more_like" ? "Find similar" : "Shortlist"}
            </Button>
          </>
        }
      >
        <form
          id={id}
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const search = searches.find((item) => item.id === searchId);
            if (pending && search) void record(pending, search);
          }}
        >
          <p className="text-sm font-medium">{listing.title}</p>
          <FormField id={id + "-search"} label="Search">
            <SelectControl
              id={id + "-search"}
              value={searchId}
              onValueChange={setSearchId}
              options={searchOptions}
            />
          </FormField>
        </form>
      </ResponsiveOverlay>
    </>
  );
}
