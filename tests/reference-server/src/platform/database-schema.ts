import type { Database } from "bun:sqlite";

export const WORKSPACE_SCHEMA_VERSION = 4;
const READING_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS listing_seen (listing_key TEXT NOT NULL,search_id TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(listing_key,search_id));
CREATE INDEX IF NOT EXISTS listing_seen_by_search ON listing_seen(search_id);`;
const DISCOVERY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS listing_search_discoveries (listing_key TEXT NOT NULL,search_id TEXT NOT NULL,run_id TEXT NOT NULL,run_started_at TEXT NOT NULL,recorded_at TEXT,PRIMARY KEY(listing_key,search_id));
CREATE INDEX IF NOT EXISTS listing_discoveries_by_search ON listing_search_discoveries(search_id);`;
const BACKFILL_DISCOVERIES_SQL = `INSERT OR IGNORE INTO listing_search_discoveries (listing_key,search_id,run_id,run_started_at,recorded_at)
SELECT found.value,runs.search_id,runs.id,json_extract(runs.document_json,'$.created_at'),NULL
FROM search_runs AS runs,json_each(runs.document_json,'$.listing_keys') AS found
WHERE found.type='text' AND julianday(json_extract(runs.document_json,'$.created_at')) IS NOT NULL
ORDER BY julianday(json_extract(runs.document_json,'$.created_at')),runs.id;`;
const JOURNEY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS journey_estimates (origin_key TEXT NOT NULL,destination_key TEXT NOT NULL,document_json TEXT NOT NULL CHECK(json_valid(document_json)),PRIMARY KEY(origin_key,destination_key));`;
export const WORKSPACE_SCHEMA_SQL = `
${JOURNEY_SCHEMA_SQL}
${DISCOVERY_SCHEMA_SQL}
${READING_SCHEMA_SQL}
CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK(id=1), document_json TEXT NOT NULL CHECK(json_valid(document_json)), entity_version INTEGER NOT NULL);
CREATE TABLE saved_searches (id TEXT PRIMARY KEY, entity_version INTEGER NOT NULL, name TEXT NOT NULL, product TEXT NOT NULL, enabled INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE search_drafts (id TEXT PRIMARY KEY, entity_version INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE search_monitoring (search_id TEXT PRIMARY KEY, entity_version INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0, preference TEXT NOT NULL, sort_order INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE listing_feedback_events (id TEXT PRIMARY KEY, search_id TEXT NOT NULL, entity_version INTEGER NOT NULL, undone INTEGER NOT NULL, sort_order INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE INDEX listing_feedback_by_search ON listing_feedback_events(search_id, sort_order);
CREATE TABLE integration_observations (kind TEXT PRIMARY KEY, entity_version INTEGER NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE listings (listing_key TEXT PRIMARY KEY, provenance TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)), first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL);
CREATE TABLE listing_evaluations (id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL, mode TEXT NOT NULL, observed_count INTEGER NOT NULL, configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)));
CREATE TABLE listing_observations (evaluation_id TEXT NOT NULL, listing_key TEXT NOT NULL, price_minor INTEGER, document_json TEXT NOT NULL CHECK(json_valid(document_json)), PRIMARY KEY(evaluation_id, listing_key));
CREATE TABLE deal_alerts (id TEXT PRIMARY KEY, search_id TEXT NOT NULL, listing_key TEXT NOT NULL, rule_hash TEXT NOT NULL, price_minor INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, alert_json TEXT NOT NULL CHECK(json_valid(alert_json)));
CREATE TABLE listing_events (id TEXT PRIMARY KEY, listing_key TEXT NOT NULL, kind TEXT NOT NULL, observed_at TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE INDEX listing_events_by_listing ON listing_events(listing_key, observed_at);
CREATE TABLE search_coverage (id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE seller_conversations (listing_key TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)), updated_at TEXT NOT NULL);
CREATE TABLE search_runs (id TEXT PRIMARY KEY, search_id TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)), updated_at TEXT NOT NULL);
CREATE INDEX search_runs_by_search ON search_runs(search_id, updated_at);
CREATE TABLE search_run_workers (run_id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE TABLE listing_media_captures (id TEXT PRIMARY KEY, listing_key TEXT NOT NULL, captured_at TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
CREATE INDEX listing_media_captures_by_listing ON listing_media_captures(listing_key, captured_at);
CREATE TABLE operation_receipts (request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL);
`;

export function initializeWorkspaceDatabase(db: Database) {
  db.transaction(() => {
    const version =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version === WORKSPACE_SCHEMA_VERSION) return;
    if (version === 1 || version === 2 || version === 3) {
      if (version === 1) db.run(JOURNEY_SCHEMA_SQL);
      if (version < 3) {
        db.run(DISCOVERY_SCHEMA_SQL);
        if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_runs'").get())
          db.run(BACKFILL_DISCOVERIES_SQL);
      }
      db.run(READING_SCHEMA_SQL);
      db.run(`PRAGMA user_version=${WORKSPACE_SCHEMA_VERSION}`);
      return;
    }
    const existing = db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
      .get();
    if (version !== 0 || existing)
      throw new Error("Unsupported workspace schema; use a canonical workspace database");
    db.run(WORKSPACE_SCHEMA_SQL);
    db.run(`PRAGMA user_version=${WORKSPACE_SCHEMA_VERSION}`);
  }).immediate();
}
