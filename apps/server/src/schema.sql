CREATE TABLE journey_estimates (origin_key TEXT NOT NULL,destination_key TEXT NOT NULL,document_json TEXT NOT NULL CHECK(json_valid(document_json)),PRIMARY KEY(origin_key,destination_key));
CREATE TABLE listing_search_discoveries (listing_key TEXT NOT NULL,search_id TEXT NOT NULL,run_id TEXT NOT NULL,run_started_at TEXT NOT NULL,recorded_at TEXT,PRIMARY KEY(listing_key,search_id));
CREATE INDEX listing_discoveries_by_search ON listing_search_discoveries(search_id);
CREATE TABLE listing_seen (listing_key TEXT NOT NULL,search_id TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(listing_key,search_id));
CREATE INDEX listing_seen_by_search ON listing_seen(search_id);
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
CREATE TABLE coordination_stream (id INTEGER PRIMARY KEY CHECK(id=1), stream_id TEXT NOT NULL);
CREATE TABLE coordination_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, created_at TEXT NOT NULL, resource_json TEXT NOT NULL CHECK(json_valid(resource_json)));
CREATE INDEX pending_alerts_by_created ON deal_alerts(status,created_at,id);
CREATE INDEX observations_by_listing ON listing_observations(listing_key);
CREATE INDEX listings_by_product ON listings(provenance,json_extract(document_json,'$.product'));
-- Completion is committed atomically with its resource, including reconciliation.
CREATE TRIGGER run_completion_insert AFTER INSERT ON search_runs
WHEN json_extract(NEW.document_json,'$.phase') IN ('completed','partial','blocked','cancelled','deferred')
BEGIN
 INSERT OR IGNORE INTO coordination_events(event_key,kind,created_at,resource_json)
 VALUES ('run:'||NEW.id||':'||json_extract(NEW.document_json,'$.version'),
 CASE WHEN json_extract(NEW.document_json,'$.phase')='completed' THEN 'search_run.completed' ELSE 'search_run.interrupted' END,
 NEW.updated_at,json_object('run_id',NEW.id,'search_id',NEW.search_id,'version',json_extract(NEW.document_json,'$.version'),'phase',json_extract(NEW.document_json,'$.phase')));
END;
CREATE TRIGGER run_completion_update AFTER UPDATE ON search_runs
WHEN json_extract(NEW.document_json,'$.phase') IN ('completed','partial','blocked','cancelled','deferred')
 AND json_extract(OLD.document_json,'$.phase')<>json_extract(NEW.document_json,'$.phase')
BEGIN
 INSERT OR IGNORE INTO coordination_events(event_key,kind,created_at,resource_json)
 VALUES ('run:'||NEW.id||':'||json_extract(NEW.document_json,'$.version'),
 CASE WHEN json_extract(NEW.document_json,'$.phase')='completed' THEN 'search_run.completed' ELSE 'search_run.interrupted' END,
 NEW.updated_at,json_object('run_id',NEW.id,'search_id',NEW.search_id,'version',json_extract(NEW.document_json,'$.version'),'phase',json_extract(NEW.document_json,'$.phase')));
END;
CREATE TRIGGER alert_created AFTER INSERT ON deal_alerts
BEGIN
 INSERT OR IGNORE INTO coordination_events(event_key,kind,created_at,resource_json)
 VALUES ('alert:'||NEW.id,'alert.created',NEW.created_at,json_object('alert_id',NEW.id,'search_id',NEW.search_id,'listing_key',NEW.listing_key));
END;
