import type { Listing, MarketHistory, SavedSearch } from "@goodfinds/contracts/state";
import { searchOfferPrice } from "@goodfinds/contracts/buying-next-steps";
import { storage } from "./presentation.ts";

const DAY = 86_400_000;
export type TrendStatus = "active" | "unavailable" | "uncertain";
export type TrendPoint = {
  id: string;
  series: string;
  listing: Listing;
  at: number;
  price: number;
  status: TrendStatus;
};
export type TrendGroup = {
  id: string;
  label: string;
  currency: string;
  period: string;
  initial: TrendPoint[];
  history: TrendPoint[];
  unpricedCount: number;
};

export function targetPrice(search: SavedSearch): number | null {
  return searchOfferPrice(search, false);
}

export function trendStatus(listing: Listing, now: number): TrendStatus {
  if (listing.check_outcome && listing.check_outcome !== "success") return "uncertain";
  if (
    [
      "sold",
      "removed",
      "expired",
      "ended_unsold",
      "out_of_stock",
      "reserved",
      "unknown_unavailable",
    ].includes(listing.availability ?? "")
  )
    return "unavailable";
  const checked = Date.parse(
    listing.last_successful_at ?? listing.observed_at ?? listing.last_observed_at ?? "",
  );
  return listing.availability === "active" &&
    Number.isFinite(checked) &&
    checked <= now &&
    (listing.quality?.eligibility["current_stock"]?.eligible ?? now - checked <= 3 * DAY)
    ? "active"
    : "uncertain";
}

