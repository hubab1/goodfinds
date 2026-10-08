import { selectListings } from "@goodfinds/contracts/listing-query";
import type { ListingQuery } from "@goodfinds/contracts/listing-query";
import { ListingFeedback, LearnedPreferences } from "@/features/listings/listing-feedback";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Decision, GoodfindsState } from "@goodfinds/contracts/state";
import { ListingCard } from "@/features/listings/listing-card";
import { SellerConversationPanel } from "@/features/conversations/seller-conversation-panel";
import { ListingTrends } from "@/features/listings/listing-trends";
import { EMPTY_SELLER_FILTERS, sellerFilterCount } from "@/lib/seller";
import { ListingFilters } from "@/features/listings/seller-filters";
import type { RecordSeen } from "@/features/listings/listing-seen";
import { unseenSearchIds } from "@goodfinds/contracts/listing-reading";
import { Empty } from "@/components/ui/empty-state";
import type { ViewProps } from "@/app/feature-props";

const EMPTY_DECISIONS: Decision[] = [];
export function Deals({
  state,
  busy,
  action,
  selection,
  recordSeen,
}: ViewProps & {
  selection?: { searchId: string; unseen: boolean } | undefined;
  recordSeen: RecordSeen;
}) {
  const [filter, setFilter] = useState(selection?.searchId ?? "all");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selection) heading.current?.focus();
  }, [selection]);
  const [unseenOnly, setUnseenOnly] = useState(selection?.unseen ?? false);
  const [seenThisVisit, setSeenThisVisit] = useState<Set<string>>(() => new Set());
  const selectedSearch = state.searches.find((item) => item.id === filter);
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
  const [disregardedId, setDisregardedId] = useState<string | null>(null);
  const disregarded = state.config.feedback.find(
    (event) => event.id === disregardedId && !event.undone,
  );
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
  // Keep cards in place while their automatic receipt saves; clearing a count must not move the list.
  const tracked = useMemo(
    () =>
      unseenOnly
        ? available.filter((listing) => isUnseen(listing) || seenThisVisit.has(listing.key))
        : available,
    [available, unseenOnly, seenThisVisit, isUnseen],
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
      <div key={listing.key} className="space-y-2">
        <ListingCard
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
          onDisregarded={setDisregardedId}
          onSeen={onSeen}
        />
        {selectedSearch && (
          <ListingFeedback
            listing={listing}
            search={selectedSearch}
            state={state}
            busy={busy}
            action={action}
          />
        )}
      </div>
    ));
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            Your finds
          </h1>
          <p className="mt-1 text-sm">Listings saved from your searches.</p>
        </div>
        <p className="hidden text-xs @lg:block">
          {state.counts.active_searches} active{" "}
          {state.counts.active_searches === 1 ? "search" : "searches"}
        </p>
      </div>
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
      {selectedSearch && (
        <>
          <ListingTrends
            key={selectedSearch.id}
            search={selectedSearch}
            history={selectedSearch.market_history}
            listings={tracked}
            decisions={state.decisions}
            searches={state.searches}
            now={now}
            sample={sample}
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
              onClick={() => setDisregardedId(null)}
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
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-black px-3 py-2 text-xs text-white hover:underline aria-pressed:ring-2 aria-pressed:ring-black aria-pressed:ring-offset-2"
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
                unseenOnly
                  ? "You’re all caught up"
                  : filteringSeller
                    ? "No listings match your filters"
                    : "No listings yet"
              }
            >
              <p className="max-w-sm text-sm leading-relaxed">
                {unseenOnly
                  ? "No new listings match your filters."
                  : filteringSeller
                    ? "Change or clear your seller filters to see more listings."
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
              {!filteringSeller && !sample && (
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
    </section>
  );
}
