import "./listings.css";
import { Disclosure } from "@/components/ui/disclosure";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUpRight, MapPin, MessageCircle, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { SellerConversationSummary } from "@goodfinds/contracts/seller-conversation";
import { SellerConversationChip } from "@/features/conversations/seller-conversation-panel";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Decision, Listing, SavedSearch, GoodfindsState } from "@goodfinds/contracts/state";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyDecisionReasons, listingDetailFacts } from "@/lib/listing-presentation";
import { firstDiscovery } from "@goodfinds/contracts/listing-discovery";
import { unseenSearchIds } from "@goodfinds/contracts/listing-reading";
import { RelativeTime } from "@/relative-time";
import { useListingExposure } from "@/features/listings/listing-seen";
import type { RecordSeen } from "@/features/listings/listing-seen";
import {
  date,
  evidenceText,
  marketplaceUrl,
  money,
  pricePeriod,
  storage,
} from "@/lib/presentation";
import { ListingHistory } from "@/features/listings/listing-history";
import { ListingPhotos, ListingThumbnail, SellerDetails } from "@/features/listings/listing-media";
import { MarketplaceBadge } from "@/marketplace-badge";
import { ListingDisregard } from "@/features/listings/listing-disregard";
import type { Action } from "@/lib/actions";
import { setupCostTotal } from "@goodfinds/contracts/verification";
import { DetailFacts } from "@/components/ui/detail-facts";
import "@/features/listings/listing-detail.css";

function listingFacts(listing: Listing): string[] {
  if (listing.product === "macbook_pro" || listing.product === "mac_mini") {
    const facts = [
      listing.chip,
      listing.ram_gb != null ? `${listing.ram_gb} GB memory` : null,
      listing.ssd_gb != null ? `${storage(listing.ssd_gb)} SSD` : null,
    ].filter((value): value is string => Boolean(value));
    if (!listing.chip || listing.ram_gb == null || listing.ssd_gb == null)
      facts.push("Some specs missing");
    return facts;
  }
  const attributes = listing.attributes ?? {};
  const keys =
    listing.product === "rental"
      ? ["bedrooms", "property_type", "accommodation"]
      : ["brand", "model", "size", "colour", "year", "mileage"];
  const facts = keys.flatMap((key) => {
    const value = attributes[key];
    if (typeof value !== "string" && typeof value !== "number") return [];
    if (key === "bedrooms") return [`${value} ${value === 1 ? "bedroom" : "bedrooms"}`];
    if (key === "accommodation")
      return [value === "whole_property" ? "Whole property" : String(value).replaceAll("_", " ")];
    return [String(value).replaceAll("_", " ")];
  });
  return facts.length ? facts.slice(0, 4) : ["Some details missing"];
}

function decisionLabel(decision: Decision): string {
  switch (decision.status) {
    case "qualifies":
      return "Good deal";
    case "not_matching":
      return "Doesn’t match your search";
    case "needs_review":
      return "Needs a closer look";
    case "insufficient_comparables":
      return "Waiting for price comparisons";
    case "not_deal":
      return "At or above average price";
    default:
      return "Still being checked";
  }
}

