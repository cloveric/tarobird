//! JSONL protocol with Electron main. Requests carry only opaque IDs; replies
//! carry the public Tauri payloads or a stable `github_update_*` code.
//!
//! `{"id":1,"method":"install","params":{"offerId":"…"}}`
//! `{"id":1,"result":null}` / `{"id":1,"error":"github_update_host"}`
//! Windows `install` replies `{"id":1,"result":{"quit":true}}`: the verified
//! NSIS installer starts after stdin closes and Electron main has exited.
//! `{"event":"progress","offerId":"…","data":{"event":"Progress","data":{"chunkLength":42}}}`
use crate::service::{Service, INSTALL_SUPPORTED};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

pub const PROTOCOL: u64 = 1;
pub const MAX_REQUEST_BYTES: u64 = 64 * 1024;
pub const MAX_IN_FLIGHT: usize = 16;

fn identifier(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 64 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .map(str::to_owned)
        .ok_or_else(|| "invalid_update_request".into())
}

fn value<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|_| "github_update_failed".into()))
}

async fn dispatch(service: &Service, method: &str, params: &Value) -> Result<Value, String> {
    let no_params = || {
        if params.as_object().is_some_and(|object| object.is_empty()) {
            Ok(())
        } else {
            Err("invalid_update_request".to_owned())
        }
    };
    match method {
        "hello" => {
            no_params()?;
            Ok(json!({"protocol": PROTOCOL, "installSupported": INSTALL_SUPPORTED}))
        }
        "info" => { no_params()?; value(service.info().await) }
        "login_start" => { no_params()?; value(service.login_start().await) }
        "login_poll" => value(service.login_poll(&identifier(params, "flowId")?).await),
        "login_cancel" => value(service.login_cancel(&identifier(params, "flowId")?).await),
        "logout" => { no_params()?; value(service.logout().await) }
        "check" => { no_params()?; value(service.check().await) }
        "install" => value(service.install(&identifier(params, "offerId")?).await),
        "close" => value(service.close(&identifier(params, "offerId")?).await),
        _ => Err("invalid_update_request".into()),
    }
}

async fn write_line<W: AsyncWrite + Unpin>(output: &mut W, line: String) -> bool {
    let mut bytes = line.into_bytes();
    bytes.push(b'\n');
    output.write_all(&bytes).await.is_ok() && output.flush().await.is_ok()
}

/// Reads requests until EOF or a protocol violation, then cancels what is
/// still cancellable and waits for in-flight work (including a replacement
/// already under way) before returning.
pub async fn run<R, W>(
    service: Arc<Service>,
    input: R,
    output: W,
    sender: mpsc::UnboundedSender<String>,
    receiver: mpsc::UnboundedReceiver<String>,
) where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    run_authorized(service, input, output, sender, receiver, || true).await;
}

/// `run`, but every request line must pass `authorized` (its sender is the
/// verified launcher); the first one that does not ends the session like a
/// protocol violation. Returns whether a request was refused.
pub async fn run_authorized<R, W, A>(
    service: Arc<Service>,
    input: R,
    mut output: W,
    sender: mpsc::UnboundedSender<String>,
    mut receiver: mpsc::UnboundedReceiver<String>,
    authorized: A,
) -> bool where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    A: Fn() -> bool,
{
    let mut refused = false;
    let (done, mut finished) = oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        // After a broken pipe keep draining (and discarding) replies so that
        // in-flight work still completes; main can no longer read them.
        let mut healthy = true;
        loop {
            let line = tokio::select! {
                line = receiver.recv() => match line { Some(line) => line, None => break },
                _ = &mut finished => {
                    while let Ok(line) = receiver.try_recv() {
                        if healthy { healthy = write_line(&mut output, line).await; }
                    }
                    break;
                }
            };
            if healthy {
                healthy = write_line(&mut output, line).await;
            }
        }
    });
    let mut input = input;
    let mut tasks = JoinSet::new();
    loop {
        let mut line = Vec::new();
        let read = (&mut input).take(MAX_REQUEST_BYTES + 1).read_until(b'\n', &mut line).await;
        while tasks.try_join_next().is_some() {}
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.last() != Some(&b'\n') => break,
            Ok(_) => {}
        }
        if !authorized() { refused = true; break; }
        let Ok(request) = serde_json::from_slice::<Value>(&line) else { break };
        let Some(id) = request.get("id").and_then(Value::as_u64) else { break };
        let method = request.get("method").and_then(Value::as_str).unwrap_or_default().to_owned();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if request.as_object().is_some_and(|object| object.keys().any(|key| !["id", "method", "params"].contains(&key.as_str()))) {
            let _ = sender.send(json!({"id": id, "error": "invalid_update_request"}).to_string());
            continue;
        }
        if tasks.len() >= MAX_IN_FLIGHT {
            let _ = sender.send(json!({"id": id, "error": "github_update_busy"}).to_string());
            continue;
        }
        let service = service.clone();
        let sender = sender.clone();
        tasks.spawn(async move {
            let reply = match dispatch(&service, &method, &params).await {
                Ok(result) => json!({"id": id, "result": result}),
                Err(error) => json!({"id": id, "error": error}),
            };
            let _ = sender.send(reply.to_string());
        });
    }
    service.shutdown().await;
    while tasks.join_next().await.is_some() {}
    let _ = done.send(());
    let _ = writer.await;
    refused
}
