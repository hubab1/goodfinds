import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RelativeTime } from "@/relative-time";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Decision, Listing, MarketHistory, SavedSearch } from "@goodfinds/contracts/state";
import { date, money, pricePeriod, sourceName } from "@/lib/presentation";
import {
  clusterPoints,
  targetPrice,
  trendGroups,
  trendLayout,
  trendSpecifications,
  trendWindow,
} from "@/lib/listing-trends";
import type { TrendPoint, TrendStatus } from "@/lib/listing-trends";
import { ListingDetail } from "@/features/listings/listing-card";
import "@/features/listings/listing-trends.css";

const EMPTY_DECISIONS: Decision[] = [];

function Marker({ status, count = 1 }: { status: TrendStatus; count?: number }) {
  return (
    <svg viewBox="0 0 26 26" className={"trend-marker trend-marker-" + status} aria-hidden="true">
      {status === "uncertain" ? (
        <path d="M13 3 23 13 13 23 3 13Z" />
      ) : (
        <circle cx="13" cy="13" r={count > 1 ? 11 : 7} />
      )}
      {count > 1 && (
        <text x="13" y="17" textAnchor="middle">
          {count}
        </text>
      )}
    </svg>
  );
}

function statusLabel(point: TrendPoint): string {
  return point.status === "active"
    ? "Available"
    : point.status === "uncertain"
      ? "Needs a fresh check"
      : (point.listing.availability ?? "unavailable").replaceAll("_", " ");
}

function PointDetails({
  point,
  currency,
  period,
  decisions,
  search,
}: {
  point: TrendPoint;
  currency: string;
  period: string;
  decisions: Decision[];
  search: SavedSearch;
}) {
  const listing = point.listing;
  const flags = new Set(
    [
      ...(listing.quality?.flags ?? []),
      ...decisions.flatMap((decision) => decision.quality?.flags ?? []),
    ].map((flag) => flag.message),
  );
  return (
    <div className="space-y-2">
      <p className="font-semibold text-sm">{listing.title}</p>
      <p>{trendSpecifications(listing, search)}</p>
      <p>
        {sourceName(listing.source)}
        {listing.location ? " · " + listing.location : ""}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Price at this point</dt>
        <dd className="font-medium">
          {money(point.price, currency)}
          {pricePeriod(period)}
        </dd>
        <dt>Price recorded</dt>
        <dd>{date(new Date(point.at).toISOString())}</dd>
        <dt>Latest asking price</dt>
        <dd>
          {listing.currency === currency &&
          (listing.price_period ?? "once") === period &&
          ["asking", "cash"].includes(listing.price_kind ?? "asking")
            ? money(listing.price_minor, currency) + pricePeriod(period)
            : "Not confirmed"}
        </dd>
        <dt>First found</dt>
        <dd>
          <RelativeTime value={listing.first_observed_at} />
        </dd>
        <dt>Last checked</dt>
        <dd>
          <RelativeTime value={listing.last_successful_at} />
        </dd>
        <dt>Availability</dt>
        <dd className="capitalize">{statusLabel(point)}</dd>
      </dl>
      {flags.size > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {Array.from(flags).map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
      )}
      <p className="border-t pt-2">Select this dot to open the listing.</p>
    </div>
  );
}