function quotes(listing: Listing, currency: string, period: string, now: number): TrendPoint[] {
  const history = listing.price_history.length
    ? listing.price_history
    : [
        {
          observed_at:
            listing.observed_at ?? listing.last_successful_at ?? listing.last_observed_at ?? "",
          price_minor: ["asking", "cash"].includes(listing.price_kind ?? "asking")
            ? listing.price_minor
            : null,
          currency: listing.currency,
          price_period: listing.price_period ?? "once",
        },
      ];
  return history
    .flatMap((quote, index) => {
      const at = Date.parse(
        quote.observed_at ?? ("evaluated_at" in quote ? quote.evaluated_at : ""),
      );
      if (
        quote.price_minor == null ||
        !Number.isFinite(quote.price_minor) ||
        quote.price_minor <= 0 ||
        !Number.isFinite(at) ||
        at > now ||
        quote.currency !== currency ||
        (quote.price_period ?? "once") !== period
      )
        return [];
      return [
        {
          id: listing.key + ":" + index,
          series: listing.key,
          listing,
          at,
          price: quote.price_minor,
          status: trendStatus(listing, now),
        },
      ];
    })
    .toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function trendSpecifications(listing: Listing, search: SavedSearch): string {
  const values = search.definition.comparison_attributes.flatMap((key) => {
    const value = listing[key] ?? listing.attributes?.[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return [];
    if (key === "ram_gb") return [String(value) + " GB memory"];
    if (key === "ssd_gb" && typeof value === "number") return [storage(value) + " SSD"];
    if (key === "screen_inches") return [String(value) + " inch"];
    return [String(value).replaceAll("_", " ")];
  });
  const extras = [
    listing.condition,
    listing.item_state,
    listing["bundle_type"],
    listing["seller_type"],
  ];
  for (const value of extras)
    if (typeof value === "string" && value && value !== "unknown")
      values.push(value.replaceAll("_", " "));
  return Array.from(new Set(values)).join(" · ") || listing.title;
}

// Cohort membership comes from the evaluator, including over-budget and inactive
// listings. Platform-qualified keys prevent unrelated numeric IDs being merged.
export function trendGroups(
  listings: Listing[],
  cohorts: MarketHistory[],
  search: SavedSearch,
  now: number,
): TrendGroup[] {
  const byKey = new Map(listings.map((listing) => [listing.key, listing]));
  return cohorts.flatMap((cohort, index) => {
    const members = cohort.cohort_listing_keys.flatMap((key) => {
      const listing = byKey.get(key);
      return listing ? [listing] : [];
    });
    const first = members[0];
    if (!first) return [];
    const currency = cohort.currency ?? first.currency ?? "GBP";
    const period = cohort.price_period ?? "once";
    // A vehicle's monthly finance quotation never becomes a recurring price
    // series. Recurring periods belong to searches explicitly priced that way.
    if (currency !== search.definition.price.currency || period !== search.definition.price.period)
      return [];
    const entities = new Map<string, Listing[]>();
    for (const member of members) {
      const key = member.entity_key ?? member.key;
      const group = entities.get(key) ?? [];
      group.push(member);
      entities.set(key, group);
    }
    const initial: TrendPoint[] = [];
    const history: TrendPoint[] = [];
    for (const [entity, copies] of entities) {
      const latest = copies.toSorted(
        (a, b) =>
          Date.parse(b.last_attempted_at ?? b.observed_at ?? "") -
          Date.parse(a.last_attempted_at ?? a.observed_at ?? ""),
      )[0];
      const allQuotes = copies
        .flatMap((listing) => quotes(listing, currency, period, now))
        .toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const oldest = allQuotes[0];
      if (oldest && latest)
        initial.push({ ...oldest, id: entity, listing: latest, status: trendStatus(latest, now) });
      // Repeated listing_evaluations at the same price don't create more market observations.
      // Separate ads retain separate traces even when confirmed as cross-posts.
      for (const copy of copies) {
        const observed = quotes(copy, currency, period, now);
        history.push(
          ...observed.filter((point, i) => i === 0 || point.price !== observed[i - 1]?.price),
        );
      }
    }
    return [
      {
        id: cohort.cohort_listing_keys.join("|"),
        label: String(index + 1) + ". " + trendSpecifications(first, search),
        currency,
        period,
        initial: initial.toSorted((a, b) => a.at - b.at),
        history: history.toSorted((a, b) => a.at - b.at),
        unpricedCount: entities.size - initial.length,
      },
    ];
  });
}

export function trendWindow(points: TrendPoint[], now: number, days: number | null): TrendPoint[] {
  return points.filter(
    (point) => point.at <= now && (days === null || point.at >= now - days * DAY),
  );
}

export function trendLayout(
  points: TrendPoint[],
  target: number | null,
  now: number,
  days: number | null,
  width: number,
) {
  const left = width < 480 ? 60 : 76,
    right = width - 20,
    top = 48,
    bottom = 258;
  const start =
    days === null ? Math.min(now - DAY, ...points.map((point) => point.at)) : now - days * DAY;
  const end = now;
  const prices = points.map((point) => point.price);
  if (target !== null) prices.push(target);
  const minimum = prices.length ? Math.min(...prices) : 0;
  const maximum = prices.length ? Math.max(...prices) : 10000;
  const padding = Math.max((maximum - minimum) * 0.15, maximum * 0.06, 100);
  const roughStep = (maximum - minimum + 2 * padding) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = Math.max(
    1,
    ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= roughStep) ?? 10) * magnitude,
  );
  const low = Math.max(0, Math.floor((minimum - padding) / step) * step),
    high = Math.ceil((maximum + padding) / step) * step;
  return {
    left,
    right,
    top,
    bottom,
    start,
    end,
    low,
    high,
    x: (at: number) => left + ((at - start) / (end - start)) * (right - left),
    y: (price: number) => bottom - ((price - low) / (high - low)) * (bottom - top),
    priceTicks: Array.from(
      { length: Math.round((high - low) / step) + 1 },
      (_, i) => low + step * i,
    ),
    dateTicks: Array.from(
      { length: width < 480 ? 3 : 5 },
      (_, i) => start + ((end - start) * i) / (width < 480 ? 2 : 4),
    ),
  };
}

export function clusterPoints(points: TrendPoint[], layout: ReturnType<typeof trendLayout>) {
  const clusters: { x: number; y: number; points: TrendPoint[] }[] = [];
  for (const point of points) {
    const x = layout.x(point.at),
      y = layout.y(point.price);
    const existing = clusters.find((cluster) => Math.hypot(cluster.x - x, cluster.y - y) < 18);
    if (existing) existing.points.push(point);
    else clusters.push({ x, y, points: [point] });
  }
  return clusters;
}
