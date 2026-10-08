import { learnedCriteria } from "../searches/learning.ts";
import { setupCostTotal, verificationChecks } from "@goodfinds/contracts/verification";
import { z } from "zod";
import {
  DAY,
  canonical,
  workspaceConfigurationSchema,
  credibilityDefaults,
  fresh,
  hash,
  median,
  qualityDefaults,
  record,
  round,
  time,
  TERMINAL,
  withDefaults,
} from "../workspace/model.ts";
import type { WorkspaceConfiguration, ListingObservation } from "../workspace/model.ts";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { isVisible, draftInputSchema } from "@goodfinds/contracts/search-definition";
import { journeyFresh, journeyLifetime } from "@goodfinds/contracts/journeys";
import { normalizeSearch, criteria, searchCohort, hasEvidence } from "../searches/definition.ts";
import * as tracking from "./tracking.ts";
import { Effect } from "effect";
import { validation, ValidationError } from "../workspace/errors.ts";

export const validateConfiguration = Effect.fnUntraced(function* (input: unknown) {
  const source = yield* validation(() => {
    if (!record(input) || !Array.isArray(input["searches"]))
      throw new Error("Configuration needs a searches array");
    for (const search of input["searches"]) {
      if (!record(search)) throw new Error("Search must be an object");
      z.string()
        .regex(/^[a-z0-9-]+$/u)
        .parse(search["id"]);
    }
    return { value: structuredClone(input), searches: input["searches"] as unknown[] };
  });
  const searches = yield* Effect.forEach(source.searches, (search) => normalizeSearch(search));
  return yield* validation(() => {
    source.value["searches"] = searches;
    const config = workspaceConfigurationSchema.parse(source.value);
    // Preserve source definitions and rule hashes without inserting schema defaults.
    config.searches = searches;
    if (new Set(config.searches.map((search) => search.id)).size !== config.searches.length)
      throw new Error("Saved search IDs must be unique");
    if (new Set(config.drafts.map((draft) => draft.id)).size !== config.drafts.length)
      throw new Error("Draft IDs must be unique");
    for (const draft of config.drafts) draftInputSchema.parse(draft);
    return config;
  });
});
export const normalizeObservations = Effect.fnUntraced(function* (
  input: unknown,
  demo: boolean,
  now: number,
) {
  const rows = yield* validation(() => z.array(z.unknown()).parse(input));
  const normalized = new Map<string, ListingObservation>();
  for (const inputRow of rows) {
    const row = yield* tracking.normalize(inputRow, demo, now);
    const previous = normalized.get(row.key);
    if (previous && canonical(previous) !== canonical(row))
      return yield* Effect.fail(
        new ValidationError({
          message: "Conflicting duplicate observation for " + row.listing_id,
        }),
      );
    normalized.set(row.key, row);
  }
  return Array.from(normalized.values());
});
export function matchListing(
  row: ListingObservation,
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  demo: boolean,
  budget = true,
): [string, string[]] {
  if (row.product !== search.product) return ["not_matching", ["Different search category"]];
  const [rejected, uncertain] = criteria(row, search, budget, now);
  const [learnedRejected, learnedUncertain] = learnedCriteria(row, search, config, budget);
  rejected.push(...learnedRejected);
  uncertain.push(...learnedUncertain);
  if (budget && !demo && !row.image_review?.complete)
    uncertain.push("Every listing image needs inspection");
  if (
    budget &&
    !demo &&
    ((row.videos?.length ?? 0) > 0 ||
      (row.video_review?.total_videos ?? 0) > 0 ||
      (row.media_capture?.expected_videos ?? 0) > 0) &&
    !row.video_review?.complete
  )
    uncertain.push("Every listing video needs inspection");
  if (budget && row.collection_stage === "discovery")
    uncertain.push("Provisional discovery needs verification");
  if (
    budget &&
    verificationChecks(row, search.discovery?.verification_checks).some(
      (check) => check.state !== "confirmed",
    )
  ) {
    // A supplied checklist makes its unresolved checks part of the qualification rules.
    if (row.verification_checks?.length || search.discovery?.verification_checks?.length)
      uncertain.push("Condition or included accessories need seller confirmation");
  }
  if (budget && row.setup_costs?.length && setupCostTotal(row).basis !== "observed")
    uncertain.push("Complete setup cost needs verification");
  if (TERMINAL.has(row.availability ?? "") || row.availability === "reserved")
    rejected.push("Listing is unavailable");
  else if (row.availability !== "active") uncertain.push("Availability is unknown");
  if (row.price_kind !== "asking")
    rejected.push("A full purchase price is required; finance payments are ignored");
  if (!row.price_minor) uncertain.push("Full asking price needs verification");
  if (row.currency !== search.definition.price.currency) rejected.push("Different currency");
  if ((row.price_period ?? "once") !== search.definition.price.period)
    uncertain.push("Price period needs verification or normalization");
  if (["macbook_pro", "mac_mini"].includes(search.product)) {
    if (row.functional === false) rejected.push("Item is not working");
    else if (row.functional !== true || !hasEvidence(row, "functional"))
      uncertain.push("Working condition needs verification");
    if (!["new", "used", "refurbished"].includes(row.item_state ?? ""))
      uncertain.push("New/used state is unknown");
    if (
      search.product === "macbook_pro" &&
      (![14, 16].includes(row.screen_inches ?? 0) || !hasEvidence(row, "screen_inches"))
    )
      uncertain.push("Laptop screen size needs verification");
  }
  const driving = search.definition.fields.some(
    (field) =>
      field.match?.attribute === "drive_minutes" &&
      (field.match.importance ?? "required") === "required" &&
      search.values[field.id] != null &&
      isVisible(field, search.values, search.definition),
  );
  if (driving) {
    if (!demo && config.origin_confirmed !== true)
      uncertain.push("Travel origin needs confirmation");
    if (row.drive_minutes == null || row.drive_origin !== config.origin)
      uncertain.push("Driving time from the configured origin is unknown");
    try {
      const age = now - time(row.travel_checked_at);
      if (
        age < 0 ||
        age > (row.journey_estimate ? journeyLifetime(row.journey_estimate.estimate_kind) : DAY) ||
        (row.journey_estimate && !journeyFresh(row.journey_estimate, config, row, now))
      )
        uncertain.push("Journey estimate needs a fresh check");
    } catch {
      uncertain.push("Journey check time is unknown");
    }
    if (
      config.location?.latitude != null &&
      (row.drive_latitude !== config.location.latitude ||
        row.drive_longitude !== config.location.longitude)
    )
      uncertain.push("Journey origin coordinates need a fresh check");
    if (!row.travel_source) uncertain.push("Journey source is unknown");
    if (
      row.journey_estimate?.precision === "town" &&
      row.drive_minutes != null &&
      search.definition.fields.some(
        (field) =>
          field.match?.attribute === "drive_minutes" &&
          field.match.operator === "lte" &&
          typeof search.values[field.id] === "number" &&
          Math.abs(Number(search.values[field.id]) - Number(row.drive_minutes)) <= 10,
      )
    )
      uncertain.push(
        "Town-level journey is close to your limit; confirm the pickup area before committing",
      );
  }
  if (searchCohort(row, search) === null) uncertain.push("Comparison attributes need verification");
  const reasons = tracking.quality(row, config, now).eligibility["price_baseline"]?.reasons ?? [];
  uncertain.push(
    ...reasons.filter(
      (reason) =>
        !uncertain.includes(reason) &&
        ![
          "Listing is not confirmed active",
          "Full purchase price is unknown or unavailable",
        ].includes(reason),
    ),
  );
  return rejected.length
    ? ["not_matching", [...rejected, ...uncertain]]
    : uncertain.length
      ? ["needs_review", uncertain]
      : ["matched", []];
}
export function cohort(row: ListingObservation, search: SavedSearch): string | null {
  const base = searchCohort(row, search);
  return base === null
    ? null
    : canonical([
        base,
        row.currency,
        row.price_period ?? "once",
        row.bundle_type,
        row.seller_type,
        row.quantity ?? 1,
        row.condition,
        row.item_state,
        row.functional,
      ]);
}
export function historyCohort(row: ListingObservation, search: SavedSearch): string | null {
  if (row.product !== search.product) return null;
  const definition = {
    ...search.definition,
    fields: search.definition.fields.filter(
      (field) =>
        !["price_minor", "drive_minutes", "seller_listing_count"].includes(
          field.match?.attribute ?? "",
        ),
    ),
  };
  const [rejected, uncertain] = criteria(row, { ...search, definition }, false);
  if (
    rejected.length ||
    uncertain.length ||
    (["macbook_pro", "mac_mini"].includes(row.product) && row.functional !== true)
  )
    return null;
  return cohort(row, search);
}
export function credibilityCheck(
  row: ListingObservation,
  peers: ListingObservation[],
  config: WorkspaceConfiguration,
  now: number,
) {
  const policy = withDefaults(credibilityDefaults, config.credibility_policy);
  let recent: boolean | null = null;
  const joined = row.seller_account_joined_at,
    freshMetadata = fresh(row.seller_metadata_checked_at, now, 30);
  if (joined && row.evidence?.["seller_account_joined_at"] && freshMetadata) {
    const earliest = Date.parse(`${joined.length === 4 ? `${joined}-01-01` : joined}T00:00:00Z`),
      latest = Date.parse(`${joined.length === 4 ? `${joined}-12-31` : joined}T00:00:00Z`);
    const today = new Date(now),
      cutoff = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - policy.recent_account_months, 1),
      );
    const lastDay = new Date(
      Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
    ).getUTCDate();
    cutoff.setUTCDate(Math.min(today.getUTCDate(), lastDay));
    recent = earliest >= cutoff.getTime() ? true : latest < cutoff.getTime() ? false : null;
  }
  const hasImage =
    freshMetadata && row.evidence?.["seller_has_profile_image"]
      ? (row.seller_has_profile_image ?? null)
      : null;
  const friendCount =
    row.seller_public_profile_url &&
    row.evidence?.["seller_friend_count"] &&
    fresh(row.seller_profile_checked_at, now, 30)
      ? (row.seller_friend_count ?? null)
      : null;
  let established: boolean | null = null;
  const supporting: string[] = [];
  if (
    friendCount !== null &&
    ["exact", "lower_bound"].includes(row.seller_friend_count_precision ?? "") &&
    recent !== null
  ) {
    established = !recent && friendCount >= policy.established_account_minimum_friends;
    if (established)
      supporting.push(
        `Facebook account older than ${policy.recent_account_months} months with ${row.seller_friend_count_precision === "lower_bound" ? "at least " : ""}${friendCount} friends shown on the profile`,
      );
  }
  const result = {
    status: "insufficient_data",
    reasons: [] as string[],
    peer_count: peers.length,
    reference_median_minor: null as number | null,
    reference_stddev_minor: null as number | null,
    stddevs_below_median: null as number | null,
    price_is_outlier: null as boolean | null,
    seller_account_recent: recent,
    seller_has_profile_image: hasImage,
    seller_friend_count: friendCount,
    older_account_with_many_friends: established,
    supporting_signals: supporting,
    policy,
  };
  if (peers.length < policy.minimum_peer_listings) {
    result.reasons = ["Not enough equivalent listings for an unusual-price check"];
    return result;
  }
  const prices = peers.map((peer) => peer.price_minor ?? 0),
    center = median(prices) ?? 0,
    mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const spread = Math.sqrt(
    prices.reduce((sum, price) => sum + (price - mean) ** 2, 0) / (prices.length - 1),
  );
  result.reference_median_minor = center;
  result.reference_stddev_minor = round(spread, 2);
  if (spread > 0) {
    const score = (center - (row.price_minor ?? 0)) / spread;
    result.stddevs_below_median = round(score, 2);
    result.price_is_outlier = score >= policy.stddev_threshold;
  } else {
    result.price_is_outlier =
      (row.price_minor ?? 0) <= center * (1 - policy.zero_variance_discount_fraction);
    result.reasons.push(
      "Peer prices have no variation; a large price-gap check replaces the deviation calculation",
    );
  }
  const signals: string[] = [];
  if (recent === true) signals.push("Seller account joined recently");
  if (hasImage === false) signals.push("No custom seller profile image observed");
  if (result.price_is_outlier && signals.length) {
    result.status = "review";
    result.reasons = [
      "Price is unusually low among equivalent listings",
      ...signals,
      ...result.reasons,
    ];
  } else {
    result.status = "no_combined_flag";
    if (result.price_is_outlier)
      result.reasons.push("Price is unusually low; seller signals do not establish credibility");
  }
  return result;
}
export function comparisonPool(
  rows: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  demo: boolean,
): ListingObservation[] {
  const pool = tracking.distinct(
    rows.filter((row) => matchListing(row, search, config, now, demo, false)[0] === "matched"),
  );
  const groups = peerGroups(pool, search);
  return pool.filter(
    (row) =>
      credibilityCheck(
        row,
        (groups.get(cohort(row, search) ?? "") ?? []).filter(
          (peer) => (peer.entity_key ?? peer.key) !== (row.entity_key ?? row.key),
        ),
        config,
        now,
      ).status !== "review",
  );
}
const peerIndexes = new WeakMap<
  ListingObservation[],
  { search: SavedSearch; groups: Map<string, ListingObservation[]> }
