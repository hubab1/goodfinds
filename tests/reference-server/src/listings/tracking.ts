import { z } from "zod";
import {
  DAY,
  SOURCES,
  TERMINAL,
  qualityDefaults,
  canonical,
  hash,
  iso,
  median,
  record,
  round,
  listingObservationSchema,
  searchCoverageSchema,
  time,
  withDefaults,
} from "../workspace/model.ts";
import type {
  WorkspaceConfiguration,
  SearchCoverage,
  ListingObservation,
} from "../workspace/model.ts";
import type { SavedSearch } from "@goodfinds/contracts/state";
import { Clock, Effect } from "effect";
import { validation } from "../workspace/errors.ts";

export const FINANCE = [
  "finance_price_minor",
  "finance_monthly_minor",
  "monthly_payment_minor",
  "finance",
  "finance_terms",
];
export function sourceUrl(source: keyof typeof SOURCES, value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      SOURCES[source].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}
export const normalize = Effect.fnUntraced(function* (input: unknown, demo: boolean, now: number) {
  const currentTime = yield* Clock.currentTimeMillis;
  return yield* validation(() => normalizeValue(input, demo, now, currentTime));
});
export function normalizeSearchCoverage(input: unknown, now: number, searches: SavedSearch[]) {
  return validation(() => normalizeSearchCoverageValue(input, now, searches));
}
function normalizeValue(
  input: unknown,
  demo: boolean,
  now: number,
  currentTime: number,
): ListingObservation {
  if (!record(input)) throw new Error("Observation must be an object");
  const value = structuredClone(input);
  const source = listingObservationSchema.shape.source.parse(value["source"]);
  const id = z.string().trim().min(1).parse(value["listing_id"]);
  const url = new URL(z.string().parse(value["url"]));
  const path = url.pathname.replace(/\/+$/u, "");
  const patterns = {
    facebook_marketplace: /^\/marketplace\/item\/(\d+)$/u,
    ebay: /^\/itm\/(?:[^/]+\/)?(\d+)$/u,
    vinted: /^\/items\/(\d+)(?:-[^/]+)?$/u,
    gumtree: /^\/p\/(?:[^/]+\/)+(\d+)$/u,
    craigslist: /^\/(?:[^/]+\/)+(\d+)\.html$/u,
    autotrader: /^\/car-details\/(\d+)$/u,
  };
  const valid = demo
    ? url.protocol === "https:" &&
      url.hostname === "example.invalid" &&
      !url.username &&
      !url.password
    : /^\d+$/u.test(id) && sourceUrl(source, url.href) && patterns[source].exec(path)?.[1] === id;
  if (!valid)
    throw new Error(
      "Live item URL must match its source and listing ID; examples require example.invalid",
    );
  const prefix = demo ? "synthetic" : "manual";
  if (value["provenance"] !== prefix) throw new Error(`This run requires ${prefix} observations`);
  if (value["collection_method"] === "user_requested_browser" && !value["observed_at"])
    throw new Error("Browser observations need a timezone-aware observed_at");
  const observed = value["observed_at"] ? time(value["observed_at"]) : now;
  if (observed > now + 300000) throw new Error("Observation time cannot be in the future");
  value["key"] =
    source === "facebook_marketplace" ? `${prefix}:${id}` : `${prefix}:${source}:${id}`;
  value["url"] = `${url.origin}${path}${source === "facebook_marketplace" ? "/" : ""}`;
  value["title"] ??= `Listing ${id}`;
  value["product"] ??= "unknown";
  value["price_minor"] ??= null;
  value["observed_at"] = iso(observed);
  value["observation_time_precision"] = input["observed_at"] ? "recorded" : "import_time";
  value["check_outcome"] ??= "success";
  if (
    ![
      "success",
      "login_required",
      "forbidden",
      "rate_limited",
      "network_error",
      "parser_error",
      "not_found",
      "not_inspected",
    ].includes(String(value["check_outcome"]))
  )
    throw new Error("Unsupported listing check outcome");
  value["availability"] ||= "unknown";
  if (![...TERMINAL, "active", "reserved", "unknown"].includes(String(value["availability"])))
    throw new Error("Unsupported availability state");
  for (const name of [
    "availability_text",
    "discovery_surface",
    "country",
    "category_id",
    "category_path",
    "bundle_type",
    "seller_type",
    "seller_id",
    "location_precision",
    "publication_text",
    "publication_timezone",
    "publication_kind",
  ])
    if (value[name] != null) z.string().max(2000).parse(value[name]);
  const publication = value["publication"];
  if (record(publication)) {
    const left = publication["earliest_at"],
      right = publication["latest_at"],
      precision = publication["precision"];
    if (left || right) {
      if (
        !left ||
        !right ||
        !["exact", "bounded"].includes(String(precision)) ||
        !publication["evidence"]
      )
        throw new Error("Publication bounds need both timestamps and supporting evidence");
      const start = time(left),
        end = time(right);
      if (start > end || end > observed || (precision === "exact" && start !== end))
        throw new Error("Publication bounds conflict with their precision or observation time");
      publication["earliest_at"] = iso(start);
      publication["latest_at"] = iso(end);
    } else if (["exact", "bounded"].includes(String(precision)))
      throw new Error("Exact or bounded publication evidence needs timestamps");
  }
  if (value["cash_price_minor"] != null) {
    if (!record(value["evidence"]) || !value["evidence"]["cash_price_minor"])
      throw new Error("An explicit cash price needs integer minor units and cash-price evidence");
    value["price_minor"] = value["cash_price_minor"];
    value["price_kind"] = "asking";
    if (value["product"] !== "rental") value["price_period"] = "once";
  } else if (value["product"] !== "rental" && (value["price_period"] ?? "once") !== "once")
    value["price_kind"] = "finance";
  if (value["price_minor"] != null && value["price_kind"] == null)
    throw new Error(
      "A numeric price needs an explicit price_kind; use asking for a full outright price",
    );
  if (value["price_kind"] !== "asking") value["price_minor"] = null;
  if (value["price_minor"] == null) delete value["displayed_previous_price_minor"];
  for (const name of FINANCE) delete value[name];
  value["total_cash_cost_minor"] = null;
  if (value["costs_complete"] === true && value["price_minor"] != null) {
    const amounts = ["price_minor", "shipping_minor", "buyer_fee_minor", "tax_minor"].map((name) =>
      z.number().int().nonnegative().parse(value[name]),
    );
    value["total_cash_cost_minor"] = amounts.reduce((sum, amount) => sum + amount, 0);
  }
  for (const name of ["field_evidence", "logistics", "seller", "interest", "terms"])
    if (value[name] != null && !record(value[name])) throw new Error(`${name} must be an object`);
  // Validate without inserting UI defaults into persisted evidence.
  const row = listingObservationSchema.parse(value);
  for (const name of ["price_minor", "ram_gb", "ssd_gb", "drive_minutes"] as const)
    if (row[name] != null) z.number().int().nonnegative().parse(row[name]);
  if (row.currency != null)
    z.string()
      .regex(/^[A-Z]{3}$/u)
      .parse(row.currency);
  for (const metric of ["friend", "listing"] as const) {
    const count = row[`seller_${metric}_count`],
      precision = row[`seller_${metric}_count_precision`];
    if (count == null ? precision != null : precision == null)
      throw new Error(`${metric} count needs its precision; unknown counts need null precision`);
  }
  for (const name of [
    "seller_profile_checked_at",
    "seller_listings_checked_at",
    "seller_metadata_checked_at",
  ] as const)
    if (row[name] != null) time(row[name]);
  if (row.seller_account_joined_at) {
    const joined = row.seller_account_joined_at;
    if (!/^\d{4}(?:-\d{2}-\d{2})?$/u.test(joined))
      throw new Error("Seller join date must be YYYY or YYYY-MM-DD, preserving its precision");
    const date = new Date(`${joined.length === 4 ? `${joined}-01-01` : joined}T00:00:00Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== (joined.length === 4 ? `${joined}-01-01` : joined) ||
      date.getTime() > currentTime
    )
      throw new Error("Invalid seller join date");
  }
  const positions = (row.photos ?? []).map((photo) => photo.position);
  if (new Set(positions).size !== positions.length)
    throw new Error("Each photo needs a unique positive position");
  if (row.image_review) {
    const review = row.image_review,
      reviewed = review.reviewed_positions;
    if (
      new Set(reviewed).size !== reviewed.length ||
      reviewed.some((p) => p > review.total_images) ||
      positions.some((p) => p > review.total_images) ||
      (review.complete && reviewed.length !== review.total_images)
    )
      throw new Error("A complete image review must cover every image exactly once");
  }
  const videoPositions = (row.videos ?? []).map((video) => video.position);
  if (new Set(videoPositions).size !== videoPositions.length)
    throw new Error("Each video needs a unique positive position");
  if (row.video_review) {
    const review = row.video_review;
    if (
      new Set(review.reviewed_positions).size !== review.reviewed_positions.length ||
      review.reviewed_positions.some((p) => p > review.total_videos) ||
      videoPositions.some((p) => p > review.total_videos) ||
      (row.media_capture?.expected_videos != null &&
        review.total_videos !== row.media_capture.expected_videos) ||
      (review.complete && review.reviewed_positions.length !== review.total_videos)
    )
      throw new Error("A complete video review must cover every video exactly once");
  }
  if (
    row.media_capture?.status === "complete" &&
    (row.media_capture.expected_photos == null ||
      row.media_capture.expected_videos == null ||
      row.media_capture.expected_photos !== (row.photos ?? []).length ||
      row.media_capture.expected_videos !== (row.videos ?? []).length)
  )
    throw new Error(
      "Complete media capture needs the observed totals and every saved image and video",
    );
  if (row.attributes) {
    if (
      Object.keys(row.attributes).length > 60 ||
      Object.keys(row.attributes).some(
        (key) => !/^[a-z][a-z0-9_]{0,63}$/u.test(key) || ["constructor", "prototype"].includes(key),
      )
    )
      throw new Error("Listing attributes need bounded, typed values");
    if (
      Object.entries(row.attributes).some(
        ([key, item]) => row[key] != null && canonical(row[key]) !== canonical(item),
      )
    )
      throw new Error("Listing attributes conflict with top-level evidence");
  }
  for (const name of ["seller_profile_url", "seller_public_profile_url"] as const)
    if (row[name]) {
      const profile = new URL(row[name]);
      if (
        profile.protocol !== "https:" ||
        profile.username ||
        profile.password ||
        (demo ? profile.hostname !== "example.invalid" : !sourceUrl(source, profile.href))
      )
        throw new Error("Seller links must use the same permitted source");
    }
  if (row.seller_inventory_review) {
    const review = row.seller_inventory_review;
    if (review.source_url !== row.seller_profile_url || review.category !== row.product)
      throw new Error("Seller inventory review must use this seller profile and listing category");
    if (time(review.checked_at) > observed)
      throw new Error("Seller inventory review cannot be later than the listing observation");
    const ids = new Set<string>();
    for (const item of review.listings) {
      const itemUrl = new URL(item.url);
      const itemPath = itemUrl.pathname.replace(/\/+$/u, "");
      if (ids.has(item.listing_id))
        throw new Error("Seller inventory items must have distinct listing IDs");
      ids.add(item.listing_id);
      if (
        demo
          ? itemUrl.protocol !== "https:" ||
            itemUrl.hostname !== "example.invalid" ||
            Boolean(itemUrl.username || itemUrl.password)
          : !sourceUrl(source, item.url) || patterns[source].exec(itemPath)?.[1] !== item.listing_id
      )
        throw new Error(
          "Seller inventory items must use canonical item links from the same source",
        );
      item.url = `${itemUrl.origin}${itemPath}${source === "facebook_marketplace" ? "/" : ""}`;
    }
    if (
      row.seller_listing_count_precision === "exact" &&
      row.seller_listing_count != null &&
      ids.size > row.seller_listing_count
    )
      throw new Error(
        "The inspected inventory cannot exceed the seller’s exact total listing count",
      );
  }
  if (canonical(row).length > 50000) throw new Error("Observation is too large");
  return row;
}
function normalizeSearchCoverageValue(
  input: unknown,
  now: number,
  searches: SavedSearch[],
): SearchCoverage[] {
  if (input == null) return [];
  return z
    .array(searchCoverageSchema)
    .max(50)
    .parse(input)
    .map((run) => {
      const search = searches.find((item) => item.id === run.search_id);
      if (!search) throw new Error("Search coverage needs a saved search");
      const start = time(run.started_at),
        end = time(run.finished_at);
      if (start > end || end > now + 300000) throw new Error("Invalid search coverage times");
      if (
        run.result_count != null &&
        run.inspected_count != null &&
        run.inspected_count > run.result_count
      )
        throw new Error("Inspected count exceeds search result count");
      if (canonical(run).length > 50000) throw new Error("Search coverage is too large");
      return Object.assign(run, {
        started_at: iso(start),
        finished_at: iso(end),
        search_revision: hash(search),
        scope_key: hash({
          source: run.source,
          search_id: run.search_id,
          query: run.query,
          filters: run.filters,
          sort: run.sort,
          search,
        }),
      });
    });
}
function fingerprint(row: ListingObservation): string {
  return hash(
    Object.fromEntries(
      [
        "title",
        "description",
        "attributes",
        "condition",
        "item_state",
        "functional",
        "bundle_type",
        "photos",
        "videos",
      ].map((name) => [name, row[name] ?? null]),
    ),
  );
}
export function publicationBounds(row: ListingObservation): [number, number] | null {
  const p = row.publication;
  return p?.kind === "published" && p.earliest_at && p.latest_at
    ? [time(p.earliest_at), time(p.latest_at)]
    : null;
}
export function rebuildHistory(key: string, history: ListingObservation[]) {
  let current: ListingObservation | undefined,
    prior: ListingObservation | undefined,
    firstActive: string | null = null,
    lastActive: string | null = null,
    conflict = false;
  const successes: string[] = [],
    seen = new Map<string, string>(),
    events: { id: string; kind: string; stamp: string; data: string }[] = [];
  const add = (
    kind: string,
    row: ListingObservation,
    detail: Record<string, unknown> = {},
  ): void => {
    const data = { kind, observed_at: row.observed_at, ...detail };
    events.push({
      id: hash([key, data]),
      kind,
      stamp: row.observed_at,
      data: JSON.stringify(data),
    });
  };
  for (const row of history) {
    if (row.check_outcome !== "success") {
      add("check_failed", row, { outcome: row.check_outcome });
      current ??= { ...row, availability: "unknown", price_minor: null };
      current.check_outcome = row.check_outcome;
      current.last_attempted_at = row.observed_at;
      continue;
    }
    successes.push(row.observed_at);
    const payload = fingerprint(row) + String(row.price_minor) + String(row.availability);
    if (seen.has(row.observed_at) && seen.get(row.observed_at) !== payload) conflict = true;
    seen.set(row.observed_at, payload);
    if (!prior) add("first_observed_at", row);
    else {
      if (
        (row.price_kind ?? "asking") === "asking" &&
        (prior.price_kind ?? "asking") === "asking" &&
        row.price_minor != null &&
        prior.price_minor != null &&
        row.currency === prior.currency &&
        (row.price_period ?? "once") === (prior.price_period ?? "once") &&
        row.price_minor !== prior.price_minor
      )
        add("price_changed", row, {
          previous_price_minor: prior.price_minor,
          price_minor: row.price_minor,
          currency: row.currency,
          earliest_at: prior.observed_at,
          latest_at: row.observed_at,
        });
      if (row.availability !== prior.availability)
        add("status_changed", row, {
          previous_state: prior.availability ?? "unknown",
          state: row.availability ?? "unknown",
          earliest_at: prior.observed_at,
          latest_at: row.observed_at,
        });
      if (fingerprint(row) !== fingerprint(prior)) add("content_changed", row);
    }
    for (const relation of row.relationships ?? [])
      if (!prior?.relationships?.some((item) => canonical(item) === canonical(relation)))
        add("relationship_observed", row, { relationship: relation });
    if (row.availability === "active") {
      firstActive ??= row.observed_at;
      lastActive = row.observed_at;
    }
    const original = current?.publication;
    // Files are durable saved evidence, independent of a fresh check's missing facts.
    // Search-card thumbnails supplement a saved gallery; a complete capture replaces it.
    const previous = current;
    const retainMedia = <T extends { media_id: string; position: number }>(
      old: T[] | undefined,
      fresh: T[] | undefined,
    ): T[] | undefined => {
      if (fresh === undefined) return old;
      if (row.media_capture?.status === "complete") return fresh;
      const combined = [...(old ?? [])];
      for (const item of fresh) {
        const existing = combined.findIndex((saved) => saved.media_id === item.media_id);
        if (existing >= 0) {
          const saved = combined[existing];
          if (saved) combined[existing] = { ...item, position: saved.position };
          continue;
        }
        const position = combined.some((saved) => saved.position === item.position)
          ? Math.max(0, ...combined.map((saved) => saved.position)) + 1
          : item.position;
        combined.push({ ...item, position });
      }
      return combined;
    };
    const photos = retainMedia(previous?.photos, row.photos);
    const videos = retainMedia(previous?.videos, row.videos);
    if (row.collection_stage === "discovery" && current) {
      if (
        ((row.location !== undefined && row.location !== current.location) ||
          (row["country"] !== undefined && row["country"] !== current["country"])) &&
        row.travel_checked_at === undefined
      ) {
        current = {
          ...current,
          drive_minutes: null,
          drive_origin: null,
          drive_latitude: null,
          drive_longitude: null,
          travel_source: null,
          travel_checked_at: null,
        };
        delete current.journey_estimate;
      }
      // A repeated search card refreshes observed card facts, without erasing a detailed review.
      const retained = {
        ...current,
        price_minor: row.price_minor,
        currency: row.currency,
        price_kind: row.price_kind,
        price_period: row.price_period,
        cash_price_minor: row.cash_price_minor,
        total_cash_cost_minor: row.total_cash_cost_minor,
        costs_complete: row.costs_complete,
        check_outcome: row.check_outcome,
        collection_stage: "discovery" as const,
        title: row.title,
        availability: row.availability,
        observed_at: row.observed_at,
        attributes: { ...current.attributes, ...row.attributes },
        evidence: { ...current.evidence, ...row.evidence },
        field_evidence: { ...current.field_evidence, ...row.field_evidence },
      };
      for (const name of [
        "description",
        "chip",
        "ram_gb",
        "ssd_gb",
        "screen_inches",
        "condition",
        "item_state",
        "functional",
        "location",
        "location_precision",
        "country",
        "category_id",
        "category_path",
        "bundle_type",
        "inventory_type",
        "quantity",
        "availability_text",
        "seller_name",
        "seller_id",
        "seller_type",
        "seller_profile_url",
        "seller_public_profile_url",
        "seller_friend_count",
        "seller_friend_count_text",
        "seller_friend_count_precision",
        "seller_listing_count",
        "seller_listing_count_text",
        "seller_listing_count_precision",
        "seller_listings_checked_at",
        "seller_inventory_review",
        "seller_profile_checked_at",
        "seller_profile_notes",
        "seller_avatar_media_id",
        "seller_has_profile_image",
        "seller_account_joined_at",
        "seller_metadata_checked_at",
        "drive_minutes",
        "drive_origin",
        "drive_latitude",
        "drive_longitude",
        "travel_source",
        "travel_checked_at",
        "publication",
        "logistics",
        "seller",
        "interest",
        "terms",
      ] as const) {
        if (row[name] === undefined) continue;
        Object.assign(retained, { [name]: row[name] });
        // Newly supplied facts must not borrow an earlier value's supporting evidence.
        if (row.evidence?.[name] === undefined) delete retained.evidence[name];
        if (row.field_evidence?.[name] === undefined) delete retained.field_evidence[name];
      }
      current = retained;
    } else current = { ...row };
    if (photos !== undefined) current.photos = photos;
    if (videos !== undefined) current.videos = videos;
    const reviewedImages = current.image_review?.total_images;
    const reviewedVideos = current.video_review?.total_videos;
    if (
      reviewedImages != null &&
      (current.photos ?? []).some((photo) => photo.position > reviewedImages)
    )
      delete current.image_review;
    if (
      reviewedVideos != null &&
      (current.videos ?? []).some((video) => video.position > reviewedVideos)
    )
      delete current.video_review;
    if (row.media_capture) current.media_capture = row.media_capture;
    else delete current.media_capture;
    if (original?.kind === "published") {
      const oldBounds = publicationBounds({ ...row, publication: original }),
        newBounds = publicationBounds(row);
      // Preserve established original dates, while refreshing relative text that has no bounds.
      if (
        row.publication === undefined ||
        (oldBounds && (!newBounds || oldBounds[0] <= newBounds[0]))
      )
        current.publication = original;
    }
    current.last_attempted_at = row.observed_at;
    prior = row;
  }
  const first = history[0],
    last = history.at(-1);
  if (!current || !first || !last) return undefined;
  delete current.evaluation_id;
  delete current.observation_sequence;
  current.first_observed_at = successes[0] ?? first.observed_at;
  current.last_observed_at = successes.at(-1) ?? last.observed_at;
  current.last_successful_at = successes.at(-1) ?? null;
  current.first_confirmed_active_at = firstActive;
  current.last_confirmed_active_at = lastActive;
  current.observation_conflict = conflict;
  return {
    current,
    events,
    firstObservedAt: current.first_observed_at,
    lastObservedAt: current.last_observed_at,
  };
}
export function distinct(rows: ListingObservation[]): ListingObservation[] {
  const groups = new Map<string, ListingObservation[]>();
  for (const row of rows) {
    const key = row.entity_key ?? row.key;
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  return Array.from(groups.values(), (group) => {
    const chosen = group.toSorted(
      (a, b) =>
        time(b.observed_at || b.last_observed_at) - time(a.observed_at || a.last_observed_at),
    )[0];
    if (!chosen) throw new Error("Empty listing group");
    const row = { ...chosen },
      publications = group
        .filter((item) => publicationBounds(item))
        .toSorted((a, b) => (publicationBounds(a)?.[0] ?? 0) - (publicationBounds(b)?.[0] ?? 0));
    if (publications[0]?.publication) row.publication = publications[0].publication;
    row.entity_sources = Array.from(new Set(group.map((item) => item.source))).toSorted();
    const starts = group
      .map((item) => item.first_observed_at)
      .filter((value): value is string => Boolean(value))
      .toSorted((a, b) => time(a) - time(b));
    if (starts[0]) row.first_observed_at = starts[0];
    return row;
  });
}
export function quality(
  row: ListingObservation,
  config: WorkspaceConfiguration,
  now: number,
  peers: ListingObservation[] = [],
) {
  const policy = withDefaults(qualityDefaults, config.quality_policy),
    flags: { code: string; message: string; severity: string }[] = [],
    priceReasons: string[] = [],
    stockReasons: string[] = [];
  const flag = (code: string, message: string, severity = "review"): void => {
    flags.push({ code, message, severity });
  };
  if ((row.check_outcome ?? "success") !== "success")
    stockReasons.push("The latest listing check did not succeed");
  const stamp = row.observed_at || row.last_observed_at;
  if (stamp && now - time(stamp) > policy.max_check_age_hours * 3600000)
    stockReasons.push("Listing availability needs a fresh check");
  if (row.availability !== "active") stockReasons.push("Listing is not confirmed active");
  if (
    row.price_kind !== "asking" ||
    !row.price_minor ||
    (row.product !== "rental" && (row.price_period ?? "once") !== "once")
  )
    priceReasons.push("Full purchase price is unknown or unavailable");
  const conflicts = Object.entries(row.field_evidence ?? {})
    .filter(([, field]) => field.state === "conflicting")
    .map(([name]) => name);
  if (conflicts.length || row.observation_conflict) {
    flag("conflicting_evidence", "Listing evidence conflicts and needs review");
    priceReasons.push("Conflicting listing evidence");
  }
  if (conflicts.includes("availability") || row.observation_conflict)
    stockReasons.push("Availability evidence conflicts");
  if (row.relationships?.some((relation) => relation.confidence === "probable"))
    flag("possible_duplicate", "This may be a relisted or cross-posted item", "context");
  const valid = distinct(peers).filter((peer) => peer.price_minor && peer.price_kind === "asking");
  let center: number | null = null,
    spread: number | null = null,
    score: number | null = null;
  if (row.price_minor && valid.length >= policy.minimum_outlier_peers) {
    const prices = valid.map((peer) => peer.price_minor ?? 0);
    center = median(prices);
    spread = median(prices.map((price) => Math.abs(price - (center ?? 0))));
    if (spread) {
      score = (0.6745 * (row.price_minor - (center ?? 0))) / spread;
      if (Math.abs(score) > policy.outlier_z)
        flag(
          score < 0 ? "low_price" : "high_price",
          `Purchase price is unusually ${score < 0 ? "low" : "high"} among equivalent listings`,
          "context",
        );
    } else
      flag("flat_price_sample", "Similar prices have no reliable statistical spread", "context");
  }
  const activeDays =
    row.first_confirmed_active_at && row.last_confirmed_active_at
      ? (time(row.last_confirmed_active_at) - time(row.first_confirmed_active_at)) / DAY
      : null;
  const bounds = publicationBounds(row),
    age = bounds ? (now - bounds[1]) / DAY : activeDays;
  const ages = distinct(peers)
    .flatMap((peer) => {
      const p = publicationBounds(peer);
      return p ? [(now - p[1]) / DAY] : [];
    })
    .toSorted((a, b) => a - b);
  if (
    bounds &&
    ages.length >= policy.minimum_outlier_peers &&
    age != null &&
    age > (ages[Math.min(ages.length - 1, Math.floor(ages.length * 0.95))] ?? Infinity)
  )
    flag(
      "long_advertised_age",
      "Advertised age is longer than most equivalent observed listings",
      "context",
    );
  for (const reason of stockReasons) flag("availability_uncertain", reason);
  const publicationReasons = conflicts.includes("publication")
    ? ["Publication evidence conflicts"]
    : bounds
      ? []
      : ["Original publication time is not established"];
  const durationReasons =
    conflicts.includes("availability") || row.observation_conflict
      ? ["Availability evidence conflicts"]
      : row.inventory_type === "multiple_units"
        ? ["Multi-unit stock does not establish an individual item's lifetime"]
        : row.first_confirmed_active_at
          ? []
          : ["No confirmed active observation"];
  const gates = {
    arrival_rate: publicationReasons,
    current_stock: stockReasons,
    price_baseline: [...stockReasons, ...priceReasons],
    duration_analysis: durationReasons,
    deal_alert: [...stockReasons, ...priceReasons],
  };
  return {
    flags,
    eligibility: Object.fromEntries(
      Object.entries(gates).map(([name, reasons]) => [
        name,
        { eligible: !reasons.length, reasons },
      ]),
    ),
    observed_active_days: activeDays,
    advertised_age_minimum_days: bounds ? age : null,
    peer_count: valid.length,
    median_cash_price_minor: center,
    mad_minor: spread,
    modified_z_score: score == null ? null : round(score, 2),
  };
}
export function applyHistory(
  row: ListingObservation,
  history: ListingObservation[],
  events: NonNullable<ListingObservation["events"]>,
) {
  row.events = events;
  row.price_history = history
    .toReversed()
    .filter((entry) => entry.check_outcome === "success")
    .map((entry) => ({
      evaluated_at: entry.ingested_at ?? entry.observed_at,
      observed_at: entry.observed_at,
      price_minor: entry.price_kind === "asking" ? entry.price_minor : null,
      currency: entry.currency ?? null,
      price_period: entry.price_period ?? "once",
    }));
  const start = row.first_confirmed_active_at;
  if (!start) {
    row.duration = {
      lower_days: null,
      upper_days: null,
      unfinished: true,
      basis: "No confirmed active observation",
    };
    return;
  }
  const terminal = history.find(
    (entry) =>
      time(entry.observed_at) >= time(start) &&
      entry.check_outcome === "success" &&
      (TERMINAL.has(entry.availability ?? "") || entry.availability === "reserved"),
  );
  const active =
    history.findLast(
      (entry) =>
        time(entry.observed_at) >= time(start) &&
        entry.check_outcome === "success" &&
        entry.availability === "active" &&
        (!terminal || time(entry.observed_at) <= time(terminal.observed_at)),
    )?.observed_at ?? start;
  row.duration = {
    lower_days: (time(active) - time(start)) / DAY,
    upper_days: terminal ? (time(terminal.observed_at) - time(start)) / DAY : null,
    unfinished: !terminal,
    outcome: terminal?.availability ?? "active_or_unknown",
    basis: "First observed availability episode; publication and transaction times may be earlier",
  };
}
export function calculateInsights(
  rows: ListingObservation[],
  search: SavedSearch,
  config: WorkspaceConfiguration,
  now: number,
  cohort: (row: ListingObservation, search: SavedSearch) => string | null,
  pricePool: ListingObservation[] = [],
  coverageRuns: SearchCoverage[] = [],
) {
  const cutoff = now - config.baseline_days * DAY;
  const eligible = distinct(
    rows.filter(
      (row) =>
        row.product === search.product &&
        time(row.last_attempted_at || row.last_observed_at) >= cutoff &&
        time(row.last_attempted_at || row.last_observed_at) <= now &&
        cohort(row, search) !== null,
    ),
  );
  const groups = new Map<string, ListingObservation[]>();
  for (const row of eligible) {
    const key = cohort(row, search);
    if (key === null) continue;
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  const revision = hash(search),
    runs = coverageRuns.filter(
      (run) =>
        run.search_id === search.id &&
        run.search_revision === revision &&
        time(run.finished_at) >= cutoff &&
        time(run.finished_at) <= now,
    );
  const intervals: [string, number, number][] = [],
    prior = new Map<string, SearchCoverage>(),
    maxGap = config.schedule.interval_minutes * 120000;
  for (const run of runs.toSorted((a, b) => time(a.finished_at) - time(b.finished_at))) {
    const previous = prior.get(run.scope_key);
    if (
      run.status === "success" &&
      run.pagination_complete &&
      previous?.status === "success" &&
      previous.pagination_complete
    ) {
      const left = time(previous.finished_at),
        right = time(run.finished_at);
      if (right > left && right - left <= maxGap) intervals.push([run.source, left, right]);
    }
    prior.set(run.scope_key, run);
  }
  const merged: [string, number, number][] = [];
  for (const interval of intervals.toSorted((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && last[0] === interval[0] && interval[1] <= last[2])
      last[2] = Math.max(last[2], interval[2]);
    else merged.push([...interval]);
  }
  return Array.from(groups.values(), (members) => {
    const first = members[0];
    if (!first) throw new Error("Empty comparison cohort");
    const sources = new Set(members.flatMap((row) => row.entity_sources ?? [row.source]));
    const coverage =
      sources.size === 1
        ? merged.reduce(
            (sum, [source, left, right]) => sum + (sources.has(source) ? (right - left) / DAY : 0),
            0,
          )
        : 0;
    const arrivals: ListingObservation[] = [],
      dates: number[] = [];
    let unknown = 0;
    for (const row of members) {
      const bounds = quality(row, config, now).eligibility["arrival_rate"]?.eligible
        ? publicationBounds(row)
        : null;
      if (
        !bounds &&
        row.first_observed_at &&
        merged.some(
          ([source, left, right]) =>
            source === row.source &&
            left < time(row.first_observed_at) &&
            time(row.first_observed_at) <= right,
        )
      )
        unknown++;
      if (
        bounds &&
        cutoff <= bounds[0] &&
        bounds[1] <= now &&
        merged.some(
          ([source, left, right]) =>
            source === row.source && left < bounds[0] && bounds[1] <= right,
        )
      ) {
        arrivals.push(row);
        if (bounds[0] === bounds[1]) dates.push(bounds[0]);
      }
    }
    const sortedDates = dates.toSorted((a, b) => a - b);
    let gap =
      sortedDates.length > 1
        ? median(
            sortedDates
              .slice(1)
              .map((right, index) => (right - (sortedDates[index] ?? right)) / DAY),
          )
        : null;
    if (
      gap !== null &&
      (sources.size !== 1 ||
        !merged.some(
          ([, left, right]) =>
            left <= (sortedDates[0] ?? Infinity) && (sortedDates.at(-1) ?? Infinity) <= right,
        ))
    )
      gap = null;
    const priceKeys = new Set(pricePool.map((row) => row.key)),
      prices = members.filter((row) => priceKeys.has(row.key)).map((row) => row.price_minor ?? 0);
    const completed: NonNullable<ListingObservation["duration"]>[] = [];
    let unfinished = 0;
    for (const row of members)
      if (quality(row, config, now).eligibility["duration_analysis"]?.eligible) {
        if (row.duration?.lower_days != null) {
          if (row.duration.unfinished) unfinished++;
          else completed.push(row.duration);
        }
      }
    const memberEntities = new Set(members.map((member) => member.entity_key ?? member.key));
    const cohortKey = cohort(first, search);
    return {
      cohort_listing_ids: members.map((row) => row.listing_id),
      cohort_listing_keys: rows
        .filter(
          (row) =>
            memberEntities.has(row.entity_key ?? row.key) && cohort(row, search) === cohortKey,
        )
        .map((row) => row.key)
        .toSorted(),
      distinct_count: members.length,
      confirmed_active_count: members.filter(
        (row) => quality(row, config, now).eligibility["current_stock"]?.eligible,
      ).length,
      sold_count: members.filter((row) => row.availability === "sold").length,
      unknown_outcome_count: members.filter(
        (row) =>
          ["unknown", "unknown_unavailable"].includes(row.availability ?? "") ||
          (row.check_outcome ?? "success") !== "success",
      ).length,
      supported_arrivals: arrivals.length,
      coverage_days: round(coverage, 4),
      publication_unknown_count: unknown,
      arrivals_per_day:
        coverage && !unknown && members.some((row) => publicationBounds(row))
          ? round(arrivals.length / coverage, 3)
          : null,
      median_arrival_gap_days: gap,
      median_cash_price_minor: median(prices),
      currency: first.currency ?? "GBP",
      price_period: first.price_period ?? "once",
      cash_price_sample_count: prices.length,
      window_days: config.baseline_days,
      completed_period_count: completed.length,
      unfinished_period_count: unfinished,
      median_completed_lower_days: median(completed.map((item) => item.lower_days ?? 0)),
      median_completed_upper_days: median(completed.map((item) => item.upper_days ?? 0)),
      successful_query_checks: runs.filter((run) => run.status === "success").length,
      note: "Observed sample, not complete inventory. Arrival rates need stable repeated coverage and publication evidence; unseen short-lived ads can be missed.",
    };
  });
}
