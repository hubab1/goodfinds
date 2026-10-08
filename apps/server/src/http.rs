//! Loopback-only preview with an unguessable session token and origin checks.
use crate::{
    assets,
    error::{Error, Result},
    service,
    util::*,
    workspace,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, Response, StatusCode},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, oneshot},
};
struct Handoff {
    mode: String,
    revision: String,
    expires: i64,
    consumed: Mutex<bool>,
}
struct Preview {
    root: PathBuf,
    context: String,
    token: String,
    port: u16,
    handoff: Option<Handoff>,
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
fn response(status: StatusCode, body: impl Into<Body>, html: bool) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer");
    if html {
        builder=builder.header("Content-Type","text/html; charset=utf-8").header("Content-Security-Policy","default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' https://ipwho.is https://api.bigdatacloud.net https://api.postcodes.io https://api.zippopotam.us; img-src data:; media-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    } else {
        builder = builder.header("Content-Type", "application/json");
    }
    builder.body(body.into()).expect("valid response")
}
async fn handle(State(state): State<Arc<Preview>>, request: Request<Body>) -> Response<Body> {
    let host = format!("127.0.0.1:{}", state.port);
    let origin = format!("http://{host}");
    if request.headers().get("host").and_then(|h| h.to_str().ok()) != Some(host.as_str())
        || request
            .headers()
            .get("origin")
            .is_some_and(|h| h.to_str().ok() != Some(origin.as_str()))
    {
        return response(
            StatusCode::FORBIDDEN,
            "This panel is available only on your device.",
            false,
        );
    }
    let mut consumed = match &state.handoff {
        Some(h) => Some(h.consumed.lock().await),
        None => None,
    };
    if let Some(h) = &state.handoff
        && (consumed.as_ref().is_some_and(|c| **c) || now() > h.expires)
    {
        return response(
            StatusCode::GONE,
            "This location request has expired. Reopen location from Goodfinds.",
            false,
        );
    }
    let path = state
        .handoff
        .as_ref()
        .map(|_| format!("/location/{}", state.token))
        .unwrap_or_else(|| "/".into());
    if request.method() == "GET" && request.uri().to_string() == path {
        let mut injected = json!({"token":state.token});
        if let Some(h) = &state.handoff {
            injected["locationOnly"] = json!(true);
            injected["workspaceMode"] = json!(h.mode);
        }
        let html = assets::panel().replacen(
            "<head>",
            &format!("<head><script>window.__GOODFINDS_PREVIEW__={injected};</script>"),
            1,
        );
        return response(StatusCode::OK, html, true);
    }
    if request.method() != "POST"
        || request.uri() != "/api/tool"
        || request
            .headers()
            .get("x-goodfinds-token")
            .and_then(|h| h.to_str().ok())
            != Some(state.token.as_str())
    {
        return response(StatusCode::NOT_FOUND, "Not found", false);
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let _guard = CancelOnDrop(cancel.clone());
    let bytes = match to_bytes(request.into_body(), 2_000_000).await {
        Ok(b) => b,
        Err(_) => return response(StatusCode::PAYLOAD_TOO_LARGE, "Too much data", false),
    };
    let input: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return response(
                StatusCode::BAD_REQUEST,
                "Could not complete that action",
                false,
            );
        }
    };
    let name = text(&input, "name");
    let args = input.get("arguments").cloned().unwrap_or(json!({}));
    if let Some(h) = &state.handoff {
        let allowed = args.as_object().is_some_and(|m| {
            m.keys()
                .all(|k| ["mode", "expected_entity_revision", "settings"].contains(&k.as_str()))
        }) && args["mode"] == h.mode
            && ["get_goodfinds_workspace", "save_goodfinds_settings"].contains(&name)
            && (name != "save_goodfinds_settings"
                || (args["expected_entity_revision"] == h.revision
                    && args["settings"]
                        .as_object()
                        .is_some_and(|s| s.len() == 1 && s.contains_key("location"))));
        if !allowed {
            return response(
                StatusCode::FORBIDDEN,
                "This one-use page can only save the requested location. Reopen it if settings changed.",
                false,
            );
        }
    }
    let result = match service::call(&state.root, &state.context, name, &args, cancel).await {
        Ok(r) => r,
        Err(e) => service::error_result(&e),
    };
    if name == "save_goodfinds_settings"
        && result["isError"] != true
        && let Some(consumed) = consumed.as_mut()
    {
        **consumed = true;
    }
    response(StatusCode::OK, result.to_string(), false)
}
async fn open(
    root: PathBuf,
    context: String,
    port: u16,
    handoff: Option<(String, String)>,
) -> Result<(
    String,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<Result<()>>,
)> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let token = format!("{}{}", id().replace('-', ""), id().replace('-', ""));
    let url = format!(
        "http://127.0.0.1:{port}{}",
        if handoff.is_some() {
            format!("/location/{token}")
        } else {
            "/".into()
        }
    );
    let state = Arc::new(Preview {
        root,
        context,
        token,
        port,
        handoff: handoff.map(|(mode, revision)| Handoff {
            mode,
            revision,
            expires: now() + 300_000,
            consumed: Mutex::new(false),
        }),
    });
    let router = Router::new().fallback(any(handle)).with_state(state);
    let (shutdown, receiver) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
            .map_err(Error::from)
    });
    Ok((url, shutdown, task))
}
pub async fn preview(root: PathBuf, port: u16) -> Result<()> {
    let context = id();
    let (url, shutdown, task) = open(root.clone(), context.clone(), port, None).await?;
    println!("Goodfinds panel: {url}");
    crate::shutdown::signal().await?;
    let _ = shutdown.send(());
    task.await
        .map_err(|e| Error::new("transport_error", e.to_string()))??;
    shutdown_location().await;
    tokio::task::spawn_blocking(move || crate::mcp::close_workspaces(&root, &context))
        .await
        .map_err(|e| Error::new("transport_error", e.to_string()))?
}
static LOCATION: Mutex<Option<(String, oneshot::Sender<()>)>> = Mutex::const_new(None);
pub async fn location(root: PathBuf, context: String, mode: String) -> Result<Value> {
    let state = workspace::execute(
        &root,
        &context,
        "get_workspace",
        &json!({"mode":mode}),
        Arc::new(AtomicBool::new(false)),
    )?;
    let mut current = LOCATION.lock().await;
    if let Some((_, previous)) = current.take() {
        let _ = previous.send(());
    }
    let (url, shutdown, task) = open(
        root,
        context,
        0,
        Some((mode, text(&state["state"]["revisions"], "settings").into())),
    )
    .await?;
    *current = Some((url.clone(), shutdown));
    drop(current);
    let expired_url = url.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(300)).await;
        let mut current = LOCATION.lock().await;
        if current.as_ref().is_some_and(|(url, _)| *url == expired_url)
            && let Some((_, shutdown)) = current.take()
        {
            let _ = shutdown.send(());
        }
        drop(current);
        let _ = task.await;
    });
    // Expiry is enforced by every request, including existing keep-alive connections.
    Ok(
        json!({"url":url,"expires_at":iso(now()+300_000),"note":"User-device browser only. Click to locate and confirm; this does not grant external browser control."}),
    )
}

