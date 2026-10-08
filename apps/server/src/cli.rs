//! Native maintenance commands and persistent MCP fallback entry points.
use crate::{
    backup, contracts,
    error::{Error, Result},
    listings,
    storage::{self, Workspace},
    util,
};
use rusqlite::{Connection, MAIN_DB};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
const HELP: &str = "Goodfinds: doctor | call TOOL --input FILE | client (JSON lines: name, arguments) | backup --db FILE --output NEW_DIR | restore --input BACKUP_DIR --output NEW_DIR | demo --output DIR [--workspace FILE] | export --db FILE --output FILE | evaluate --workspace FILE --observations FILE --db FILE [--report FILE] [--search-coverage FILE] | status --db FILE | ack --db FILE --ids ID [ID...]\n";
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
pub fn workspace_root() -> Result<PathBuf> {
    if let Some(root) = std::env::var_os("GOODFINDS_WORKSPACE_DIR").filter(|s| !s.is_empty()) {
        return absolute(Path::new(&root));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| Error::validation("Set GOODFINDS_WORKSPACE_DIR or a home directory"))?;
    Ok(PathBuf::from(home).join(".local/share/goodfinds"))
}
fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}
fn open_database(path: &Path, mode: &str, configuration: Option<&Value>) -> Result<Workspace> {
    let path = absolute(path)?;
    let root = path
        .parent()
        .ok_or_else(|| Error::validation("Choose a database path"))?
        .to_owned();
    fs::create_dir_all(&root)?;
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(10))?;
    storage::initialize(&db)?;
    let mut ws = Workspace {
        db,
        root,
        mode: mode.into(),
        now: util::now(),
        config: Value::Null,
        access_context: util::id(),
        automations_directory: None,
    };
    if let Some(config) = configuration {
        ws.config = storage::validate_config(config)?
    } else {
        ws.db.execute_batch("BEGIN IMMEDIATE")?;
        let result = ws.reload_config();
        match result {
            Ok(()) => ws.db.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = ws.db.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(ws)
}
fn transaction<T>(ws: &mut Workspace, work: impl FnOnce(&mut Workspace) -> Result<T>) -> Result<T> {
    ws.db.execute_batch("BEGIN IMMEDIATE")?;
    match work(ws) {
        Ok(result) => {
            ws.db.execute_batch("COMMIT")?;
            Ok(result)
        }
        Err(e) => {
            let _ = ws.db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
pub fn evaluate(
    configuration: &Value,
    observations: &Value,
    database: &Path,
    sample: bool,
    now: i64,
    coverage: &Value,
) -> Result<Value> {
    let mut ws = open_database(
        database,
        if sample { "sample" } else { "live" },
        Some(configuration),
    )?;
    ws.now = now;
    transaction(&mut ws, |ws| listings::evaluate(ws, observations, coverage))
}
pub fn status(database: &Path) -> Result<Value> {
    let ws = open_database(database, "live", None)?;
    let count: i64 = ws
        .db
        .query_row("SELECT COUNT(*) FROM listing_evaluations", [], |r| r.get(0))?;
    let mut q=ws.db.prepare("SELECT listing_key,provenance,document_json,first_observed_at,last_observed_at FROM listings")?;
    let mut rows = vec![];
    for raw in q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })? {
        let (key, provenance, data, first, last) = raw?;
        rows.push(json!({"key":key,"provenance":provenance,"data":serde_json::from_str::<Value>(&data)?,"first_observed_at":first,"last_observed_at":last}))
    }
    let pending = ws.documents(
        "SELECT alert_json FROM deal_alerts WHERE status='pending'",
        [],
    )?;
    Ok(json!({"listing_evaluations":count,"listings":rows,"pending_alerts":pending}))
}
pub fn acknowledge(database: &Path, ids: &[String]) -> Result<Value> {
    if ids.is_empty() {
        return Err(Error::validation("--ids is required"));
    }
    let mut ws = open_database(database, "live", None)?;
    let count = transaction(&mut ws, |ws| listings::acknowledge(ws, ids))?;
    Ok(json!({"acknowledged":count}))
}
fn escape(v: &Value) -> String {
    let value = if let Some(s) = v.as_str() {
        s.to_owned()
    } else if v.is_null() {
        String::new()
    } else {
        v.to_string()
    };
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}
fn money(value: &Value, currency: &Value) -> String {
    value
        .as_f64()
        .map(|n| {
            crate::sellers::currency_text(n.round() as i64, currency.as_str().unwrap_or("GBP"))
        })
        .unwrap_or_else(|| "Unknown price".into())
}

pub fn render_report(result: &Value, path: &Path) -> Result<()> {
    let mut rows = String::new();
    for group in arr(&result["searches"]) {
        rows.push_str(&format!("<section><h2>{}</h2><table><thead><tr><th>Listing</th><th>Asking price</th><th>Peer average</th><th>Decision</th></tr></thead><tbody>",escape(&group["search"]["name"])));
        let mut decisions = arr(&group["decisions"]).to_vec();
        decisions.sort_by(|a, b| {
            a["listing"]["price_minor"]
                .as_f64()
                .unwrap_or(f64::INFINITY)
                .total_cmp(
                    &b["listing"]["price_minor"]
                        .as_f64()
                        .unwrap_or(f64::INFINITY),
                )
        });
        for d in decisions {
            let row = &d["listing"];
            let price = money(&row["price_minor"], &row["currency"]);
            let average = if d["reference_average_minor"].is_null() {
                "—".into()
            } else {
                money(&d["reference_average_minor"], &row["currency"])
            };
            let reasons = arr(&d["reasons"])
                .iter()
                .map(s)
                .collect::<Vec<_>>()
                .join("; ");
            rows.push_str(&format!("<tr><td><a href=\"{}\">{}</a><small>{}</small></td><td>{}</td><td>{}<small>{} peers</small></td><td>{}<small>{}</small></td></tr>",escape(&row["url"]),escape(&row["title"]),escape(&row["description"]),escape(&json!(price)),escape(&json!(average)),d["peer_count"].as_u64().unwrap_or(0),escape(&d["status"]),escape(&json!(reasons))));
        }
        rows.push_str("</tbody></table></section>");
    }
    let mut cards = String::new();
    for a in arr(&result["new_alerts"]) {
        cards.push_str(&format!("<article><small>{} · {}</small><h3><a href=\"{}\">{}</a></h3><strong>{}</strong><p>{}% below {} average of {} peers.</p></article>",escape(&a["search_name"]),escape(&json!(s(&a["kind"]).replace('_'," "))),escape(&a["listing"]["url"]),escape(&a["listing"]["title"]),escape(&json!(money(&a["listing"]["price_minor"],&a["listing"]["currency"]))),escape(&a["percent_below_average"]),escape(&json!(money(&a["reference_average_minor"],&a["listing"]["currency"]))),escape(&a["peer_count"])))
    }
    if cards.is_empty() {
        cards.push_str("<p>No new alerts. Unchanged listings do not create another alert.</p>")
    }
    let notice = if result["mode"] == "synthetic" {
        "Synthetic demonstration. Listings, sellers, prices and journey times are invented. No Facebook searches or notifications have been sent."
    } else {
        "Manually imported observations. This report does not perform browser searches or deliver notifications."
    };
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Goodfinds · Saved search preview</title><style>*{{box-sizing:border-box}}body{{margin:0;background:#f5f5ef;color:#20372d;font:16px system-ui,sans-serif}}main{{max-width:1160px;margin:auto;padding:36px 24px}}h1{{font-size:40px}}section,article{{background:white;border:1px solid #e2e5da;border-radius:16px;padding:24px;margin:16px 0}}table{{border-collapse:collapse;width:100%;text-align:left}}th,td{{padding:14px;border-bottom:1px solid #eceee7;vertical-align:top}}small{{display:block;color:#607064;margin-top:6px}}a{{color:#244c3b}}strong{{font-size:28px}}.notice{{background:#fff3da;padding:18px;border-radius:12px}}section{{overflow:auto}}table{{min-width:650px}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}}</style></head><body><main><h1>Your next good deal.</h1><p>{} · {} listings observed · {} awaiting delivery</p><p class="notice">{notice}</p><h2>New alert previews</h2><div class="cards">{cards}</div>{rows}<footer>Average = arithmetic mean of distinct, equivalent observed listings, excluding the candidate. Asking prices are not completed sale prices. Run: {}</footer></main></body></html>"#,
        escape(&result["origin"]),
        escape(&result["observed_count"]),
        arr(&result["pending_alerts"]).len(),
        escape(&result["evaluated_at"])
    );
    write(path, html.as_bytes())
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn demo(output: &Path, configuration: Option<&Path>) -> Result<Value> {
    let output = absolute(output)?;
    fs::create_dir_all(&output)?;
    let config = configuration
        .map(read_json)
        .transpose()?
        .unwrap_or_else(|| contracts::data("example").clone());
    let normalized = storage::validate_config(&config)?;
    let now = util::now();
    let mut rows: Value = serde_json::from_str(include_str!(
        "../../../skills/marketplace-shopping/assets/demo-listings.json"
    ))?;
    for row in rows
        .as_array_mut()
        .ok_or_else(|| Error::validation("Invalid demo listings"))?
    {
        row["drive_origin"] = normalized["origin"].clone();
        row["travel_checked_at"] = json!(util::iso(now));
    }
    let temporary = Temporary(std::env::temp_dir().join(format!("goodfinds-demo-{}", util::id())));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&temporary.0)?;
    let database = temporary.0.join("workspace.sqlite");
    let first = evaluate(&config, &rows, &database, true, now, &Value::Null)?;
    let second = evaluate(&config, &rows, &database, true, now + 60_000, &Value::Null)?;
    let first_report = output.join("first-run.html");
    let second_report = output.join("second-run.html");
    render_report(&first, &first_report)?;
    render_report(&second, &second_report)?;
    write(
        &output.join("results.json"),
        &serde_json::to_vec_pretty(&json!({"first":first,"second":second}))?,
    )?;
    let db = Connection::open(&database)?;
    db.backup(MAIN_DB, output.join("demo.sqlite"), None)?;
    Ok(
        json!({"mode":"synthetic","first_run_new_alerts":arr(&first["new_alerts"]).len(),"second_run_new_alerts":arr(&second["new_alerts"]).len(),"pending_delivery":arr(&second["pending_alerts"]).len(),"first_report":first_report,"second_report":second_report}),
    )
}
#[derive(Default)]
struct Options {
    values: HashMap<String, String>,
    ids: Vec<String>,
    positionals: Vec<String>,
    help: bool,
}
impl Options {
    fn parse(argv: &[String]) -> Result<Self> {
        let mut parsed = Self::default();
        let mut i = 0;
        while i < argv.len() {
            let arg = &argv[i];
            if arg == "--help" {
                parsed.help = true
            } else if arg == "--" {
                parsed.positionals.extend_from_slice(&argv[i + 1..]);
                break;
            } else if let Some(stripped) = arg.strip_prefix("--") {
                let (name, inline) = stripped
                    .split_once('=')
                    .map(|(a, b)| (a, Some(b)))
                    .unwrap_or((stripped, None));
                if ![
                    "output",
                    "workspace",
                    "observations",
                    "db",
                    "report",
                    "search-coverage",
                    "ids",
                    "input",
                ]
                .contains(&name)
                {
                    return Err(Error::validation(format!("Unknown option --{name}")));
                }
                let value = if let Some(value) = inline {
                    value.to_string()
                } else {
                    i += 1;
                    argv.get(i)
                        .filter(|v| !v.starts_with("--"))
                        .cloned()
                        .ok_or_else(|| Error::validation(format!("--{name} needs a value")))?
                };
                if name == "ids" {
                    parsed.ids.push(value)
                } else {
                    parsed.values.insert(name.to_string(), value);
                }
            } else if arg.starts_with('-') {
                return Err(Error::validation(format!("Unknown option {arg}")));
            } else {
                parsed.positionals.push(arg.clone())
            }
            i += 1;
        }
        Ok(parsed)
    }
    fn required(&self, name: &str) -> Result<&Path> {
        self.values
            .get(name)
            .map(Path::new)
            .ok_or_else(|| Error::validation(format!("--{name} is required")))
    }
    fn path(&self, name: &str) -> Option<&Path> {
        self.values.get(name).map(Path::new)
    }
}
pub async fn run(argv: &[String]) -> Result<Option<Value>> {
    let options = Options::parse(argv)?;
    if options.help {
        print!("{HELP}");
        return Ok(None);
    }
    let command = options
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or("");
    let result = match command {
        "doctor" | "call" | "client" => {
            return crate::mcp::protocol_cli(
                command,
                options.positionals.get(1).map(String::as_str),
                options.path("input"),
            )
            .await;
        }
        "backup" => backup::backup_workspace(options.required("db")?, options.required("output")?)?,
        "restore" => {
            backup::restore_workspace(options.required("input")?, options.required("output")?)?
        }
        "export" => backup::export_workspace(options.required("db")?, options.required("output")?)?,
        "demo" => demo(options.required("output")?, options.path("workspace"))?,
        "evaluate" => {
            let config = read_json(options.required("workspace")?)?;
            let observations = read_json(options.required("observations")?)?;
            let coverage = options
                .path("search-coverage")
                .map(read_json)
                .transpose()?
                .unwrap_or(Value::Null);
            let result = evaluate(
                &config,
                &observations,
                options.required("db")?,
                false,
                util::now(),
                &coverage,
            )?;
            if let Some(path) = options.path("report") {
                render_report(&result, path)?
            }
            result
        }
        "status" => status(options.required("db")?)?,
        "ack" => {
            let mut ids = options.ids.clone();
            ids.extend_from_slice(&options.positionals[1..]);
            acknowledge(options.required("db")?, &ids)?
        }
        _ => {
            return Err(Error::validation(
                "Choose doctor, call, client, backup, restore, demo, export, evaluate, status or ack (use --help for usage)",
            ));
        }
    };
    Ok(Some(result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argument_parser_preserves_repeated_ack_ids_and_rejects_unknown_flags() {
        let args = [
            "ack",
            "--db",
            "database.sqlite",
            "--ids",
            "one",
            "--ids=two",
            "three",
        ]
        .map(String::from);
        let parsed = Options::parse(&args).unwrap();
        assert_eq!(parsed.ids, ["one", "two"]);
        assert_eq!(parsed.positionals, ["ack", "three"]);
        assert!(Options::parse(&["--unknown".into()]).is_err());
        assert!(Options::parse(&["--db".into()]).is_err())
    }
    #[test]
    fn demo_outputs_html_and_persistent_database_without_duplicate_alerts() {
        let dir = tempfile::tempdir().unwrap();
        let result = demo(dir.path(), None).unwrap();
        assert_eq!(result["mode"], "synthetic");
        assert_eq!(result["second_run_new_alerts"], 0);
        assert!(dir.path().join("first-run.html").is_file());
        let state = status(&dir.path().join("demo.sqlite")).unwrap();
        assert_eq!(state["listing_evaluations"], 2);
        assert!(!arr(&state["listings"]).is_empty());
        let report = fs::read_to_string(dir.path().join("first-run.html")).unwrap();
        assert!(report.contains("Synthetic demonstration"));
        assert!(report.contains("<table>"));
    }
    #[test]
    fn report_escapes_untrusted_observation_text() {
        let dir = tempfile::tempdir().unwrap();
        let result = json!({"origin":"<script>bad</script>","observed_count":1,"evaluated_at":"now","new_alerts":[],"pending_alerts":[],"searches":[{"search":{"name":"<bad>"},"decisions":[{"listing":{"title":"<img src=x onerror=bad>","description":"<script>bad</script>","url":"https://example.com/?x=\"bad\"","price_minor":1000,"currency":"GBP"},"status":"qualifies","reasons":["<unsafe>"],"peer_count":2}]}]});
        let path = dir.path().join("report.html");
        render_report(&result, &path).unwrap();
        let html = fs::read_to_string(path).unwrap();
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img"));
        assert!(html.contains("&lt;unsafe&gt;"));
    }
}
