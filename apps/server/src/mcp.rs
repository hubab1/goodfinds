//! Standard MCP SDK transport; the executable uses no JavaScript runtime.
use crate::{
    contracts,
    error::{Error, Result},
    searches, service,
    storage::Workspace,
    util::id,
};
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ClientCapabilities, ClientConfig,
        ElicitRequestParams, Implementation, ListResourcesResult, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams, ReadResourceResponse,
        ReadResourceResult, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
};
use serde_json::{Value, json};
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[derive(Clone)]
pub struct NativeServer {
    root: PathBuf,
    access_context: String,
}
impl NativeServer {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            access_context: id(),
        }
    }
    async fn interview(
        &self,
        args: &Value,
        context: &RequestContext<RoleServer>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Value> {
        let mode = args["mode"].as_str().unwrap_or("live").to_owned();
        let root = self.root.clone();
        let access = self.access_context.clone();
        let input = args.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            let ws = Workspace::open(&root, &mode, &access)?;
            searches::prepare_interview(&ws, &input)
        })
        .await
        .map_err(|e| Error::new("transport_error", e.to_string()))??;
        if cancel.load(Ordering::SeqCst) {
            return Err(Error::new("transport_error", "The request was cancelled"));
        }
        let field = &prepared["field"];
        let mut action = String::new();
        let mut content = Value::Null;
        let mut custom = false;
        if !field.is_null() {
            let capabilities = context
                .client_capabilities()
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or(Value::Null);
            let elicitation = &capabilities["elicitation"];
            let supported = elicitation.is_object()
                && (elicitation.get("form").is_some()
                    || elicitation.as_object().is_some_and(|v| v.is_empty()));
            if !supported {
                action = "unsupported".into()
            } else {
                let params: ElicitRequestParams =
                    serde_json::from_value(searches::native_question(field, false))?;
                let reply = context
                    .peer
                    .create_elicitation(params)
                    .await
                    .map_err(|e| Error::new("transport_error", e.to_string()))?;
                let reply = serde_json::to_value(reply)?;
                action = reply["action"].as_str().unwrap_or("decline").into();
                content = reply["content"].clone();
                if action == "accept" && content[field["id"].as_str().unwrap_or("")] == "__custom__"
                {
                    custom = true;
                    let params: ElicitRequestParams =
                        serde_json::from_value(searches::native_question(field, true))?;
                    let reply = context
                        .peer
                        .create_elicitation(params)
                        .await
                        .map_err(|e| Error::new("transport_error", e.to_string()))?;
                    let reply = serde_json::to_value(reply)?;
                    action = reply["action"].as_str().unwrap_or("decline").into();
                    content = reply["content"].clone();
                }
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(Error::new("transport_error", "The request was cancelled"));
        }
        let applied = searches::apply_interview(&prepared, &action, &content, custom)?;
        let mode = args["mode"].as_str().unwrap_or("live");
        let mut result = if applied["draft"].is_null() {
            service::call(
                &self.root,
                &self.access_context,
                "get_goodfinds_workspace",
                &json!({"mode":mode}),
                cancel,
            )
            .await?
        } else {
            service::call(&self.root,&self.access_context,"save_goodfinds_search_draft",&json!({"mode":mode,"request_id":id(),"expected_entity_revision":prepared["expected_entity_revision"],"draft":applied["draft"]}),cancel).await?
        };
        if result["isError"] != true {
            result = service::state_result(
                &json!({"state":result["_meta"]["goodfinds_state"],"interview":applied["interview"]}),
            );
        }
        Ok(result)
    }
}
/// Dropping a cancelled handler also fences any blocking SQLite task still winding down.
struct RequestCancellation {
    flag: Arc<AtomicBool>,
    watcher: tokio::task::JoinHandle<()>,
}
impl RequestCancellation {
    fn new(context: &RequestContext<RoleServer>) -> Self {
        let flag = Arc::new(AtomicBool::new(context.ct.is_cancelled()));
        let captured = flag.clone();
        let token = context.ct.clone();
        let watcher = tokio::spawn(async move {
            token.cancelled().await;
            captured.store(true, Ordering::SeqCst);
        });
        Self { flag, watcher }
    }
}
impl Drop for RequestCancellation {
    fn drop(&mut self) {
        self.flag.store(true, Ordering::SeqCst);
        self.watcher.abort();
    }
}
fn protocol_error(error: impl std::fmt::Display) -> ErrorData {
    ErrorData::internal_error(error.to_string(), None)
}
fn tool_error(error: Error) -> CallToolResponse {
    serde_json::from_value::<CallToolResult>(service::error_result(&error))
        .expect("tool error contract")
        .into()
}

