import type { Database } from "bun:sqlite";
import { Clock, Effect } from "effect";
import {
  journeyReportSchema,
  journeyEstimateSchema,
  journeyOriginKey,
  journeyDestinationKey,
  journeyLifetime,
  journeyFresh,
} from "@goodfinds/contracts/journeys";
import type { JourneyOrigin, JourneyEstimate } from "@goodfinds/contracts/journeys";
import type { ListingObservation, WorkspaceConfiguration } from "../workspace/model.ts";
import { parseJson, iso } from "../workspace/model.ts";
import { all, get, execute } from "./sqlite.ts";
import { validation } from "../workspace/errors.ts";

export const applyCachedJourneys = Effect.fnUntraced(function* (
  db: Database,
  rows: ListingObservation[],
) {
  const settings = yield* get<{ data: string }>(
    db,
    "SELECT document_json AS data FROM workspace_settings WHERE id=1",
  );
  if (!settings) return;
  const config = parseJson<JourneyOrigin>(settings.data);
  const now = yield* Clock.currentTimeMillis;
  const saved = yield* all<{ data: string }>(
    db,
    "SELECT document_json AS data FROM journey_estimates WHERE origin_key=?",
    journeyOriginKey(config),
  );
  const cache = new Map(
    saved.map((entry) => {
      const route = journeyEstimateSchema.parse(parseJson<unknown>(entry.data));
      return [journeyDestinationKey(route.destination, route.country), route] as const;
    }),
  );
  for (const row of rows) {
    const route = cache.get(
      journeyDestinationKey(
        row.location ?? "",
        typeof row["country"] === "string" ? row["country"] : config.location?.country,
      ),
    );
    if (!route || !journeyFresh(route, config, row, now)) continue;
    // A newer listing-specific route remains authoritative. Neither overlay changes listing observation times.
    if (
      row.drive_origin === config.origin &&
      Date.parse(row.travel_checked_at ?? "") > Date.parse(route.checked_at)
    )
      continue;
    Object.assign(row, {
      drive_minutes: route.drive_minutes,
      drive_origin: config.origin,
      drive_latitude: config.location?.latitude ?? null,
      drive_longitude: config.location?.longitude ?? null,
      travel_source: "Google Maps · town-level estimate",
      travel_checked_at: route.checked_at,
      journey_estimate: route,
      evidence: { ...row.evidence, drive_minutes: route.evidence },
    });
  }
});
export const recordJourney = Effect.fnUntraced(function* (
  db: Database,
  input: unknown,
  config: WorkspaceConfiguration,
  rows: ListingObservation[],
  now: number,
) {
  const report = yield* validation(() => journeyReportSchema.parse(input));
  yield* validation(() => {
    if (!config.origin_confirmed || report.origin_key !== journeyOriginKey(config))
      throw new Error("The travel origin changed or is unconfirmed. Read the journey queue again.");
    const checked = Date.parse(report.checked_at);
    if (checked > now || now - checked >= journeyLifetime(report.estimate_kind))
      throw new Error("Use a current journey check with its actual check time.");
    if (
      report.listing_keys.some((key) => {
        const row = rows.find((item) => item.key === key);
        return (
          !row ||
          journeyDestinationKey(
            row.location ?? "",
            typeof row["country"] === "string" ? row["country"] : config.location?.country,
          ) !== journeyDestinationKey(report.destination, report.country)
        );
      })
    )
      throw new Error("The destination must match every saved listing in this route check.");
  });
  const { listing_keys: _keys, ...details } = report;
  const estimate: JourneyEstimate = {
    ...details,
    expires_at: iso(Date.parse(report.checked_at) + journeyLifetime(report.estimate_kind)),
  };
  yield* execute(
    db,
    `INSERT INTO journey_estimates (origin_key,destination_key,document_json) VALUES (?,?,?) ON CONFLICT(origin_key,destination_key) DO UPDATE SET document_json=excluded.document_json WHERE julianday(json_extract(excluded.document_json,'$.checked_at')) >= julianday(json_extract(journey_estimates.document_json,'$.checked_at'))`,
    [
      report.origin_key,
      journeyDestinationKey(report.destination, report.country),
      JSON.stringify(estimate),
    ],
  );
});