>();
function peerGroups(
  pool: ListingObservation[],
  search: SavedSearch,
): Map<string, ListingObservation[]> {
  const cached = peerIndexes.get(pool);
  if (cached?.search === search) return cached.groups;
  const groups = new Map<string, ListingObservation[]>();
  for (const row of pool) {
    const key = cohort(row, search);
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  peerIndexes.set(pool, { search, groups });
  return groups;
}
export interface Evaluation {
  suitability: "suitable" | "possible" | "unsuitable";
  verification: "complete" | "needs_check";
  value: "below_average" | "at_or_above_average" | "unknown";
  setup_total_minor: number | null;
  setup_cost_basis: "observed" | "estimate" | "unknown";
  listing: ListingObservation;
  status: string;
  reasons: string[];
  quality: ReturnType<typeof tracking.quality>;
  preferences: string[];
  preference_score?: number;
  credibility: ReturnType<typeof credibilityCheck>;
  peer_count?: number;
  reference_average_minor?: number;
  reference_median_minor?: number | null;
  peer_listing_ids?: string[];
  percent_below_average?: number;
}
// Prices remain integer minor units. Rational, ties-to-even rounding matches the former Decimal calculations.
export function rationalRound(numerator: bigint, denominator: bigint, digits: number): number {
  const scale = 10n ** BigInt(digits),
    negative = numerator < 0n,
    scaled = (negative ? -numerator : numerator) * scale;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n))
    quotient++;
  return Number(negative ? -quotient : quotient) / Number(scale);
}
export function evaluateListing(
  row: ListingObservation,
  pool: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  demo = false,
): Evaluation {
  const [status, reasons] = matchListing(row, search, config, now, demo);
  const peers =
    cohort(row, search) === null
      ? []
      : (peerGroups(pool, search).get(cohort(row, search) ?? "") ?? []).filter(
          (peer) => (peer.entity_key ?? peer.key) !== (row.entity_key ?? row.key),
        );
  const [requiredRejected, requiredUnknown] = criteria(row, search, true, now);
  const [learnedRejected, learnedUnknown, preferenceScore] = learnedCriteria(
    row,
    search,
    config,
    true,
  );
  const purchase = setupCostTotal(row);
  const decision: Evaluation = {
    suitability:
      status === "not_matching" || requiredRejected.length || learnedRejected.length
        ? "unsuitable"
        : requiredUnknown.length || learnedUnknown.length
          ? "possible"
          : "suitable",
    verification: status === "matched" ? "complete" : "needs_check",
    value: "unknown",
    setup_total_minor: purchase.total_minor,
    setup_cost_basis: purchase.basis,
    listing: row,
    status,
    reasons,
    quality: tracking.quality(row, config, now, peers),
    preferences: criteria(row, search, true, now)[2],
    ...(preferenceScore ? { preference_score: preferenceScore } : {}),
    credibility: credibilityCheck(row, peers, config, now),
  };
  const block = (why: string[]): void => {
    for (const metric of ["price_baseline", "deal_alert"])
      decision.quality.eligibility[metric] = { eligible: false, reasons: why };
  };
  if (status !== "matched") {
    block(reasons);
    return decision;
  }
  if (decision.credibility.status === "review") {
    block(decision.credibility.reasons);
    return { ...decision, status: "needs_review", reasons: decision.credibility.reasons };
  }
  decision.peer_count = peers.length;
  if (peers.length < config.minimum_peer_listings)
    return {
      ...decision,
      status: "insufficient_comparables",
      reasons: ["Too few equivalent listings to estimate an average"],
    };
  const sum = peers.reduce((total, peer) => total + BigInt(peer.price_minor ?? 0), 0n),
    count = BigInt(peers.length),
    candidate = BigInt(row.price_minor ?? 0);
  decision.reference_average_minor = rationalRound(sum, count, 2);
  decision.reference_median_minor = median(peers.map((peer) => peer.price_minor ?? 0));
  decision.peer_listing_ids = peers.map((peer) => peer.listing_id);
  if (candidate * count < sum)
    return {
      ...decision,
      value: "below_average",
      status: "qualifies",
      percent_below_average: rationalRound((sum - candidate * count) * 100n, sum, 1),
      reasons: ["Within budget and below the average of equivalent asking prices"],
    };
  return {
    ...decision,
    value: "at_or_above_average",
    status: "not_deal",
    reasons: ["Price is at or above the average of equivalent asking prices"],
  };
}
export interface Alert extends Evaluation {
  id: string;
  search_id: string;
  search_name: string;
  kind: string;
  created_at: string;
  status: string;
  mode: string;
}
export interface EvaluationResult {
  evaluation_id: string;
  evaluated_at: string;
  mode: string;
  origin: string;
  observed_count: number;
  new_alerts: Alert[];
  pending_alerts: Alert[];
  searches: { search: SavedSearch; counts: Record<string, number>; decisions: Evaluation[] }[];
}
export function ruleHash(
  search: SavedSearch,
  config: WorkspaceConfiguration,
  source: unknown = search,
): string {
  const storedSearch = Object.fromEntries(
    Object.entries(record(source) ? source : search).filter(
      ([key]) => !["enabled", "cover"].includes(key),
    ),
  );
  const credibility = Object.fromEntries(
    Object.entries({ ...credibilityDefaults, ...config.credibility_policy }).filter(
      ([key]) => key !== "established_account_minimum_friends",
    ),
  );
  return hash({
    search: storedSearch,
    origin: config.origin,
    days: config.baseline_days,
    peers: config.minimum_peer_listings,
    policy: config.alert_policy,
    credibility,
    image_review_required: true,
    cash_price_only: true,
    quality_policy: { ...qualityDefaults, ...config.quality_policy },
  });
}
