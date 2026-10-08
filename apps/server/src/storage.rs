use crate::{
    contracts,
    error::{Error, Result},
    util::*,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Workspace {
    pub db: Connection,
    pub config: Value,
    pub root: PathBuf,
    pub mode: String,
    pub now: i64,
    pub access_context: String,
    pub automations_directory: Option<PathBuf>,
}
impl Workspace {
    pub fn open(root: &Path, mode: &str, access_context: &str) -> Result<Self> {
        if !matches!(mode, "live" | "sample") {
            return Err(Error::validation("Unknown workspace mode"));
        }
        let folder = if mode == "sample" {
            root.join("sample")
        } else {
            root.to_owned()
        };
        std::fs::create_dir_all(&folder)?;
        let db = Connection::open(folder.join("workspace.sqlite"))?;
        db.busy_timeout(Duration::from_secs(10))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        initialize(&db)?;
        db.execute(
            "ATTACH DATABASE ? AS checks",
            [folder.join("connections.sqlite").to_string_lossy().as_ref()],
        )?;
        let mut ws = Self {
            db,
            config: Value::Null,
            root: root.into(),
            mode: mode.into(),
            now: now(),
            access_context: access_context.into(),
            automations_directory: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
                .map(|p| p.join("automations")),
        };
        crate::connections::init(&ws)?;
        // Initialization and configuration loading share the same writer lock as mutations.
        ws.db.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            ws.reload_config()?;
            Ok(())
        })();
        match result {
            Ok(()) => ws.db.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = ws.db.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
        Ok(ws)
    }
    pub fn folder(&self) -> PathBuf {
        if self.mode == "sample" {
            self.root.join("sample")
        } else {
            self.root.clone()
        }
    }
    pub fn revision(&self) -> String {
        hash(&self.config)
    }
    pub fn reload_config(&mut self) -> Result<()> {
        let saved: Option<String> = self
            .db
            .query_row(
                "SELECT document_json FROM workspace_settings WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(saved) = saved {
            let mut config: Value = serde_json::from_str(&saved)?;
            for (key, table, filter) in [
                (
                    "searches",
                    "saved_searches",
                    " WHERE is_deleted=0 ORDER BY sort_order,id",
                ),
                (
                    "drafts",
                    "search_drafts",
                    " WHERE is_deleted=0 ORDER BY sort_order,id",
                ),
                (
                    "monitoring",
                    "search_monitoring",
                    " WHERE is_deleted=0 ORDER BY sort_order,search_id",
                ),
                (
                    "feedback",
                    "listing_feedback_events",
                    " ORDER BY sort_order,id",
                ),
            ] {
                config[key] = Value::Array(
                    self.documents(&format!("SELECT document_json FROM {table}{filter}"), [])?,
                );
            }
            let mut statement = self
                .db
                .prepare("SELECT kind,document_json FROM integration_observations")?;
            for row in
                statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (key, data) = row?;
                let value: Value = serde_json::from_str(&data)?;
                if !value.is_null() {
                    config[key] = value;
                }
            }
            self.config = validate_config(&config)?;
            drop(statement);
            self.upgrade_model_feedback()?;
        } else {
            let value = if self.mode == "sample" {
                contracts::data("example").clone()
            } else {
                json!({"origin":"Location not set","origin_confirmed":false,"browser_preference":"in_app","baseline_days":30,"minimum_peer_listings":3,"alert_policy":"first_qualification_and_lower_price","searches":[]})
            };
            self.config = validate_config(&value)?;
            self.save_config()?;
        }
        Ok(())
    }
    fn upgrade_model_feedback(&mut self) -> Result<()> {
        let pending: Vec<usize> = array(&self.config, "feedback")
            .iter()
            .enumerate()
            .filter(|(_, event)| {
                !bool_(event, "undone")
                    && event["rule"].is_null()
                    && event["exclude_model"] != false
                    && event["reason"] == "Not interested in this model"
            })
            .map(|(i, _)| i)
            .collect();
        if pending.is_empty() {
            return Ok(());
        }
        let provenance = if self.mode == "sample" {
            "synthetic"
        } else {
            "manual"
        };
        let listings = self.documents(
            "SELECT document_json FROM listings WHERE provenance=?",
            [provenance],
        )?;
        let mut changed = false;
        for i in pending {
            let event = &self.config["feedback"][i];
            let row = listings
                .iter()
                .find(|row| row["key"] == event["listing_key"]);
            let search = array(&self.config, "searches")
                .iter()
                .find(|search| search["id"] == event["search_id"]);
            if let (Some(row), Some(search)) = (row, search)
                && let Some(rule) = crate::configuration::model_exclusion_rule(row, search)
            {
                self.config["feedback"][i]["rule"] = rule;
                self.config["feedback"][i]["exclude_model"] = json!(true);
                changed = true;
            }
        }
        if changed {
            self.save_config()?
        }
        Ok(())
    }
    pub fn documents<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<Value>> {
        let mut statement = self.db.prepare(sql)?;
        let rows = statement.query_map(params, |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn revisions(&self) -> Result<Value> {
        let version: i64 = self
            .db
            .query_row(
                "SELECT entity_version FROM workspace_settings WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let mut out =
            json!({"settings":hash(&json!({"version":version})),"absent":hash(&Value::Null)});
        for (key, table, column) in [
            ("searches", "saved_searches", "id"),
            ("drafts", "search_drafts", "id"),
            ("monitoring", "search_monitoring", "search_id"),
            ("feedback", "listing_feedback_events", "id"),
        ] {
            let mut values = json!({});
            let mut stmt = self
                .db
                .prepare(&format!("SELECT {column},entity_version FROM {table}"))?;
            for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                let (id, version) = row?;
                values[&id] = json!(hash(&json!({"table":table,"id":id,"version":version})));
            }
            out[key] = values;
        }
        let mut stmt = self
            .db
            .prepare("SELECT kind,entity_version FROM integration_observations ORDER BY kind")?;
        let evidence: Vec<Value> = stmt
            .query_map([], |r| {
                Ok(json!({"kind":r.get::<_,String>(0)?,"entity_version":r.get::<_,i64>(1)?}))
            })?
            .collect::<std::result::Result<_, _>>()?;
        out["evidence"] = json!(hash(&json!(evidence)));
        Ok(out)
    }
    pub fn save_config(&mut self) -> Result<()> {
        self.config = validate_config(&self.config)?;
        let mut base = self.config.clone();
        for key in [
            "searches",
            "drafts",
            "monitoring",
            "feedback",
            "browser_access",
            "platform_sessions",
            "listing_contacts",
        ] {
            base.as_object_mut().unwrap().remove(key);
        }
        let old_base: Option<String> = self
            .db
            .query_row(
                "SELECT document_json FROM workspace_settings WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let base_changed = old_base
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()?
            .as_ref()
            != Some(&base);
        let base = serde_json::to_string(&base)?;
        if base_changed {
            self.db.execute("INSERT INTO workspace_settings VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json,entity_version=workspace_settings.entity_version+1 WHERE json(workspace_settings.document_json)<>json(excluded.document_json)",[base])?;
        }
        for (key, table, column) in [
            ("searches", "saved_searches", "id"),
            ("drafts", "search_drafts", "id"),
            ("monitoring", "search_monitoring", "search_id"),
            ("feedback", "listing_feedback_events", "id"),
        ] {
            for (index, item) in array(&self.config, key).iter().enumerate() {
                let id = text(item, column);
                let document = serde_json::to_string(item)?;
                let old: Option<(String, i64, i64)> = self
                    .db
                    .query_row(
                        &format!(
                            "SELECT document_json,entity_version,{} FROM {table} WHERE {column}=?",
                            if key == "feedback" { "0" } else { "is_deleted" }
                        ),
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                let version = if let Some((data, version, deleted)) = old {
                    version
                        + i64::from(serde_json::from_str::<Value>(&data)? != *item || deleted != 0)
                } else {
                    1
                };
                match key {
                    "searches" => {
                        self.db.execute("INSERT INTO saved_searches VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET entity_version=excluded.entity_version,name=excluded.name,product=excluded.product,enabled=excluded.enabled,is_deleted=0,sort_order=excluded.sort_order,document_json=excluded.document_json",params![id,version,text(item,"name"),text(item,"product"),bool_(item,"enabled"),index as i64,document])?;
                    }
                    "drafts" => {
                        self.db.execute("INSERT INTO search_drafts VALUES(?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET entity_version=excluded.entity_version,is_deleted=0,sort_order=excluded.sort_order,document_json=excluded.document_json",params![id,version,index as i64,document])?;
                    }
                    "monitoring" => {
                        self.db.execute("INSERT INTO search_monitoring VALUES(?,?,0,?,?,?) ON CONFLICT(search_id) DO UPDATE SET entity_version=excluded.entity_version,is_deleted=0,preference=excluded.preference,sort_order=excluded.sort_order,document_json=excluded.document_json",params![id,version,text(item,"preference"),index as i64,document])?;
                    }
                    _ => {
                        self.db.execute("INSERT INTO listing_feedback_events VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET entity_version=excluded.entity_version,undone=excluded.undone,sort_order=excluded.sort_order,document_json=excluded.document_json",params![id,text(item,"search_id"),version,bool_(item,"undone"),index as i64,document])?;
                    }
                }
            }
            if key != "feedback" {
                let ids: Vec<String> = self
                    .db
                    .prepare(&format!("SELECT {column} FROM {table} WHERE is_deleted=0"))?
                    .query_map([], |r| r.get(0))?
                    .collect::<std::result::Result<_, _>>()?;
                for id in ids {
                    if !array(&self.config, key)
                        .iter()
                        .any(|x| text(x, column) == id)
                    {
                        self.db.execute(&format!("UPDATE {table} SET is_deleted=1,entity_version=entity_version+1 WHERE {column}=?"),[id])?;
                    }
                }
            }
        }
        for key in ["browser_access", "platform_sessions", "listing_contacts"] {
            let previous: Option<String> = self
                .db
                .query_row(
                    "SELECT document_json FROM integration_observations WHERE kind=?",
                    [key],
                    |r| r.get(0),
                )
                .optional()?;
            if previous
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()?
                .as_ref()
                == Some(&self.config[key])
            {
                continue;
            }
            let value = serde_json::to_string(&self.config[key])?;
            self.db.execute("INSERT INTO integration_observations VALUES(?,1,?) ON CONFLICT(kind) DO UPDATE SET entity_version=integration_observations.entity_version+1,document_json=excluded.document_json WHERE integration_observations.document_json<>excluded.document_json",params![key,value])?;
        }
        Ok(())
    }
}
pub fn host_timezone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|zone| zone.parse::<chrono_tz::Tz>().is_ok())
        .or_else(|| iana_time_zone::get_timezone().ok())
        .unwrap_or_else(|| "UTC".into())
}
pub fn validate_config(input: &Value) -> Result<Value> {
    let mut value = contracts::parse("workspaceConfigurationSchema", input)?;
    if input["schedule"].get("quiet_hours").is_none() {
        value["schedule"]["quiet_hours"]["timezone"] = json!(host_timezone());
    }
    let search_id = regex::Regex::new(r"^[a-z0-9-]+$").expect("search ID pattern");
    for search in array(input, "searches") {
        if !search_id.is_match(text(search, "id")) {
            return Err(Error::validation(
                "Saved search IDs must use lowercase letters, numbers and hyphens",
            ));
        }
    }
    let searches: Vec<Value> = array(input, "searches")
        .iter()
        .map(crate::searches::normalize_search)
        .collect::<Result<_>>()?;
    value["searches"] = json!(searches);
    crate::searches::validate_quiet_hours(&value["schedule"]["quiet_hours"])?;
    crate::configuration::validate_location(&value["location"])?;
    for draft in value["drafts"].as_array_mut().unwrap() {
        *draft = crate::searches::normalize_draft(draft)?;
    }
    for key in ["searches", "drafts"] {
        let mut seen = HashSet::new();
        for item in array(&value, key) {
            if !seen.insert(text(item, "id")) {
                return Err(Error::validation(format!("{key} IDs must be unique")));
            }
        }
    }
    let mut monitoring = HashSet::new();
    for record in array(&value, "monitoring") {
        if !monitoring.insert(text(record, "search_id")) {
            return Err(Error::validation(
                "Monitoring preferences must be unique per search",
            ));
        }
        if record["timing"]["mode"] == "daily" {
            let times = array(&record["timing"], "times");
            if times
                .iter()
                .map(|x| x.as_str().unwrap_or(""))
                .collect::<HashSet<_>>()
                .len()
                != times.len()
            {
                return Err(Error::validation("Search times must be unique"));
            }
        }
        crate::searches::validate_zone(&record["schedule"]["timezone"])?;
    }
    let mut dispatchers = HashSet::new();
    let mut members = HashSet::new();
    for dispatcher in array(&value, "dispatchers") {
        if !dispatchers.insert(text(dispatcher, "id"))
            || array(dispatcher, "search_ids")
                .iter()
                .any(|id| !members.insert(id.as_str().unwrap_or("")))
        {
            return Err(Error::validation(
                "A search can belong to only one dispatcher",
            ));
        }
        if !dispatcher["schedule"].is_null()
            && dispatcher["schedule"]["thread_id"] != dispatcher["thread_id"]
        {
            return Err(Error::validation("Keep the original buying chat"));
        }
        crate::searches::validate_zone(&dispatcher["schedule"]["timezone"])?;
    }
    for event in array(&value, "feedback") {
        if event["exclude_model"] == true
            && (event["action"] != "dismiss" || text(event, "reason").is_empty())
        {
            return Err(Error::validation(
                "Model exclusion needs an explicit dismissal reason",
            ));
        }
        if !event["rule"].is_null() && text(event, "reason").is_empty() {
            return Err(Error::validation(
                "An explicit preference needs the buyer's original reason",
            ));
        }
    }
    Ok(value)
}
pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 4 {
            return Ok(());
        }
        if version == 0 {
            let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",[],|r|r.get(0))?;
            if exists {
                return Err(Error::validation(
                    "Unsupported workspace schema; use a canonical workspace database",
                ));
            }
            db.execute_batch(contracts::all()["schema_sql"].as_str().unwrap())?;
        } else if (1..=3).contains(&version) {
            db.execute_batch("CREATE TABLE IF NOT EXISTS journey_estimates(origin_key TEXT NOT NULL,destination_key TEXT NOT NULL,document_json TEXT NOT NULL CHECK(json_valid(document_json)),PRIMARY KEY(origin_key,destination_key));CREATE TABLE IF NOT EXISTS listing_search_discoveries(listing_key TEXT NOT NULL,search_id TEXT NOT NULL,run_id TEXT NOT NULL,run_started_at TEXT NOT NULL,recorded_at TEXT,PRIMARY KEY(listing_key,search_id));CREATE INDEX IF NOT EXISTS listing_discoveries_by_search ON listing_search_discoveries(search_id);CREATE TABLE IF NOT EXISTS listing_seen(listing_key TEXT NOT NULL,search_id TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(listing_key,search_id));CREATE INDEX IF NOT EXISTS listing_seen_by_search ON listing_seen(search_id);")?;
            if version<3 && db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_runs')",[],|r|r.get::<_,bool>(0))?{db.execute_batch("INSERT OR IGNORE INTO listing_search_discoveries SELECT found.value,runs.search_id,runs.id,json_extract(runs.document_json,'$.created_at'),NULL FROM search_runs AS runs,json_each(runs.document_json,'$.listing_keys') AS found WHERE found.type='text' AND julianday(json_extract(runs.document_json,'$.created_at')) IS NOT NULL ORDER BY julianday(json_extract(runs.document_json,'$.created_at')),runs.id;")?;}
        } else {
            return Err(Error::validation(
                "Unsupported workspace schema; use a canonical workspace database",
            ));
        }
        db.execute_batch("PRAGMA user_version=4")?;
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(e);
        }
    };
    Ok(())
}

