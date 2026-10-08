import { modelExclusionRule } from "@goodfinds/contracts/discovery";
import type { ListingObservation } from "../workspace/model.ts";
import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { WorkspaceConfiguration } from "../workspace/model.ts";
import type { WorkspaceMode } from "@goodfinds/contracts/state";
import exampleConfig from "../../../../skills/marketplace-shopping/assets/example-workspace.json" with { type: "json" };
import { hash, parseJson } from "../workspace/model.ts";
import { all, execute, get } from "./sqlite.ts";
import { validation } from "../workspace/errors.ts";
import type { Revisions } from "@goodfinds/contracts/revisions";
import { validateConfiguration } from "../listings/evaluation.ts";

const emptyConfiguration = {
  origin: "Location not set",
  origin_confirmed: false,
  browser_preference: "in_app",
  baseline_days: 30,
  minimum_peer_listings: 3,
  alert_policy: "first_qualification_and_lower_price",
  searches: [],
};

const collections = [
  "searches",
  "drafts",
  "monitoring",
  "feedback",
  "browser_access",
  "platform_sessions",
  "listing_contacts",
] as const;
const baseConfiguration = (config: WorkspaceConfiguration) =>
  Object.fromEntries(
    Object.entries(config).filter(([key]) => !collections.some((item) => item === key)),
  );

const readConfiguration = Effect.fnUntraced(function* (db: Database) {
  const saved = yield* get<{ data: string }>(
    db,
    "SELECT document_json AS data,entity_version FROM workspace_settings WHERE id=1",
  );
  if (!saved) return null;
  const base = yield* validation(() => parseJson<Record<string, unknown>>(saved.data));
  const read = (sql: string) =>
    all<{ data: string }>(db, sql).pipe(
      Effect.map((rows) => rows.map((row) => parseJson<unknown>(row.data))),
    );
  const evidence = yield* all<{ kind: string; data: string }>(
    db,
    "SELECT kind,document_json AS data FROM integration_observations",
  );
  return {
    ...base,
    searches: yield* read(
      "SELECT document_json AS data FROM saved_searches WHERE is_deleted=0 ORDER BY sort_order,id",
    ),
    drafts: yield* read(
      "SELECT document_json AS data FROM search_drafts WHERE is_deleted=0 ORDER BY sort_order,id",
    ),
    monitoring: yield* read(
      "SELECT document_json AS data FROM search_monitoring WHERE is_deleted=0 ORDER BY sort_order,search_id",
    ),
    feedback: yield* read(
      "SELECT document_json AS data FROM listing_feedback_events ORDER BY sort_order,id",
    ),
    ...Object.fromEntries(
      evidence
        .filter((row) => row.data !== "null")
        .map((row) => [row.kind, parseJson<unknown>(row.data)]),
    ),
  };
});

export const configurationRevisions = Effect.fnUntraced(function* (db: Database) {
  const settings = yield* get<{ entity_version: number }>(
    db,
    "SELECT entity_version FROM workspace_settings WHERE id=1",
  );
  const tokens = (table: string, column = "id") =>
    all<{ id: string; entity_version: number }>(
      db,
      `SELECT ${column} AS id,entity_version FROM ${table}`,
    ).pipe(
      Effect.map((rows) =>
        Object.fromEntries(
          rows.map((row) => [row.id, hash({ table, id: row.id, version: row.entity_version })]),
        ),
      ),
    );
  const evidence = yield* all<{ kind: string; entity_version: number }>(
    db,
    "SELECT kind,entity_version FROM integration_observations ORDER BY kind",
  );
  const revisions: Revisions = {
    settings: hash({ version: settings?.entity_version ?? 0 }),
    evidence: hash(evidence),
    searches: yield* tokens("saved_searches"),
    drafts: yield* tokens("search_drafts"),
    monitoring: yield* tokens("search_monitoring", "search_id"),
    feedback: yield* tokens("listing_feedback_events"),
    absent: hash(null),
  };
  return revisions;
});

