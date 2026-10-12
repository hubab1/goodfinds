import { selectListings, shortlistEvents } from "@goodfinds/contracts/listing-query";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";
import { LearnedPreferences } from "@/features/listings/listing-feedback";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Decision, GoodfindsState } from "@goodfinds/contracts/state";
import { ListingCard, ListingDetail } from "@/features/listings/listing-card";
import { Dialog } from "@/components/ui/dialog";
import { SellerConversationPanel } from "@/features/conversations/seller-conversation-panel";
import { ListingTrends } from "@/features/listings/listing-trends";
import { EMPTY_SELLER_FILTERS, sellerFilterCount } from "@/lib/seller";
import { ListingFilters } from "@/features/listings/seller-filters";
import type { RecordSeen } from "@/features/listings/listing-seen";
import { unseenSearchIds } from "@goodfinds/contracts/listing-reading";
import { Empty } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { ViewProps } from "@/app/feature-props";
import { SearchResultsHeader } from "@/features/searches/search-results-header";
import { ACTIVE_SEARCH_PHASES } from "@goodfinds/contracts/search-workflow";
import { Bookmark } from "lucide-react";

const EMPTY_DECISIONS: Decision[] = [];
export function Deals({
  state,
  busy,
  action,
  selection,
  recordSeen,
}: ViewProps & {
  selection?:
    | { searchId?: string | undefined; listingKey?: string | undefined; unseen: boolean }
    | undefined;
  recordSeen: RecordSeen;
}) {
  const [filter, setFilter] = useState(selection?.searchId ?? "all");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selection) heading.current?.focus();
  }, [selection]);
  const [unseenOnly, setUnseenOnly] = useState(selection?.unseen ?? false);
  const [shortlistedOnly, setShortlistedOnly] = useState(false);
  const [seenThisVisit, setSeenThisVisit] = useState<Set<string>>(() => new Set());
  const selectedSearch = state.searches.find((item) => item.id === filter);
  const [linkedKey, setLinkedKey] = useState(selection?.listingKey);
  const linkedListing = state.listings.find((listing) => listing.key === linkedKey);
  const selectedRun = state.search_runs.find((run) => run.search_id === selectedSearch?.id);
  const searching = selectedRun && ACTIVE_SEARCH_PHASES.has(selectedRun.phase);
  const [sellerKey, setSellerKey] = useState<string>();
  const [sellerSearchId, setSellerSearchId] = useState<string>();
  const [sellerOpen, setSellerOpen] = useState(false);
  const sellerFocus = useRef<HTMLElement | null>(null);
  const sellerListing = state.listings.find((listing) => listing.key === sellerKey);
  const sellerByListing = new Map(
    state.seller_conversations.map((summary) => [summary.listing_key, summary]),
  );
  const openSellerConversation = (key: string, button: HTMLElement) => {
    sellerFocus.current = button;
    setSellerKey(key);
    setSellerSearchId(
      selectedSearch?.id ??
        state.next_steps.find((item) => item.listing_key === key)?.search_id ??
        undefined,
    );
    setSellerOpen(true);
  };
  const [disregardedEvent, setDisregardedEvent] = useState<
    GoodfindsState["config"]["feedback"][number] | null
  >(null);
  const latestDisregard = state.config.feedback.findLast(
    (event) =>
      event.search_id === disregardedEvent?.search_id &&
      event.listing_key === disregardedEvent?.listing_key &&
      event.action === "dismiss",
  );
  const disregarded = latestDisregard && !latestDisregard.undone ? latestDisregard : undefined;
  const [sellerFilters, setSellerFilters] = useState(EMPTY_SELLER_FILTERS);
  const [sort, setSort] = useState<ListingQuery["sort"]>("recommended");
  const filteringSeller = sellerFilterCount(sellerFilters) > 0;
  const now = Date.parse(state.generated_at);
  const decisionsByListing = useMemo(() => {
    const grouped = new Map<string, Decision[]>();
    for (const decision of state.decisions) {
      if (selectedSearch && decision.search_id !== selectedSearch.id) continue;
      const group = grouped.get(decision.listing.key) ?? [];
      group.push(decision);
      grouped.set(decision.listing.key, group);
    }
    return grouped;
  }, [selectedSearch, state.decisions]);
  const available = useMemo(
    () =>
      selectListings(
        state,
        {
          search_id: selectedSearch?.id,
          sellerFilters,
          sort,
        },
        now,
      ),
    [now, selectedSearch, sellerFilters, sort, state],
  );
  const isUnseen = useCallback(
    (listing: GoodfindsState["listings"][number]) =>
      unseenSearchIds(listing, state.searches, selectedSearch?.id).length > 0,
    [state.searches, selectedSearch?.id],
  );
  const unseenCount = available.filter(isUnseen).length;
  const shortlisted = useMemo(
    () =>
      available.filter(
        (listing) =>
          shortlistEvents(
            listing,
            selectedSearch ? [selectedSearch] : state.searches,
            state.config.feedback,
          ).length > 0,
      ),
    [available, selectedSearch, state.searches, state.config.feedback],
  );
  const filtered = shortlistedOnly ? shortlisted : available;
  // Keep cards in place while their automatic receipt saves; clearing a count must not move the list.
  const tracked = useMemo(
    () =>
      unseenOnly
        ? filtered.filter((listing) => isUnseen(listing) || seenThisVisit.has(listing.key))
        : filtered,
    [filtered, unseenOnly, seenThisVisit, isUnseen],
  );
  const onSeen = useCallback<RecordSeen>(
    (pairs) => {
      setSeenThisVisit(
        (current) => new Set([...current, ...pairs.map((pair) => pair.listing_key)]),
      );
      return recordSeen(pairs);
    },
    [recordSeen],
  );
  const suitable = tracked.filter((listing) =>
    decisionsByListing
      .get(listing.key)
      ?.some((decision) =>
        decision.suitability
          ? decision.suitability !== "unsuitable"
          : ["qualifies", "not_deal", "insufficient_comparables"].includes(decision.status),
      ),
  );
  const deals = tracked.filter((listing) =>
    decisionsByListing.get(listing.key)?.some((decision) => decision.status === "qualifies"),
  );
  const sample = state.mode === "sample";
  const renderListings = (listings: typeof tracked) =>
    listings.map((listing) => (
      <ListingCard
        key={listing.key}
        listing={listing}
        decisions={decisionsByListing.get(listing.key) ?? EMPTY_DECISIONS}
        sample={sample}
        searches={state.searches}
        seller_conversation={sellerByListing.get(listing.key)}
        state={state}
        onNegotiate={(button) => openSellerConversation(listing.key, button)}
        busy={busy}
        action={action}
        preferredWatchId={selectedSearch?.id}
        onDisregarded={setDisregardedEvent}
        onSeen={onSeen}
      />
    ));
  return (
    <section className="space-y-5">
      <PageHeader
        title="Your finds"
        subtitle="Listings saved from your searches."
        headingRef={heading}
        headingTabIndex={-1}
        actions={
          <p className="hidden text-xs text-muted-foreground @lg:block">
            {state.counts.active_searches} active{" "}
            {state.counts.active_searches === 1 ? "search" : "searches"}
          </p>
        }
      />
      <ListingFilters
        searches={state.searches}
        search={filter}
        onSearchChange={(value) => {
          setFilter(value);
          setSeenThisVisit(new Set());
        }}
        filters={sellerFilters}
        onFiltersChange={setSellerFilters}
        sort={sort}
        onSortChange={setSort}
        resultCount={tracked.length}
      />
      {((selection?.searchId &&
        !state.searches.some((search) => search.id === selection.searchId)) ||
        (linkedKey && !linkedListing)) && (
        <output className="text-sm text-muted-foreground">
          This saved search or listing is no longer available in this workspace.
        </output>
      )}
      {selectedSearch && (
        <>
          <SearchResultsHeader
            search={selectedSearch}
            run={selectedRun}
            busy={busy}
            action={action}
          />
          <LearnedPreferences search={selectedSearch} state={state} busy={busy} action={action} />
        </>
      )}
      {disregarded && (
        <output className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
          <span>
            {disregarded.exclude_model
              ? (disregarded.rule?.label ?? "Model excluded from this search")
              : "Listing disregarded"}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void action(
                  "undo_goodfinds_listing_feedback",
                  { snapshot_revision: state.revision, feedback_id: disregarded.id },
                  "Listing restored",
                );
              }}
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDisregardedEvent(null)}
              aria-label="Dismiss confirmation"
            >
              Close
            </Button>
          </div>
        </output>
      )}
      <Tabs defaultValue="tracked" className="gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b">
          <TabsList
            variant="line"
            className="w-full min-w-0 justify-start @sm:w-auto @sm:flex-1"
            aria-label="Listing results"
          >
            <TabsTrigger
              value="tracked"
              className="min-w-0 flex-1 px-1 text-xs sm:flex-none sm:px-3 sm:text-sm"
            >
              All listings <span className="ml-1 text-xs">{tracked.length}</span>
            </TabsTrigger>
            <TabsTrigger
              value="suitable"
              aria-label={`Promising options ${suitable.length}`}
              className="min-w-0 flex-1 px-1 text-xs sm:flex-none sm:px-3 sm:text-sm"
            >
              <span>
                Promising<span className="hidden sm:inline"> options</span>
              </span>
              <span className="ml-1 text-xs">{suitable.length}</span>
            </TabsTrigger>
            <TabsTrigger
              value="deals"
              className="min-w-0 flex-1 px-1 text-xs sm:flex-none sm:px-3 sm:text-sm"
            >
              Good deals <span className="ml-1 text-xs">{deals.length}</span>
            </TabsTrigger>
          </TabsList>
          <Button
            size="sm"
            aria-pressed={shortlistedOnly}
            title="Listings you’ve bookmarked"
            onClick={() => setShortlistedOnly((value) => !value)}
          >
            <Bookmark fill={shortlistedOnly ? "currentColor" : "none"} aria-hidden="true" />
            Shortlisted <span className="tabular-nums">{shortlisted.length}</span>
          </Button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground hover:underline aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-2 aria-pressed:ring-offset-background"
            aria-pressed={unseenOnly}
            title="Listings you haven’t viewed yet"
            onClick={() => {
              setUnseenOnly((value) => !value);
              setSeenThisVisit(new Set());
            }}
          >
            New <span className="tabular-nums">{unseenCount}</span>
          </button>
        </div>
        <TabsContent value="tracked" className="space-y-4">
          <output className="sr-only" aria-live="polite">
            {tracked.length} listings
          </output>
          {tracked.length ? (
            renderListings(tracked)
          ) : (
            <Empty
              title={
                shortlistedOnly
                  ? "No shortlisted listings"
                  : unseenOnly
                    ? "You’re all caught up"
                    : filteringSeller
                      ? "No listings match your filters"
                      : searching
                        ? "Your search is getting started"
                        : selectedRun?.phase === "completed"
                          ? "No listings found in this search"
                          : "No listings yet"
              }
            >
              <p className="max-w-sm text-sm leading-relaxed">
                {shortlistedOnly
                  ? unseenOnly || filteringSeller
                    ? "No shortlisted listings match your filters."
                    : "Use the bookmark on a listing to keep it here."
                  : unseenOnly
                    ? "No new listings match your filters."
                    : filteringSeller
                      ? "Change or clear your seller filters to see more listings."
                      : searching
                        ? "The first finds will appear here automatically. You can keep this panel open or continue in chat."
                        : selectedRun?.phase === "completed"
                          ? "Check the search summary in chat, or adjust your requirements and search again."
                          : "Listings will appear here after your next search."}
              </p>
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="suitable" className="space-y-4">
          {renderListings(suitable)}
        </TabsContent>
        <TabsContent value="deals" className="space-y-4">
          {deals.length ? (
            renderListings(deals)
          ) : (
            <Empty title={filteringSeller ? "No deals match your filters" : "No good deals yet"}>
              <p className="max-w-sm text-sm leading-relaxed">
                {filteringSeller
                  ? "Change or clear your seller filters to see more deals."
                  : "Good deals need to meet your requirements and cost less than similar listings. You can still browse everything in All listings."}
              </p>
              {import.meta.env["DEV"] && !filteringSeller && !sample && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void action(
                      "load_goodfinds_sample_workspace",
                      { mode: "sample" },
                      "Sample listings evaluated",
                    );
                  }}
                >
                  Explore sample deals
                </Button>
              )}
            </Empty>
          )}
        </TabsContent>
      </Tabs>
      {selectedSearch && (
        <ListingTrends
          key={selectedSearch.id}
          search={selectedSearch}
          history={selectedSearch.market_history}
          listings={tracked}
          decisions={state.decisions}
          searches={state.searches}
          now={now}
          sample={sample}
          hideEmpty
        />
      )}
      {sellerListing && (
        <SellerConversationPanel
          key={`${state.mode}:${sellerListing.key}:${sellerSearchId ?? "all"}`}
          listing={sellerListing}
          searchId={sellerSearchId}
          state={state}
          action={action}
          busy={busy}
          open={sellerOpen}
          onOpenChange={setSellerOpen}
          returnFocus={sellerFocus}
          checkOnOpen={
            sellerListing
              ? sellerByListing.get(sellerListing.key)?.action_label === "Check replies"
              : false
          }
        />
      )}
      <Dialog
        open={Boolean(linkedListing)}
        onOpenChange={(open) => {
          if (!open) setLinkedKey(undefined);
        }}
      >
        {linkedListing && (
          <ListingDetail
            listing={linkedListing}
            decisions={decisionsByListing.get(linkedListing.key) ?? EMPTY_DECISIONS}
            sample={sample}
            photoIndex={0}
            searches={state.searches}
            preferredSearchId={
              selectedSearch?.product === linkedListing.product ? selectedSearch.id : undefined
            }
            seller_conversation={sellerByListing.get(linkedListing.key)}
            onNegotiate={(button) => {
              setLinkedKey(undefined);
              openSellerConversation(linkedListing.key, button);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