pub fn device_browser() -> Value {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        #[link(name = "CoreServices", kind = "framework")]
        unsafe extern "C" {
            fn LSCopyDefaultHandlerForURLScheme(scheme: *const c_void) -> *const c_void;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            fn CFStringCreateWithCString(
                allocator: *const c_void,
                text: *const std::ffi::c_char,
                encoding: u32,
            ) -> *const c_void;
            fn CFStringGetCString(
                string: *const c_void,
                buffer: *mut std::ffi::c_char,
                size: isize,
                encoding: u32,
            ) -> bool;
            fn CFRelease(value: *const c_void);
        }
        // CoreServices returns retained references. No URL is opened and no browser is launched.
        unsafe {
            let scheme = CFStringCreateWithCString(std::ptr::null(), c"https".as_ptr(), 0x08000100);
            if scheme.is_null() {
                return Value::Null;
            }
            let handler = LSCopyDefaultHandlerForURLScheme(scheme);
            CFRelease(scheme);
            if handler.is_null() {
                return Value::Null;
            }
            let mut buffer = [0_i8; 1024];
            let success = CFStringGetCString(
                handler,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                0x08000100,
            );
            CFRelease(handler);
            if !success {
                return Value::Null;
            }
            let id = std::ffi::CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned();
            if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
                .unwrap()
                .is_match(&id)
            {
                return Value::Null;
            }
            let name = match id.as_str() {
                "com.apple.Safari" => "Safari",
                "com.google.Chrome" => "Google Chrome",
                "com.microsoft.edgemac" => "Microsoft Edge",
                "org.mozilla.firefox" => "Firefox",
                "company.thebrowser.Browser" => "Arc",
                _ => id.rsplit('.').next().unwrap_or("Browser"),
            };
            json!({"id":id,"name":name})
        }
    }
    #[cfg(not(target_os = "macos"))]
    Value::Null
}
