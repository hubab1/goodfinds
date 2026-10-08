use goodfinds::{
    cli,
    error::{Error, Result},
};
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Could not complete the request: {error}");
        std::process::exit(2)
    }
    if goodfinds::shutdown::interrupted() {
        std::process::exit(130)
    }
}
async fn run() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.iter().any(|arg| arg == "--preview") {
        let port = std::env::var("GOODFINDS_PORT")
            .unwrap_or_else(|_| "0".into())
            .parse::<u16>()
            .map_err(|_| Error::validation("Use a valid preview port"))?;
        goodfinds::http::preview(cli::workspace_root()?, port).await
    } else if argv.first().is_some_and(|arg| arg == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        Ok(())
    } else if argv.first().is_some_and(|arg| {
        [
            "doctor", "call", "client", "demo", "export", "backup", "restore", "evaluate",
            "status", "ack", "--help",
        ]
        .contains(&arg.as_str())
    }) {
        if let Some(result) = cli::run(&argv).await? {
            println!("{}", serde_json::to_string_pretty(&result)?)
        }
        Ok(())
    } else {
        goodfinds::mcp::serve(cli::workspace_root()?).await
    }
}