function DecisionBadge({
  decision,
  search,
}: {
  decision: Decision;
  search: SavedSearch | undefined;
}) {
  const [open, setOpen] = useState(false);
  const reasons = friendlyDecisionReasons(decision, search);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        type="button"
        closeOnClick={false}
        onClick={() => setOpen((previous) => !previous)}
        render={
          <Badge
            render={<button aria-label={decisionLabel(decision)} />}
            variant={decision.status === "qualifies" ? "default" : "outline"}
          />
        }
      >
        {decision.status === "qualifies" && <ArrowDown aria-hidden="true" />}
        {decision.status === "qualifies" && decision.percent_below_average != null
          ? `${decision.percent_below_average}% below average`
          : decisionLabel(decision)}
      </TooltipTrigger>
      <TooltipContent align="start" className="space-y-2">
        {reasons.length ? (
          reasons.map((reason) => <p key={reason}>{reason}</p>)
        ) : (
          <p>{decisionLabel(decision)}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function ListingLink({ url, children }: { url: string | null | undefined; children: string }) {
  const href = marketplaceUrl(url);
  return href ? (
    <a
      className={buttonVariants({ size: "sm" })}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRight aria-hidden="true" />
    </a>
  ) : null;
}

function DecisionChecks({
  decision,
  search,
}: {
  decision: Decision;
  search: SavedSearch | undefined;
}) {
  const facts = useMemo(() => {
    const rows = [
      {
        label: "Requirements",
        value:
          decision.suitability === "suitable"
            ? "Matches"
            : decision.suitability === "unsuitable"
              ? "Doesn’t match"
              : "Needs checking",
      },
      {
        label: "Details",
        value: decision.verification === "complete" ? "Checked" : "Needs checking",
      },
      {
        label: "Price comparison",
        value:
          decision.value === "below_average"
            ? "Below average"
            : decision.value === "at_or_above_average"
              ? "At or above average"
              : "Not enough information",
      },
    ];
    if (decision.reference_average_minor != null)
      rows.push({
        label: "Average asking price",
        value:
          money(decision.reference_average_minor, decision.listing.currency ?? "GBP") +
          pricePeriod(decision.listing.price_period),
      });
    return rows;
  }, [decision]);
  const reasons = friendlyDecisionReasons(decision, search);
  return (
    <section className="listing-detail-comparison space-y-4" aria-label={decision.search_name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{decision.search_name}</h4>
        <Badge variant={decision.status === "qualifies" ? "default" : "outline"}>
          {decisionLabel(decision)}
        </Badge>
      </div>
      <DetailFacts facts={facts} />
      {reasons.length > 0 && (
        <ul className="list-disc space-y-1.5 pl-4 text-sm leading-relaxed">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {decision.peer_count != null && decision.reference_average_minor != null && (
        <p className="text-xs text-muted-foreground">
          Compared with {decision.peer_count} similar{" "}
          {decision.peer_count === 1 ? "listing" : "listings"}.
        </p>
      )}
      {Boolean(decision.preferences?.length) && (
        <p className="text-sm leading-relaxed">{decision.preferences?.join(". ")}</p>
      )}
      {decision.credibility && (
        <Disclosure title="Price and seller checks">
          {decision.credibility.reasons.length > 0 && (
            <ul className="list-disc space-y-1.5 pl-4 text-sm">
              {decision.credibility.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {decision.credibility.reference_median_minor != null && (
            <p className="text-sm">
              Median asking price{" "}
              {money(
                decision.credibility.reference_median_minor,
                decision.listing.currency ?? "GBP",
              )}{" "}
              across {decision.credibility.peer_count} similar listings.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Price and profile signals don’t verify the seller or item.
          </p>
        </Disclosure>
      )}
    </section>
  );
}

function ListingExtraCosts({ listing }: { listing: Listing }) {
  const facts = useMemo(() => {
    if (!listing.setup_costs?.length) return [];
    const total = setupCostTotal(listing);
    return [
      {
        label: "Complete setup",
        value:
          total.total_minor === null
            ? "Total not known"
            : money(total.total_minor, listing.currency ?? "GBP") +
              (total.basis === "estimate" ? " (estimate)" : ""),
      },
      ...listing.setup_costs.map((cost) => ({
        label: cost.label,
        value:
          cost.price_minor === null
            ? "Cost not known"
            : money(cost.price_minor, cost.currency) +
              (cost.basis === "estimate" ? " (estimate)" : ""),
      })),
    ];
  }, [listing]);
  if (!facts.length) return null;
  return (
    <Disclosure title="Additional costs">
      <DetailFacts facts={facts} />
    </Disclosure>
  );
}

export function ListingDetail({
  listing,
  decisions,
  sample,
  photoIndex,
  searches,
  seller_conversation,
  onNegotiate,
}: {
  listing: Listing;
  decisions: Decision[];
  sample: boolean;
  photoIndex: number;
  searches: SavedSearch[];
  seller_conversation?: SellerConversationSummary | undefined;
  onNegotiate?: ((button: HTMLElement) => void) | undefined;
}) {
  const search =
    searches.find((item) => item.id === decisions[0]?.search_id) ??
    searches.find((item) => item.product === listing.product);
  const facts = listingDetailFacts(listing, search);
  const extraPrice =
    listing.total_cash_cost_minor != null && listing.total_cash_cost_minor !== listing.price_minor;
  const hasActions = Boolean(onNegotiate || (!sample && marketplaceUrl(listing.url)));
  const priceHistory = useMemo(
    () =>
      listing.price_history.map((history) => ({
        id: `${history.evaluated_at}-${history.observed_at}-${history.price_minor}`,
        label: date(history.observed_at ?? history.evaluated_at),
        value:
          history.price_minor == null
            ? "Price not confirmed"
            : money(history.price_minor, history.currency ?? listing.currency ?? "GBP") +
              pricePeriod(history.price_period ?? listing.price_period),
      })),
    [listing.price_history, listing.currency, listing.price_period],
  );
  return (
    <DialogContent className="listing-detail">
      <DialogHeader>
        <DialogTitle>{listing.title}</DialogTitle>
        <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <MarketplaceBadge source={listing.source} />
          {sample && <span>Sample listing</span>}
          {listing.location && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              {listing.location}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5">
        <div className="listing-detail-overview">
          <ListingPhotos listing={listing} initialIndex={photoIndex} />
          <section className="listing-detail-summary" aria-label="Listing overview">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">
                {listing.product === "rental" ? "Rent" : "Price"}
              </p>
              <p
                className={
                  listing.price_minor == null
                    ? "text-xl font-semibold"
                    : "text-3xl font-semibold tracking-tight"
                }
              >
                {listing.price_minor == null
                  ? "Price not confirmed"
                  : money(listing.price_minor, listing.currency ?? "GBP")}
                <span className="text-sm font-normal">{pricePeriod(listing.price_period)}</span>
              </p>
              {extraPrice && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {money(listing.total_cash_cost_minor, listing.currency ?? "GBP")} including
                  delivery and fees
                </p>
              )}
            </div>
            <DetailFacts facts={facts} />
            <div className="space-y-3 border-t pt-4">
              <SellerDetails
                listing={listing}
                supportingSignals={decisions[0]?.credibility?.supporting_signals}
                compact
              />
              <SellerConversationChip summary={seller_conversation} />
            </div>
          </section>
        </div>
        {listing.description && (
          <section className="listing-detail-section" aria-label="Seller’s description">
            <h3 className="listing-detail-section-heading">Seller’s description</h3>
            <p className="whitespace-pre-line break-words text-sm leading-relaxed">
              {listing.description}
            </p>
          </section>
        )}
        {decisions.length > 0 && (
          <section className="listing-detail-section" aria-label="How it compares">
            <h3 className="listing-detail-section-heading">How it compares</h3>
            {decisions.map((decision) => (
              <DecisionChecks
                key={decision.search_id}
                decision={decision}
                search={searches.find((item) => item.id === decision.search_id)}
              />
            ))}
          </section>
        )}
        <div className="grid gap-3">
          <ListingExtraCosts listing={listing} />
          <ListingHistory listing={listing} decisions={decisions} />
          {priceHistory.length > 0 && (
            <Disclosure title="Price history">
              <DetailFacts facts={priceHistory} />
            </Disclosure>
          )}
          <Disclosure title="Saved evidence">
            <div className="space-y-3 break-words text-sm leading-relaxed">
              <p className="text-xs text-muted-foreground">Listing ID: {listing.listing_id}</p>
              {listing.travel_source && (
                <p>
                  Journey: {listing.travel_source} · checked{" "}
                  <RelativeTime value={listing.travel_checked_at} />
                  {listing.journey_estimate?.precision === "town" &&
                    " · exact pickup and traffic may change this"}
                </p>
              )}
              {Object.entries(listing.evidence ?? {})
                .filter(([key]) => !key.startsWith("seller_last_active"))
                .map(([key, value]) => (
                  <p key={key}>
                    <strong>{key.replaceAll("_", " ")}: </strong>
                    {evidenceText(value)}
                  </p>
                ))}
              {decisions.map((decision) =>
                decision.peer_listing_ids?.length ? (
                  <p key={decision.search_id}>
                    Similar listing IDs for {decision.search_name}:{" "}
                    {decision.peer_listing_ids.join(", ")}
                  </p>
                ) : null,
              )}
              {decisions.map((decision) => (
                <Disclosure
                  key={decision.search_id}
                  title={<>Original checks for {decision.search_name}</>}
                >
                  <ul className="list-disc space-y-1 pl-4">
                    {decision.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </Disclosure>
              ))}
            </div>
          </Disclosure>
        </div>
      </DialogBody>
      {hasActions && (
        <DialogFooter>
          {!sample && <ListingLink url={listing.url}>Open listing</ListingLink>}
          {onNegotiate && (
            <Button size="sm" onClick={(event) => onNegotiate(event.currentTarget)}>
              <MessageCircle aria-hidden="true" />
              {seller_conversation ? seller_conversation.action_label : "Prepare message"}
            </Button>
          )}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

export function ListingCard({
  listing,
  decisions,
  sample,
  searches,
  seller_conversation,
  onNegotiate,
  state,
  action,
  busy = false,
  preferredWatchId,
  onDisregarded,
  onSeen,
}: {
  listing: Listing;
  decisions: Decision[];
  sample: boolean;
  searches: SavedSearch[];
  seller_conversation?: SellerConversationSummary | undefined;
  onNegotiate?: ((button: HTMLElement) => void) | undefined;
  state: GoodfindsState;
  action?: Action | undefined;
  busy?: boolean | undefined;
  preferredWatchId?: string | undefined;
  onDisregarded?: ((id: string) => void) | undefined;
  onSeen?: RecordSeen | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const hasConversation = Boolean(seller_conversation);
  const negotiate = onNegotiate;
  const primary =
    decisions.find((decision) => decision.status === "qualifies") ??
    decisions.find((decision) => decision.status === "needs_review") ??
    decisions[0];
  const discovery = firstDiscovery(listing.first_found_runs ?? [], preferredWatchId);
  const unseenIds = unseenSearchIds(listing, searches, preferredWatchId);
  const exposure = useListingExposure(listing.key, unseenIds, onSeen);
  const attributes = listing.attributes ?? {};
  const location =
    listing.location || (typeof attributes["area"] === "string" ? attributes["area"] : null);
  const condition =
    listing.condition === "unknown" ? null : listing.condition?.replaceAll("_", " ");
  const buyingAction = state.next_steps.find((item) => item.listing_key === listing.key);
  const availability =
    listing.check_outcome && listing.check_outcome !== "success"
      ? "Check availability"
      : listing.availability === "active"
        ? null
        : listing.availability?.replaceAll("_", " ") || "Availability not confirmed";
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <article ref={exposure} className="listing-card" aria-label={listing.title}>
          <ListingThumbnail
            listing={listing}
            index={photoIndex}
            onIndexChange={setPhotoIndex}
            onOpen={() => setOpen(true)}
          />
          <div className="flex min-w-0 flex-col gap-3">
            <div className="listing-card-heading">
              <div className="min-w-0">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span>{primary?.search_name ?? "Saved listing"}</span>
                  <MarketplaceBadge source={listing.source} />
                  {(discovery || listing.first_observed_at) && (
                    <span className="text-muted-foreground">
                      Found{" "}
                      <RelativeTime
                        value={
                          discovery?.recorded_at ??
                          discovery?.run_started_at ??
                          listing.first_observed_at
                        }
                      />
                    </span>
                  )}
                  {unseenIds.length > 0 && (
                    <span className="inline-flex items-center gap-1 font-medium">
                      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
                      New
                    </span>
                  )}
                </div>
                <h2>
                  <DialogTrigger
                    type="button"
                    className="line-clamp-2 text-left text-lg leading-snug font-semibold outline-none hover:underline focus-visible:underline"
                    aria-label={`See details for ${listing.title}`}
                  >
                    {listing.title}
                  </DialogTrigger>
                </h2>
              </div>
              <p className="listing-card-price text-2xl leading-tight font-semibold tracking-tight @lg:text-3xl">
                {listing.price_minor == null
                  ? "Price not confirmed"
                  : money(listing.price_minor, listing.currency ?? "GBP")}
                <span className="block text-xs font-normal tracking-normal">
                  {pricePeriod(listing.price_period)}
                </span>
              </p>
            </div>
            <p className="text-sm">{listingFacts(listing).join(" · ")}</p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {location}
                </span>
              )}
              {listing.drive_minutes != null && (
                <span className="inline-flex items-center gap-1">
                  <Route className="size-3.5" aria-hidden="true" />
                  {listing.journey_estimate?.precision === "town" ||
                  listing["location_precision"] === "approximate"
                    ? "About "
                    : ""}
                  {listing.drive_minutes} min drive
                </span>
              )}
              {[condition, availability].filter(Boolean).map((detail) => (
                <span key={detail} className="capitalize">
                  {detail}
                </span>
              ))}
            </p>
            {primary && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <DecisionBadge
                  decision={primary}
                  search={searches.find((search) => search.id === primary.search_id)}
                />
                {primary.status === "qualifies" && primary.reference_average_minor != null && (
                  <span>
                    Average {money(primary.reference_average_minor, listing.currency ?? "GBP")}
                    {pricePeriod(listing.price_period)}
                  </span>
                )}
              </div>
            )}
            <SellerConversationChip summary={seller_conversation} />
            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <div className="min-w-0 basis-52 grow">
                <SellerDetails
                  listing={listing}
                  supportingSignals={primary?.credibility?.supporting_signals}
                  compact
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
                {action && (
                  <ListingDisregard
                    listing={listing}
                    state={state}
                    busy={busy}
                    action={action}
                    preferredWatchId={preferredWatchId}
                    onDisregarded={onDisregarded}
                  />
                )}
                {!sample && <ListingLink url={listing.url}>Open listing</ListingLink>}
                {negotiate && (
                  <Button size="sm" onClick={(event) => negotiate(event.currentTarget)}>
                    <MessageCircle aria-hidden="true" />
                    {hasConversation
                      ? seller_conversation?.action_label
                      : buyingAction
                        ? "Review message"
                        : "Prepare message"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </article>
        {open && (
          <ListingDetail
            listing={listing}
            decisions={decisions}
            sample={sample}
            photoIndex={photoIndex}
            searches={searches}
            seller_conversation={seller_conversation}
            onNegotiate={negotiate}
          />
        )}
      </Dialog>
    </>
  );
}