export const saveConfiguration = Effect.fnUntraced(function* (
  db: Database,
  config: WorkspaceConfiguration,
) {
  const base = yield* validation(() => JSON.stringify(baseConfiguration(config)));
  yield* execute(
    db,
    `INSERT INTO workspace_settings (id,document_json,entity_version) VALUES (1,?,1)
    ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json,entity_version=workspace_settings.entity_version+1
    WHERE workspace_settings.document_json<>excluded.document_json`,
    [base],
  );
  // Only changed entities get a new version. Deleting a search retains a tombstone for history.
  for (const [sort_order, search] of config.searches.entries())
    yield* execute(
      db,
      `INSERT INTO saved_searches (id,entity_version,name,product,enabled,is_deleted,sort_order,document_json) VALUES (?,1,?,?,?,0,?,?)
      ON CONFLICT(id) DO UPDATE SET entity_version=saved_searches.entity_version+CASE WHEN saved_searches.document_json<>excluded.document_json OR saved_searches.is_deleted<>0 THEN 1 ELSE 0 END,
      name=excluded.name,product=excluded.product,enabled=excluded.enabled,is_deleted=0,sort_order=excluded.sort_order,document_json=excluded.document_json`,
      [
        search.id,
        search.name,
        search.product,
        Number(search.enabled),
        sort_order,
        JSON.stringify(search),
      ],
    );
  for (const saved of yield* all<{ id: string }>(
    db,
    "SELECT id FROM saved_searches WHERE is_deleted=0",
  ))
    if (!config.searches.some((item) => item.id === saved.id))
      yield* execute(
        db,
        "UPDATE saved_searches SET is_deleted=1,entity_version=entity_version+1 WHERE id=?",
        [saved.id],
      );
  for (const [sort_order, draft] of config.drafts.entries())
    yield* execute(
      db,
      `INSERT INTO search_drafts VALUES (?,1,0,?,?) ON CONFLICT(id) DO UPDATE SET entity_version=search_drafts.entity_version+CASE WHEN search_drafts.document_json<>excluded.document_json OR search_drafts.is_deleted<>0 THEN 1 ELSE 0 END,is_deleted=0,sort_order=excluded.sort_order,document_json=excluded.document_json`,
      [draft.id, sort_order, JSON.stringify(draft)],
    );
  for (const saved of yield* all<{ id: string }>(
    db,
    "SELECT id FROM search_drafts WHERE is_deleted=0",
  ))
    if (!config.drafts.some((item) => item.id === saved.id))
      yield* execute(
        db,
        "UPDATE search_drafts SET is_deleted=1,entity_version=entity_version+1 WHERE id=?",
        [saved.id],
      );
  for (const [sort_order, monitoring] of config.monitoring.entries())
    yield* execute(
      db,
      `INSERT INTO search_monitoring VALUES (?,1,0,?,?,?) ON CONFLICT(search_id) DO UPDATE SET entity_version=search_monitoring.entity_version+CASE WHEN search_monitoring.document_json<>excluded.document_json OR search_monitoring.is_deleted<>0 THEN 1 ELSE 0 END,is_deleted=0,preference=excluded.preference,sort_order=excluded.sort_order,document_json=excluded.document_json`,
      [monitoring.search_id, monitoring.preference, sort_order, JSON.stringify(monitoring)],
    );
  for (const saved of yield* all<{ search_id: string }>(
    db,
    "SELECT search_id FROM search_monitoring WHERE is_deleted=0",
  ))
    if (!config.monitoring.some((item) => item.search_id === saved.search_id))
      yield* execute(
        db,
        "UPDATE search_monitoring SET is_deleted=1,entity_version=entity_version+1 WHERE search_id=?",
        [saved.search_id],
      );
  for (const [sort_order, feedback] of config.feedback.entries())
    yield* execute(
      db,
      `INSERT INTO listing_feedback_events VALUES (?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET entity_version=listing_feedback_events.entity_version+CASE WHEN listing_feedback_events.document_json<>excluded.document_json THEN 1 ELSE 0 END,undone=excluded.undone,sort_order=excluded.sort_order,document_json=excluded.document_json`,
      [
        feedback.id,
        feedback.search_id,
        Number(feedback.undone),
        sort_order,
        JSON.stringify(feedback),
      ],
    );
  // Feedback is audit history: retain undone events rather than removing their original evidence.
  for (const kind of ["browser_access", "platform_sessions", "listing_contacts"] as const)
    yield* execute(
      db,
      `INSERT INTO integration_observations VALUES (?,1,?) ON CONFLICT(kind) DO UPDATE SET entity_version=integration_observations.entity_version+1,document_json=excluded.document_json WHERE integration_observations.document_json<>excluded.document_json`,
      [kind, JSON.stringify(config[kind] ?? null)],
    );
});

export const loadConfiguration = Effect.fn("loadConfiguration")(function* (
  db: Database,
  mode: WorkspaceMode,
) {
  const saved = yield* readConfiguration(db);
  if (saved) {
    const config = yield* validateConfiguration(saved);
    const pending = config.feedback.filter(
      (event) =>
        !event.undone &&
        !event.rule &&
        event.exclude_model !== false &&
        event.reason === "Not interested in this model",
    );
    if (pending.length) {
      const rows = yield* all<{ data: string }>(
        db,
        "SELECT document_json AS data FROM listings WHERE provenance=?",
        mode === "sample" ? "synthetic" : "manual",
      );
      const listings = rows.map((row) => parseJson<ListingObservation>(row.data));
      let changed = false;
      for (const event of pending) {
        const row = listings.find((item) => item.key === event.listing_key);
        const search = config.searches.find((item) => item.id === event.search_id);
        const rule = row && search ? modelExclusionRule(row, search) : undefined;
        if (rule) {
          event.rule = rule;
          event.exclude_model = true;
          changed = true;
        }
      }
      if (changed) yield* saveConfiguration(db, config);
    }
    return config;
  }
  // Demo data must never be derived from the buyer's live workspace.
  const normalized = yield* validateConfiguration(
    mode === "sample" ? exampleConfig : emptyConfiguration,
  );
  yield* saveConfiguration(db, normalized);
  return normalized;
});