export function ListingTrends({
  search,
  history,
  listings,
  decisions,
  searches,
  now,
  sample,
}: {
  search: SavedSearch;
  history: MarketHistory[];
  listings: Listing[];
  decisions: Decision[];
  searches: SavedSearch[];
  now: number;
  sample: boolean;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [groupId, setGroupId] = useState("");
  const [mode, setMode] = useState("initial");
  const [windowDays, setWindowDays] = useState("all");
  const [selected, setSelected] = useState<Listing | null>(null);
  const [clusterSelection, setClusterSelection] = useState<TrendPoint[]>([]);
  const groups = useMemo(
    () => trendGroups(listings, history, search, now),
    [listings, history, search, now],
  );
  const group = groups.find((item) => item.id === groupId) ?? groups[0];
  const target = targetPrice(search);
  const days = windowDays === "all" ? null : Number(windowDays);
  const points = trendWindow(
    (mode === "initial" ? group?.initial : group?.history) ?? [],
    now,
    days,
  );
  const layout = trendLayout(points, target, now, days, width);
  const clusters = clusterPoints(points, layout);
  const currency = group?.currency ?? search.definition.price.currency;
  const period = group?.period ?? search.definition.price.period;
  const byListing = useMemo(() => {
    const grouped = new Map<string, Decision[]>();
    for (const decision of decisions) {
      if (decision.search_id !== search.id) continue;
      const matches = grouped.get(decision.listing.key) ?? [];
      matches.push(decision);
      grouped.set(decision.listing.key, matches);
    }
    return grouped;
  }, [decisions, search.id]);
  const series = new Map<string, TrendPoint[]>();
  if (mode === "history")
    for (const point of points) {
      const trace = series.get(point.series) ?? [];
      trace.push(point);
      series.set(point.series, trace);
    }
  useEffect(() => {
    const element = container.current;
    if (!element) return () => undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const tickDate = (at: number) =>
    new Date(at).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      ...(layout.end - layout.start <= 2 * 86_400_000
        ? ({ hour: "2-digit", minute: "2-digit" } as const)
        : {}),
    });
  const clearSelection = () => setClusterSelection([]);
  return (
    <section
      className="listing-trends rounded-xl border bg-card p-4 @md:p-5"
      aria-labelledby={id + "-heading"}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id={id + "-heading"} className="text-lg font-semibold">
            Price over time
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {mode === "initial"
              ? "One dot per distinct item at its first recorded full asking price."
              : "Recorded price changes. Each line follows one listing."}
          </p>
        </div>
        {target !== null && (
          <p className="text-sm font-medium">
            Your maximum: {money(target, currency)}
            {pricePeriod(period)}
          </p>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        {groups.length > 1 && (
          <label
            className="min-w-0 basis-full space-y-1 text-xs @2xl:basis-0 @2xl:flex-1"
            htmlFor={id + "-group"}
          >
            <span>Compare the same specifications</span>
            <NativeSelect
              id={id + "-group"}
              value={group?.id ?? ""}
              className="w-full"
              onChange={(event) => {
                setGroupId(event.currentTarget.value);
                clearSelection();
              }}
            >
              {groups.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label} · {item.initial.length}{" "}
                  {item.initial.length === 1 ? "item" : "items"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
        <label className="space-y-1 text-xs" htmlFor={id + "-view"}>
          <span>View</span>
          <NativeSelect
            id={id + "-view"}
            className="block"
            value={mode}
            onChange={(event) => {
              setMode(event.currentTarget.value);
              clearSelection();
            }}
          >
            <NativeSelectOption value="initial">First asking prices</NativeSelectOption>
            <NativeSelectOption value="history">Price changes</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="space-y-1 text-xs" htmlFor={id + "-window"}>
          <span>Period</span>
          <NativeSelect
            id={id + "-window"}
            className="block"
            value={windowDays}
            onChange={(event) => {
              setWindowDays(event.currentTarget.value);
              clearSelection();
            }}
          >
            <NativeSelectOption value="all">All recorded dates</NativeSelectOption>
            <NativeSelectOption value="7">Last 7 days</NativeSelectOption>
            <NativeSelectOption value="30">Last 30 days</NativeSelectOption>
            <NativeSelectOption value="90">Last 90 days</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>
      {groups.length === 1 && (
        <p className="mt-3 text-xs text-muted-foreground">{group?.label.replace(/^1\. /u, "")}</p>
      )}
      <div className="trend-chart mt-3" ref={container}>
        <svg
          width="100%"
          height="302"
          viewBox={"0 0 " + width + " 302"}
          aria-label={
            "Full asking prices over time" +
            (target !== null ? ". Maximum-price line at " + money(target, currency) : "")
          }
        >
          <text x={layout.left} y="17" className="trend-axis-title">
            {period === "once" ? "Full asking price" : "Asking price per " + period}
          </text>
          {layout.priceTicks.map((price) => (
            <g key={price}>
              <line
                x1={layout.left}
                x2={layout.right}
                y1={layout.y(price)}
                y2={layout.y(price)}
                className="trend-grid"
              />
              <text
                x={layout.left - 10}
                y={layout.y(price) + 4}
                textAnchor="end"
                className="trend-tick"
              >
                {money(Math.round(price / 100) * 100, currency)}
              </text>
            </g>
          ))}
          {layout.dateTicks.map((at, index) => (
            <text
              key={at}
              x={layout.x(at)}
              y={281}
              textAnchor={
                index === 0 ? "start" : index === layout.dateTicks.length - 1 ? "end" : "middle"
              }
              className="trend-tick"
            >
              <tspan x={layout.x(at)}>
                {new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
              </tspan>
              {layout.end - layout.start <= 2 * 86_400_000 && (
                <tspan x={layout.x(at)} dy="14">
                  {new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </tspan>
              )}
            </text>
          ))}
          {Array.from(
            series,
            ([key, trace]) =>
              trace.length > 1 && (
                <polyline
                  key={key}
                  points={trace
                    .map((point) => layout.x(point.at) + "," + layout.y(point.price))
                    .join(" ")}
                  className="trend-trace"
                />
              ),
          )}
          {target !== null && (
            <g className="trend-target" data-target-price={target}>
              <line
                x1={layout.left}
                x2={layout.right}
                y1={layout.y(target)}
                y2={layout.y(target)}
              />
              <rect
                x={layout.left}
                y={layout.y(target) - 21}
                width={Math.min(width - layout.left - 20, 220)}
                height="18"
              />
              <text x={layout.left + 4} y={layout.y(target) - 8}>
                Your maximum · {money(target, currency)}
                {pricePeriod(period)}
              </text>
            </g>
          )}
        </svg>
        <TooltipProvider delay={100}>
          {clusters.map((cluster) => {
            const point = cluster.points[0];
            if (!point) return null;
            const count = cluster.points.length;
            const status = cluster.points.every((item) => item.status === point.status)
              ? point.status
              : "uncertain";
            return (
              <Tooltip key={point.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="trend-point"
                      style={{ left: cluster.x, top: cluster.y }}
                      aria-label={
                        count === 1
                          ? point.listing.title +
                            ", " +
                            money(point.price, currency) +
                            ", " +
                            statusLabel(point) +
                            ", " +
                            tickDate(point.at)
                          : String(count) +
                            " overlapping price observations. Select to choose a listing."
                      }
                      onClick={() => {
                        if (count === 1) setSelected(point.listing);
                        else setClusterSelection(cluster.points);
                      }}
                    />
                  }
                >
                  <Marker status={status} count={count} />
                </TooltipTrigger>
                <TooltipContent>
                  {count === 1 ? (
                    <PointDetails
                      point={point}
                      currency={currency}
                      period={period}
                      decisions={byListing.get(point.listing.key) ?? EMPTY_DECISIONS}
                      search={search}
                    />
                  ) : (
                    <div className="space-y-2">
                      <p className="font-semibold">{count} price observations close together</p>
                      <ul className="space-y-2">
                        {cluster.points.slice(0, 6).map((item) => (
                          <li key={item.id}>
                            {item.listing.title} · {money(item.price, currency)} ·{" "}
                            {tickDate(item.at)}
                          </li>
                        ))}
                      </ul>
                      <p>
                        Select to choose a listing{count > 6 ? " and see all observations" : ""}.
                      </p>
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
        {points.length === 0 && (
          <p className="trend-empty text-sm">
            {group
              ? "No recorded full asking prices in this period."
              : "Comparable listing evidence will appear here after a search."}
          </p>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"
        aria-label="Chart legend"
      >
        <span className="trend-legend">
          <Marker status="active" />
          Available
        </span>
        <span className="trend-legend">
          <Marker status="unavailable" />
          Unavailable
        </span>
        <span className="trend-legend">
          <Marker status="uncertain" />
          Needs a fresh check
        </span>
        {target !== null && (
          <span className="trend-legend">
            <span className="trend-legend-line" />
            Your maximum
          </span>
        )}
      </div>
      {clusterSelection.length > 0 && (
        <div
          className="mt-4 space-y-3 rounded-lg border p-3"
          aria-label="Overlapping price observations"
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Choose a listing</p>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Close
            </Button>
          </div>
          {clusterSelection.map((point) => (
            <button
              type="button"
              key={point.id}
              className="flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left text-xs hover:bg-muted focus-visible:outline-2"
              onClick={() => setSelected(point.listing)}
            >
              <span>
                {point.listing.title}
                <span className="block text-muted-foreground">
                  {sourceName(point.listing.source)} · {date(new Date(point.at).toISOString())} ·{" "}
                  {statusLabel(point)}
                </span>
              </span>
              <span>{money(point.price, currency)}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {points.length} plotted {points.length === 1 ? "price" : "prices"}
        {group?.unpricedCount
          ? " · " +
            group.unpricedCount +
            (group.unpricedCount === 1 ? " item" : " items") +
            " without a confirmed full price"
          : ""}
        . Hover or focus a dot for details; select it to open the listing. Dates show when Goodfinds
        recorded a price. Markers show the latest recorded availability. Unavailable listings retain
        their asking prices; the final sale price is unknown.
        {mode === "history" &&
          " Lines connect recorded prices; changes may have happened between checks."}
      </p>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <ListingDetail
            listing={selected}
            decisions={byListing.get(selected.key) ?? EMPTY_DECISIONS}
            sample={sample}
            searches={searches}
            photoIndex={0}
          />
        )}
      </Dialog>
    </section>
  );
}
