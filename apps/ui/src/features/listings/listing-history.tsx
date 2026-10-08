import { useMemo } from "react";
import { Disclosure } from "@/components/ui/disclosure";
import type { Decision, Listing, MarketHistory } from "@goodfinds/contracts/state";
import { RelativeTime } from "@/relative-time";
import { date, money, pricePeriod } from "@/lib/presentation";
import { DetailFacts } from "@/components/ui/detail-facts";

function days(value: number): string {
  return `${Number(value.toFixed(1))} ${value === 1 ? "day" : "days"}`;
}

function stateLabel(value: string | null | undefined): string {
  if (!value || value === "unknown") return "Not confirmed";
  if (value === "active") return "Available";
  return value.replaceAll("_", " ");
}

const CHECK_LABELS: Record<string, string> = {
  success: "Checked",
  login_required: "Sign in needed",
  forbidden: "Marketplace access blocked",
  rate_limited: "Marketplace limit reached",
  network_error: "Connection problem",
  parser_error: "Details couldn’t be read",
  not_found: "Listing not found",
  not_inspected: "Not checked yet",
};

function checkLabel(value: string | null | undefined): string {
  return CHECK_LABELS[value ?? ""] ?? "Couldn’t check listing";
}

export function ListingHistory({
  listing,
  decisions,
}: {
  listing: Listing;
  decisions: Decision[];
}) {
  const flags = new Map<string, string>();
  for (const quality of [listing.quality, ...decisions.map((decision) => decision.quality)])
    for (const flag of quality?.flags ?? []) flags.set(flag.code, flag.message);
  const publication = listing.publication;
  const duration = listing.duration;
  const events = listing.events ?? [];
  const facts = useMemo(
    () => [
      {
        label: "Listed",
        value: (
          <>
            {publication?.raw_text || "Date not shown"}
            {publication?.earliest_at && (
              <span className="block text-xs">
                {date(publication.earliest_at)}
                {publication.latest_at !== publication.earliest_at
                  ? ` – ${date(publication.latest_at)}`
                  : ""}
              </span>
            )}
          </>
        ),
      },
      {
        label: "First found",
        value: <RelativeTime value={listing.first_observed_at} empty="Not recorded" />,
      },
      {
        label: "Last checked",
        value:
          listing.last_successful_at === null ? (
            "Not confirmed"
          ) : (
            <RelativeTime value={listing.last_successful_at ?? listing.last_observed_at} />
          ),
      },
      {
        label: "Availability",
        value: <span className="capitalize">{stateLabel(listing.availability)}</span>,
      },
    ],
    [publication, listing],
  );
  return (
    <Disclosure title="Listing history">
      <DetailFacts facts={facts} />
      {listing.check_outcome && listing.check_outcome !== "success" && (
        <p className="text-xs">
          Latest check: {checkLabel(listing.check_outcome)} ·{" "}
          <RelativeTime value={listing.last_attempted_at} />
        </p>
      )}
      {duration?.lower_days != null && (
        <p>
          {duration.unfinished ? (
            duration.lower_days < 1 ? (
              <>
                First found <RelativeTime value={listing.first_observed_at} />.
              </>
            ) : (
              `Seen available for at least ${days(duration.lower_days)}.`
            )
          ) : (
            `Seen available for ${days(duration.lower_days)} to ${days(duration.upper_days ?? duration.lower_days)}, then ${stateLabel(duration.outcome)}.`
          )}{" "}
          <span className="text-muted-foreground">
            Based on our checks. The seller may have listed it earlier.
          </span>
        </p>
      )}
      {flags.size > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {Array.from(flags, ([code, message]) => (
            <li key={code}>{message}</li>
          ))}
        </ul>
      )}
      {events.length > 0 && (
        <Disclosure title={<> Changes and checks ({events.length}) </>}>
          <ul className="mt-3 space-y-2">
            {events.map((event) => (
              <li key={JSON.stringify(event)}>
                <span className="font-medium">
                  {event.kind === "price_changed"
                    ? `Full asking price changed from ${money(event.previous_price_minor, event.currency ?? listing.currency ?? "GBP")} to ${money(event.price_minor, event.currency ?? listing.currency ?? "GBP")}`
                    : event.kind === "status_changed"
                      ? `${stateLabel(event.previous_state)} → ${stateLabel(event.state)}`
                      : event.kind === "check_failed"
                        ? checkLabel(event.outcome)
                        : stateLabel(event.kind)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {event.earliest_at ? (
                    `Between ${date(event.earliest_at)} and ${date(event.latest_at)}`
                  ) : (
                    <RelativeTime value={event.observed_at} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Disclosure>
  );
}

export function MarketSummary({
  history,
  listings,
}: {
  history: MarketHistory[];
  listings: Listing[];
}) {
  if (!history.length) return null;
  return (
    <Disclosure
      title={
        <>
          {" "}
          Market history · {history.length} equivalent{" "}
          {history.length === 1 ? "group" : "groups"}{" "}
        </>
      }
    >
      <p className="mt-3 text-xs text-muted-foreground">
        Observed asking prices and listing availability. Different configurations stay separate. A
        missing ad does not establish a sale.
      </p>
      <div className="mt-4 space-y-4">
        {history.map((group, index) => {
          const example = listings.find((listing) =>
            group.cohort_listing_keys.includes(listing.key),
          );
          return (
            <section
              key={group.cohort_listing_keys.join("-") || index}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="font-medium">{example?.title ?? `Group ${index + 1}`}</h3>
              <p>
                {group.distinct_count} distinct listings · {group.confirmed_active_count} confirmed
                active · {group.sold_count} marked sold · {group.unknown_outcome_count} unknown
                outcomes · {group.window_days}-day window
              </p>
              <p>
                {group.cash_price_sample_count
                  ? `Median full asking price ${money(group.median_cash_price_minor, group.currency ?? "GBP")}${pricePeriod(group.price_period)} across ${group.cash_price_sample_count} eligible listings.`
                  : "Full-price comparison needs eligible listings."}
              </p>
              <p>
                {group.arrivals_per_day != null
                  ? `${group.supported_arrivals} new listings across ${days(group.coverage_days)} of repeated search coverage · ${group.arrivals_per_day} per day.`
                  : "New-listing frequency needs repeated complete searches and original publication dates."}
                {group.median_arrival_gap_days != null
                  ? ` Median observed gap ${days(group.median_arrival_gap_days)}.`
                  : ""}
              </p>
              <p>
                {group.completed_period_count
                  ? `Completed observed active periods: median ${days(group.median_completed_lower_days ?? 0)} to ${days(group.median_completed_upper_days ?? 0)} across ${group.completed_period_count} periods; ${group.unfinished_period_count} still unfinished.`
                  : `${group.unfinished_period_count} observed active periods still unfinished; duration comparison needs known endings.`}
              </p>
              <p className="text-xs text-muted-foreground">
                Completed periods can end in a reservation, removal or sale. They do not establish
                typical time to sell. {group.note}
              </p>
            </section>
          );
        })}
      </div>
    </Disclosure>
  );
}
