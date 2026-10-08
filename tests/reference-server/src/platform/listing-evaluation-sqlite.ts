import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DAY, iso, parseJson, record, time } from "../workspace/model.ts";
import * as tracking from "../listings/tracking.ts";
import * as trackingStorage from "./tracking-sqlite.ts";
import { all, get, openDatabase, execute, close, transaction } from "./sqlite.ts";
import { Clock, Effect } from "effect";
import { ValidationError } from "../workspace/errors.ts";
import {
  validateConfiguration,
  normalizeObservations,
  ruleHash,
  evaluateListing,
  comparisonPool,
} from "../listings/evaluation.ts";
import type { EvaluationResult, Alert, Evaluation } from "../listings/evaluation.ts";
export const connect = openDatabase;
export const evaluateObservations = Effect.fn("evaluateObservations")(function* (
  input: unknown,
  observations: unknown,
  path: string,
  demo: boolean = false,
  providedNow?: number,
  coverageInput: unknown = null,
  connection?: Database,
) {
  const now = providedNow ?? (yield* Clock.currentTimeMillis);
  if (!Number.isFinite(now))
    return yield* Effect.fail(new ValidationError({ message: "Invalid run time" }));
  const config = yield* validateConfiguration(input),
    rows = yield* normalizeObservations(observations, demo, now),
    coverage = yield* tracking.normalizeSearchCoverage(coverageInput, now, config.searches),
    stamp = iso(now),
    id = yield* Effect.sync(randomUUID);
  const db = connection ?? (yield* Effect.acquireRelease(connect(path), close));
  const result: EvaluationResult = {
    evaluation_id: id,
    evaluated_at: stamp,
    mode: demo ? "synthetic" : "manual_import",
    origin: config.origin,
    observed_count: rows.length,
    new_alerts: [],
    pending_alerts: [],
    searches: [],
  };
  yield* transaction(
    db,
    Effect.gen(function* () {
      yield* execute(db, "INSERT INTO listing_evaluations VALUES (?, ?, ?, ?, ?)", [
        id,
        stamp,
        result.mode,
        rows.length,
        JSON.stringify(config),
      ]);
      for (const row of rows) {
        const payload = JSON.stringify(row);
        yield* execute(
          db,
          "INSERT INTO listings VALUES (?, ?, ?, ?, ?) ON CONFLICT(listing_key) DO UPDATE SET document_json=excluded.document_json, last_observed_at=excluded.last_observed_at",
          [row.key, row.provenance, payload, stamp, stamp],
        );
        yield* execute(db, "INSERT INTO listing_observations VALUES (?, ?, ?, ?)", [
          id,
          row.key,
          row.price_minor,
          payload,
        ]);
      }
      yield* trackingStorage.recordEvaluation(db, rows, id, coverage);
      const cutoff = now - config.baseline_days * DAY,
        current = (yield* trackingStorage.load(db, demo ? "synthetic" : "manual")).filter(
          (row) => time(row.last_observed_at) >= cutoff && time(row.last_observed_at) <= now,
        );
      for (const search of config.searches) {
        if (!search.enabled) {
          result.searches.push({ search, counts: { paused: 1 }, decisions: [] });
          continue;
        }
        const originalSearches: unknown[] =
          record(input) && Array.isArray(input["searches"]) ? input["searches"] : [];
        const rules = ruleHash(
          search,
          config,
          originalSearches.find((item) => record(item) && item["id"] === search.id) ?? search,
        );
        yield* execute(
          db,
          "UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND rule_hash<>? AND status='pending'",
          [search.id, rules],
        );
        const pool = comparisonPool(current, search, config, now, demo),
          decisions: Evaluation[] = [];
        for (const row of current.filter((item) => item.product === search.product)) {
          const decision = evaluateListing(row, pool, search, config, now, demo);
          if (decision.status === "qualifies") {
            const price = row.price_minor ?? 0;
            const previous =
              (yield* get<{ price: number | null }>(
                db,
                "SELECT MIN(price_minor) AS price FROM deal_alerts WHERE search_id=? AND listing_key=? AND rule_hash=? AND status<>'withdrawn'",
                search.id,
                row.key,
                rules,
              ))?.price ?? null;
            if (previous === null || price < previous || config.alert_policy === "every_run") {
              yield* execute(
                db,
                "UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",
                [search.id, row.key, rules],
              );
              const alert: Alert = {
                ...decision,
                id: yield* Effect.sync(randomUUID),
                search_id: search.id,
                search_name: search.name,
                kind: previous === null ? "first_qualification" : "price_drop",
                created_at: stamp,
                status: "pending",
                mode: result.mode,
              };
              yield* execute(db, "INSERT INTO deal_alerts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
                alert.id,
                search.id,
                row.key,
                rules,
                price,
                stamp,
                "pending",
                JSON.stringify(alert),
              ]);
              result.new_alerts.push(alert);
            }
            for (const pending of yield* all<{ id: string; payload: string }>(
              db,
              "SELECT id, alert_json AS payload FROM deal_alerts WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",
              search.id,
              row.key,
              rules,
            ))
              yield* execute(db, "UPDATE deal_alerts SET alert_json=?, price_minor=? WHERE id=?", [
                JSON.stringify({ ...parseJson<Alert>(pending.payload), ...decision }),
                price,
                pending.id,
              ]);
          } else
            yield* execute(
              db,
              "UPDATE deal_alerts SET status='withdrawn' WHERE search_id=? AND listing_key=? AND rule_hash=? AND status='pending'",
              [search.id, row.key, rules],
            );
          decisions.push(decision);
        }
        const counts: Record<string, number> = {};
        for (const decision of decisions)
          counts[decision.status] = (counts[decision.status] ?? 0) + 1;
        result.searches.push({ search, counts, decisions });
      }
      const active = new Set(
        config.searches.filter((search) => search.enabled).map((search) => search.id),
      );
      for (const alert of yield* all<{
        id: string;
        search_id: string;
        listing_key: string;
        payload: string;
      }>(
        db,
        "SELECT id,search_id,listing_key,rule_hash,price_minor,created_at,status,alert_json AS payload FROM deal_alerts WHERE status='pending'",
      )) {
        const payload = parseJson<Alert>(alert.payload);
        if (payload.mode !== result.mode) continue;
        const listing = yield* get<{ last_observed_at: string }>(
          db,
          "SELECT last_observed_at FROM listings WHERE listing_key=?",
          alert.listing_key,
        );
        if (!active.has(alert.search_id) || !listing || time(listing.last_observed_at) < cutoff)
          yield* execute(db, "UPDATE deal_alerts SET status='withdrawn' WHERE id=?", [alert.id]);
      }
      result.pending_alerts = (yield* all<{ search_id: string; payload: string }>(
        db,
        "SELECT id,search_id,listing_key,rule_hash,price_minor,created_at,status,alert_json AS payload FROM deal_alerts WHERE status='pending' ORDER BY created_at, id",
      ))
        .filter((alert) => active.has(alert.search_id))
        .map((alert) => parseJson<Alert>(alert.payload))
        .filter((alert) => alert.mode === result.mode);
    }),
  );
  return result;
}, Effect.scoped);
export const acknowledge = Effect.fn("acknowledge")(function* (path: string, ids: string[]) {
  const db = yield* Effect.acquireRelease(connect(path), close);
  return yield* transaction(
    db,
    Effect.gen(function* () {
      const pending = yield* Effect.forEach(ids, (id) =>
        get(db, "SELECT 1 FROM deal_alerts WHERE id=? AND status='pending'", id),
      );
      if (pending.some((row) => !row))
        return yield* Effect.fail(
          new ValidationError({
            message: "Each acknowledgement must refer to a pending alert",
          }),
        );
      for (const id of ids)
        yield* execute(db, "UPDATE deal_alerts SET status='delivered' WHERE id=?", [id]);
      return ids.length;
    }),
  );
}, Effect.scoped);