impl ServerHandler for NativeServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
        .with_server_info(Implementation::new("Goodfinds", env!("CARGO_PKG_VERSION")))
        .with_instructions(contracts::all()["instructions"].as_str().unwrap_or(""))
    }
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(ProtocolVersion::known_up_to(&ProtocolVersion::V_2025_11_25))
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        contracts::all()["tools"]
            .as_array()?
            .iter()
            .find(|t| t["name"] == name)
            .and_then(|t| serde_json::from_value(t.clone()).ok())
    }
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        serde_json::from_value(json!({"tools":contracts::all()["tools"]})).map_err(protocol_error)
    }
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, ErrorData> {
        serde_json::from_value(json!({"resources":contracts::all()["resources"]}))
            .map_err(protocol_error)
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, ErrorData> {
        let value = service::resource(&request.uri).map_err(protocol_error)?;
        serde_json::from_value::<ReadResourceResult>(value)
            .map(Into::into)
            .map_err(protocol_error)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let cancellation = RequestCancellation::new(&context);
        let args = Value::Object(request.arguments.unwrap_or_default());
        let flag = cancellation.flag.clone();
        let result = tokio::select! {
            _=context.ct.cancelled()=>{flag.store(true,Ordering::SeqCst);Err(Error::new("transport_error","The request was cancelled"))},
            result=async {if request.name=="ask_goodfinds_search_question"{self.interview(&args,&context,flag.clone()).await}else{service::call(&self.root,&self.access_context,&request.name,&args,flag.clone()).await}}=>result,
        };
        match result {
            Ok(value) => serde_json::from_value::<CallToolResult>(value)
                .map(Into::into)
                .map_err(protocol_error),
            Err(error) => Ok(tool_error(error)),
        }
    }
}
pub(crate) fn close_workspaces(root: &Path, access_context: &str) -> Result<()> {
    for mode in ["live", "sample"] {
        let folder = if mode == "sample" {
            root.join("sample")
        } else {
            root.to_owned()
        };
        if !folder.join("workspace.sqlite").is_file()
            || !folder.join("connections.sqlite").is_file()
        {
            continue;
        }
        let db = rusqlite::Connection::open_with_flags(
            folder.join("workspace.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute(
            "ATTACH DATABASE ? AS checks",
            [folder.join("connections.sqlite").to_string_lossy().as_ref()],
        )?;
        let ws = Workspace {
            db,
            config: Value::Null,
            root: root.into(),
            mode: mode.into(),
            now: crate::util::now(),
            access_context: access_context.into(),
            automations_directory: None,
        };
        ws.db.execute_batch("BEGIN IMMEDIATE")?;
        match crate::connections::close(&ws) {
            Ok(()) => {
                ws.db.execute_batch("COMMIT")?;
            }
            Err(error) => {
                let _ = ws.db.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    Ok(())
}
pub async fn serve(root: PathBuf) -> Result<()> {
    let server = NativeServer::new(root.clone());
    let access_context = server.access_context.clone();
    let signal = crate::shutdown::signal();
    tokio::pin!(signal);
    let initialized = tokio::select! {result=server.serve(rmcp::transport::stdio())=>Some(result),result=&mut signal=>{result?;None}};
    let result = match initialized {
        None => Ok(()),
        Some(Ok(running)) => {
            let token = running.cancellation_token();
            let waiting = running.waiting();
            tokio::pin!(waiting);
            let result = tokio::select! {result=&mut waiting=>result,result=&mut signal=>{result?;token.cancel();waiting.await}};
            result
                .map(|_| ())
                .map_err(|e| Error::new("transport_error", e.to_string()))
        }
        Some(Err(
            rmcp::service::ServerInitializeError::ExpectedInitializeRequest(None)
            | rmcp::service::ServerInitializeError::ConnectionClosed(_),
        )) => Ok(()),
        Some(Err(error)) => Err(Error::new("transport_error", error.to_string())),
    };
    crate::http::shutdown_location().await;
    let cleanup = tokio::task::spawn_blocking(move || close_workspaces(&root, &access_context))
        .await
        .map_err(|e| Error::new("transport_error", e.to_string()))?;
    result.and(cleanup)
}

fn compact(result: CallToolResult) -> Value {
    let mut out = json!({"content":result.content});
    if let Some(value) = result.structured_content {
        out["structuredContent"] = value;
    }
    if let Some(value) = result.is_error {
        out["isError"] = json!(value)
    }
    out
}
/// The fallback helper uses one standard MCP session and one access identity per process.
pub async fn protocol_cli(
    command: &str,
    tool: Option<&str>,
    input: Option<&Path>,
) -> Result<Option<Value>> {
    let executable = std::env::current_exe()?;
    let mut process = Command::new(executable);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .env_clear();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "CODEX_HOME",
        "GOODFINDS_WORKSPACE_DIR",
        "GOODFINDS_EBAY_CLIENT_ID",
        "GOODFINDS_EBAY_CLIENT_SECRET",
    ] {
        if let Some(value) = std::env::var_os(key) {
            process.env(key, value);
        }
    }
    let mut child = process.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::new("transport_error", "Missing MCP stdout"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::new("transport_error", "Missing MCP stdin"))?;
    let info = ClientConfig::new(
        ClientCapabilities::default(),
        Implementation::new("Goodfinds protocol helper", env!("CARGO_PKG_VERSION")),
    )
    .with_protocol_version(ProtocolVersion::V_2025_11_25);
    let client = info
        .serve((stdout, stdin))
        .await
        .map_err(|e| Error::new("transport_error", e.to_string()))?;
    let result:Result<Option<Value>>=async{
        if command=="doctor"{let listed=client.list_all_tools().await.map_err(|e|Error::new("transport_error",e.to_string()))?;let metadata=listed.iter().find(|t|t.name=="open_goodfinds_panel").ok_or_else(||Error::validation("The Goodfinds panel tool was not advertised"))?;let metadata=serde_json::to_value(metadata)?;let uri=metadata["_meta"]["ui"]["resourceUri"].as_str().ok_or_else(||Error::validation("The Goodfinds panel resource was not advertised"))?;let resource=client.read_resource(ReadResourceRequestParams::new(uri)).await.map_err(|e|Error::new("transport_error",e.to_string()))?;let context=client.call_tool(CallToolRequestParams::new("get_goodfinds_search_context").with_arguments(serde_json::Map::new())).await.map_err(|e|Error::new("transport_error",e.to_string()))?;if context.is_error==Some(true){return Err(Error::validation("Goodfinds context could not be read"))}
            return Ok(Some(json!({"status":"ready","tools":listed.len(),"panel_resource":!resource.contents.is_empty(),"context_readable":true,"native_questions":"Host-dependent; helper uses the resumable chat fallback","next_step":"If tools are missing in Codex, check the plugin MCP connection and open a fresh chat after installation. Use client for a persistent fallback session."})))
        }
        if command=="call"{let(name,path)=tool.zip(input).ok_or_else(||Error::validation("Use call TOOL --input FILE"))?;let text=tokio::fs::read_to_string(path).await?;let args:Value=serde_json::from_str(&text)?;let object=args.as_object().ok_or_else(||Error::validation("Tool arguments must be an object"))?.clone();let result=client.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(object)).await.map_err(|e|Error::new("transport_error",e.to_string()))?;return Ok(Some(compact(result)))}
        if command!="client"{return Err(Error::validation("Choose doctor, call, or client"))}
        let mut lines=BufReader::new(tokio::io::stdin()).lines();let mut output=tokio::io::stdout();while let Some(line)=lines.next_line().await?{if line.trim().is_empty(){continue}
            let reply:Result<Value>=async{let value:Value=serde_json::from_str(&line)?;let object=value.as_object().ok_or_else(||Error::validation("A request must be an object"))?;if object.keys().any(|k|!["name","arguments"].contains(&k.as_str())){return Err(Error::validation("Unknown request field"))}let name=value["name"].as_str().filter(|s|!s.is_empty()).ok_or_else(||Error::validation("Choose a tool name"))?;let args=if value.get("arguments").is_none(){serde_json::Map::new()}else{value["arguments"].as_object().ok_or_else(||Error::validation("Tool arguments must be an object"))?.clone()};let result=client.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(args)).await.map_err(|e|Error::new("transport_error",e.to_string()))?;Ok(compact(result))}.await;
            let reply=reply.unwrap_or_else(|e|json!({"isError":true,"error":e.message}));let mut bytes=serde_json::to_vec(&reply)?;bytes.push(b'\n');output.write_all(&bytes).await?;output.flush().await?;
        }Ok(None)
    }.await;
    let _ = client.cancel().await;
    let _ = child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::{
        ClientHandler, RoleClient,
        model::{ElicitResult, ElicitationAction},
    };
    use std::{collections::VecDeque, sync::Mutex};
    #[derive(Clone)]
    struct InterviewClient {
        replies: Arc<Mutex<VecDeque<Value>>>,
        asked: Arc<Mutex<Vec<Value>>>,
    }
    impl ClientHandler for InterviewClient {
        fn get_info(&self) -> ClientConfig {
            serde_json::from_value(json!({"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{}}},"clientInfo":{"name":"Native interview test","version":"0.1.0"}})).unwrap()
        }
        async fn create_elicitation(
            &self,
            params: ElicitRequestParams,
            _context: RequestContext<RoleClient>,
        ) -> std::result::Result<ElicitResult, ErrorData> {
            self.asked
                .lock()
                .unwrap()
                .push(serde_json::to_value(params).unwrap());
            let content = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ErrorData::internal_error("Unexpected extra question", None))?;
            Ok(ElicitResult::new(ElicitationAction::Accept).with_content(content))
        }
    }
    fn seed_draft(root: &Path) {
        let mut ws = Workspace::open(root, "live", "fixture").unwrap();
        let mut draft=searches::normalize_draft(&json!({"name":"Camera","definition":{"schema_version":1,"version":1,"category":"camera","title":"Camera","description":"A fictional camera search","price":{"currency":"GBP","period":"once"},"comparison_attributes":["model"],"fields":[{"id":"budget","label":"Budget","type":"integer","required":true,"display_divisor":100,"allow_unsure":true,"minimum":1,"match":{"attribute":"price_minor","operator":"lte"}}]},"values":{}})).unwrap();
        draft["id"] = json!("draft-camera");
        ws.config["drafts"] = json!([draft]);
        ws.save_config().unwrap();
    }
    #[test]
    fn shutdown_interrupts_owned_checks_without_creating_unused_workspaces() {
        let root = tempfile::tempdir().unwrap();
        close_workspaces(root.path(), "shutdown-test").unwrap();
        assert!(!root.path().join("workspace.sqlite").exists());
        let run = {
            let mut ws = Workspace::open(root.path(), "live", "shutdown-test").unwrap();
            let revision = ws.revisions().unwrap()["settings"].clone();
            crate::connections::command(
                &mut ws,
                "start",
                &json!({"mode":"live","expected_entity_revision":revision,"request_id":crate::util::id(),"marketplaces":["ebay"]}),
            ).unwrap()["run"].clone()
        };
        close_workspaces(root.path(), "shutdown-test").unwrap();
        let mut ws = Workspace::open(root.path(), "live", "shutdown-test").unwrap();
        let after =
            crate::connections::command(&mut ws, "read", &json!({"run_id":run["id"]})).unwrap();
        assert_eq!(after["run"]["status"], "interrupted");
        assert!(!root.path().join("sample").exists());
    }
    #[tokio::test]
    async fn sdk_transport_lists_metadata_reads_resource_and_returns_tool_errors() {
        let root = tempfile::tempdir().unwrap();
        let (server_io, client_io) = tokio::io::duplex(1024 * 1024);
        let server = NativeServer::new(root.path().into());
        let started = tokio::spawn(async move { server.serve(server_io).await.unwrap() });
        let info = ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("Native protocol test", "0.1.0"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25);
        let client = info.serve(client_io).await.unwrap();
        let server = started.await.unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert_eq!(
            tools.len(),
            contracts::all()["tools"].as_array().unwrap().len()
        );
        let panel = tools
            .iter()
            .find(|t| t.name == "open_goodfinds_panel")
            .unwrap();
        let metadata = serde_json::to_value(panel).unwrap();
        let uri = metadata["_meta"]["ui"]["resourceUri"].as_str().unwrap();
        let resource = client
            .read_resource(ReadResourceRequestParams::new(uri))
            .await
            .unwrap();
        assert_eq!(resource.contents.len(), 1);
        let context = client
            .call_tool(CallToolRequestParams::new("get_goodfinds_search_context"))
            .await
            .unwrap();
        assert_ne!(context.is_error, Some(true));
        assert_eq!(context.structured_content.unwrap()["searches"], json!([]));
        let error = client
            .call_tool(
                CallToolRequestParams::new("get_goodfinds_search_context")
                    .with_arguments(json!({"search_id":"missing"}).as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_eq!(error.is_error, Some(true));
        let error = error.structured_content.unwrap();
        assert!(error["error"]["code"].is_string());
        assert!(error["error"]["message"].is_string());
        client.cancel().await.unwrap();
        server.waiting().await.unwrap();
    }
    #[tokio::test]
    async fn native_elicitation_round_trip_saves_minor_units_and_full_ui_metadata() {
        let root = tempfile::tempdir().unwrap();
        seed_draft(root.path());
        let (server_io, client_io) = tokio::io::duplex(1024 * 1024);
        let server = NativeServer::new(root.path().into());
        let started = tokio::spawn(async move { server.serve(server_io).await.unwrap() });
        let handler = InterviewClient {
            replies: Arc::new(Mutex::new(VecDeque::from([
                json!({"budget":"__custom__"}),
                json!({"budget":145.50}),
            ]))),
            asked: Arc::new(Mutex::new(vec![])),
        };
        let asked = handler.asked.clone();
        let client = handler.serve(client_io).await.unwrap();
        let server = started.await.unwrap();
        let result = client
            .call_tool(
                CallToolRequestParams::new("ask_goodfinds_search_question").with_arguments(
                    json!({"draft_id":"draft-camera"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{:?}", result.content);
        let result = serde_json::to_value(result).unwrap();
        assert_eq!(result["structuredContent"]["interview"]["status"], "ready");
        assert_eq!(
            result["structuredContent"]["state"]["drafts"][0]["values"]["budget"],
            14550.0
        );
        assert_eq!(
            result["_meta"]["goodfinds_state"]["drafts"][0]["values"]["budget"],
            14550.0
        );
        assert_eq!(asked.lock().unwrap().len(), 2);
        client.cancel().await.unwrap();
        server.waiting().await.unwrap();
        let ws = Workspace::open(root.path(), "live", "readback").unwrap();
        assert_eq!(ws.config["drafts"][0]["values"]["budget"], 14550.0);
    }
    #[tokio::test]
    async fn unsupported_native_questions_keep_draft_resumable() {
        let root = tempfile::tempdir().unwrap();
        seed_draft(root.path());
        let (server_io, client_io) = tokio::io::duplex(1024 * 1024);
        let server = NativeServer::new(root.path().into());
        let started = tokio::spawn(async move { server.serve(server_io).await.unwrap() });
        let client = ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("No forms", "0.1.0"),
        )
        .with_protocol_version(ProtocolVersion::V_2025_11_25)
        .serve(client_io)
        .await
        .unwrap();
        let server = started.await.unwrap();
        let result = client
            .call_tool(
                CallToolRequestParams::new("ask_goodfinds_search_question").with_arguments(
                    json!({"draft_id":"draft-camera"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{:?}", result.content);
        let result = result.structured_content.unwrap();
        assert_eq!(result["interview"]["status"], "unsupported");
        assert_eq!(result["state"]["drafts"][0]["values"], json!({}));
        client.cancel().await.unwrap();
        server.waiting().await.unwrap();
    }
}