pub async fn shutdown_location() {
    if let Some((_, shutdown)) = LOCATION.lock().await.take() {
        let _ = shutdown.send(());
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn loopback_requires_origin_host_and_token() {
        let root = tempfile::tempdir().unwrap();
        let (url, shutdown, task) = open(root.path().into(), id(), 0, None).await.unwrap();
        let client = reqwest::Client::new();
        let page = client.get(&url).send().await.unwrap();
        assert_eq!(page.status(), 200);
        assert!(
            page.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("frame-ancestors 'none'")
        );
        let html = page.text().await.unwrap();
        let injected = html
            .split("window.__GOODFINDS_PREVIEW__=")
            .nth(1)
            .unwrap()
            .split(";</script>")
            .next()
            .unwrap();
        let config: Value = serde_json::from_str(injected).unwrap();
        let api = format!("{url}api/tool");
        let request = json!({"name":"get_goodfinds_workspace","arguments":{}});
        assert_eq!(
            client
                .post(&api)
                .json(&request)
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .post(&api)
                .header("x-goodfinds-token", text(&config, "token"))
                .header("origin", "https://example.com")
                .json(&request)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(
            client
                .get(&url)
                .header("host", "attacker.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        let result: Value = client
            .post(&api)
            .header("x-goodfinds-token", text(&config, "token"))
            .json(&request)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["_meta"]["goodfinds_state"]["mode"], "live");
        let _ = shutdown.send(());
        task.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn location_page_is_limited_single_use_and_revision_fenced() {
        let root = tempfile::tempdir().unwrap();
        let context = id();
        let state = workspace::execute(
            root.path(),
            &context,
            "get_workspace",
            &json!({}),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let revision = text(&state["state"]["revisions"], "settings");
        let (url, shutdown, task) = open(
            root.path().into(),
            context,
            0,
            Some(("live".into(), revision.into())),
        )
        .await
        .unwrap();
        let client = reqwest::Client::new();
        let token = url.split("/location/").nth(1).unwrap();
        let api = format!("{}/api/tool", url.split("/location/").next().unwrap());
        let call = |input: Value| {
            client
                .post(&api)
                .header("x-goodfinds-token", token)
                .json(&input)
                .send()
        };
        assert_eq!(
            call(json!({"name":"list_goodfinds_listings","arguments":{"mode":"live"}}))
                .await
                .unwrap()
                .status(),
            403
        );
        assert_eq!(call(json!({"name":"save_goodfinds_settings","arguments":{"mode":"live","expected_entity_revision":revision,"settings":{"origin":"forbidden"}}})).await.unwrap().status(),403);
        let response=call(json!({"name":"save_goodfinds_settings","arguments":{"mode":"live","expected_entity_revision":revision,"settings":{"location":null}}})).await.unwrap();
        assert_eq!(response.status(), 200);
        let result: Value = response.json().await.unwrap();
        assert_ne!(result["isError"], true, "{result}");
        assert_eq!(client.get(&url).send().await.unwrap().status(), 410);
        let _ = shutdown.send(());
        task.await.unwrap().unwrap();
    }
}
