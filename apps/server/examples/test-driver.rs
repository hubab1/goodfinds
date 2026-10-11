//! Thin test transport: all behavior executes in the production Rust modules.
use goodfinds::{
    backup, contracts,
    error::{Error, Result},
    listings, searches, service, snapshot,
    storage::Workspace,
    util::*,
    workspace,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|v| v == "--serve") {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        std::fs::write(&args[2], listener.local_addr().unwrap().to_string()).unwrap();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut input = String::new();
            stream.read_to_string(&mut input).await.unwrap();
            let output = respond(&input).await;
            stream.write_all(output.as_bytes()).await.unwrap();
        }
    } else {
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        if args.get(1).is_some_and(|v| v == "--client") {
            let mut stream = std::net::TcpStream::connect(&args[2]).unwrap();
            stream.write_all(input.as_bytes()).unwrap();
            stream.shutdown(std::net::Shutdown::Write).unwrap();
            let mut output = String::new();
            stream.read_to_string(&mut output).unwrap();
            print!("{output}");
        } else {
            println!("{}", respond(&input).await);
        }
    }
}
async fn respond(input: &str) -> String {
    let result = match serde_json::from_str::<Value>(input) {
        Ok(request) => {
            *TEST_CONTEXT.lock().unwrap() = request.clone();
            execute(&request).await
        }
        Err(error) => Err(error.into()),
    };
    match result {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"error":error.details()}),
    }
    .to_string()
}
async fn execute(request: &Value) -> Result<Value> {
    let root = Path::new(request["root"].as_str().unwrap_or("."));
    let mode = request["mode"].as_str().unwrap_or("live");
    let context = request["context"].as_str().unwrap_or("native-tests");
    let args = &request["args"];
    let cancel = Arc::new(AtomicBool::new(false));
    match text(request, "op") {
        "measure_operation" => {
            let mut args = args.clone();
            args["mode"] = json!(mode);
            let (result, measurements) = goodfinds::diagnostics::capture(|| {
                workspace::execute(root, context, text(request, "action"), &args, cancel)
            });
            Ok(json!({"result":result?,"measurements":measurements}))
        }
        "operation" => {
            let mut args = args.clone();
            args["mode"] = json!(mode);
            workspace::execute(root, context, text(request, "action"), &args, cancel)
        }
        "tool" => service::call(root, context, text(request, "name"), args, cancel).await,
        "state_result" => Ok(service::state_result(args)),
        "config" => Ok(Workspace::open(root, mode, context)?.config),
        "save_config" => {
            let mut ws = Workspace::open(root, mode, context)?;
            ws.config = goodfinds::storage::validate_config(args)?;
            ws.save_config()?;
            Ok(ws.config)
        }
        "seed" => {
            let mut ws = Workspace::open(root, mode, context)?;
            if array(&ws.config, "searches").is_empty() {
                ws.config = goodfinds::storage::validate_config(args)?;
                ws.save_config()?;
            }
            Ok(Value::Null)
        }
        "snapshot" => {
            let mut ws = Workspace::open(root, mode, context)?;
            if let Some(now) = request["now"].as_i64() {
                ws.now = now;
            }
            snapshot::snapshot(&ws)
        }
        "initialize" => {
            let db = rusqlite::Connection::open(text(request, "path"))?;
            goodfinds::storage::initialize(&db)?;
            Ok(Value::Null)
        }
        "backup" => backup::backup_workspace(
            Path::new(text(args, "database")),
            Path::new(text(args, "output")),
        ),
        "restore" => backup::restore_workspace(
            Path::new(text(args, "input")),
            Path::new(text(args, "output")),
        ),
        "validate_config" => goodfinds::storage::validate_config(args),
        "parse" => contracts::parse(text(request, "schema"), args),
        "rule_hash" => Ok(json!(listings::rule_hash(&args["search"], &args["config"]))),
        "cache_images" => goodfinds::media::cache_files(root, args, false),
        "read_image" => goodfinds::media::read_image(root, text(args, "id")),
        "hash" => Ok(json!(hash(args))),
        "normalize" => listings::normalize(
            args,
            request["demo"] == true,
            request["now"].as_i64().unwrap_or_else(now),
        ),
        "normalize_observations" => Ok(json!(listings::normalize_observations(
            args,
            request["demo"] == true,
            request["now"].as_i64().unwrap_or_else(now)
        )?)),
        "native_question" => Ok(searches::native_question(
            &args["field"],
            args["custom"] == true,
        )),
        "native_answer" => {
            searches::native_answer(&args["field"], &args["content"], args["custom"] == true)
        }
        "criteria" => {
            let (rejected, uncertain, preferences) = searches::criteria(
                &args["row"],
                &args["search"],
                args["budget"] == true,
                args["now"].as_i64().unwrap_or_else(now),
            );
            Ok(json!({"rejected":rejected,"uncertain":uncertain,"preferences":preferences}))
        }
        "learned_criteria" => {
            let (rejected, uncertain, score) = searches::learned_criteria(
                &args["row"],
                &args["search"],
                &args["config"],
                args["budget"] == true,
            );
            Ok(json!({"rejected":rejected,"uncertain":uncertain,"score":score}))
        }
        "search_cohort" => Ok(json!(searches::search_cohort(
            &args["row"],
            &args["search"]
        ))),
        "evaluate_listing" => Ok(listings::evaluate_listing(
            &args["row"],
            array(args, "pool"),
            &args["search"],
            &args["config"],
            args["now"].as_i64().unwrap_or_else(now),
            args["demo"] == true,
        )),
        "match_listing" => {
            let (status, reasons) = listings::match_listing(
                &args["row"],
                &args["search"],
                &args["config"],
                args["now"].as_i64().unwrap_or_else(now),
                args["demo"] == true,
                args["budget"] == true,
            );
            Ok(json!({"status":status,"reasons":reasons}))
        }
        "evaluate" => goodfinds::cli::evaluate(
            &args["config"],
            &args["observations"],
            Path::new(text(request, "path")),
            mode == "sample",
            request["now"].as_i64().unwrap_or_else(now),
            &args["coverage"],
        ),
        _ => Err(Error::validation("Unknown test operation")),
    }
}
