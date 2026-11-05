//! Request routing. Command names and argument shapes mirror the Tauri
//! `invoke` handlers; unknown commands or fields fail instead of succeeding.
use crate::{
    desktop_host::DesktopHost,
    identity::{device_actions::Statement, Identity},
    protocol::{self, Line, Output, Request, MAX_INFLIGHT, MAX_REQUEST_LINE},
    transport::{HttpInput, Kind, SocketEvent, Transport, VIEW},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{oneshot, Semaphore},
};

pub const PROTOCOL: u32 = 1;
/// Commands the renderer may reach through the preload bridge.
pub const VIEW_COMMANDS: [&str; 14] = [
    "device_create", "device_sign", "device_sign_action", "device_forget",
    "net_document", "net_allocate", "net_cancel", "net_http_open", "net_http_read",
    "net_socket_open", "net_socket_send", "net_socket_ack", "net_socket_close", "desktop_host",
];
/// Main-process only; never exposed through preload.
pub const MAIN_COMMANDS: [&str; 2] = ["net_reset", "helper_info"];

pub struct Services { pub identity: Identity, pub transport: Arc<Transport>, pub host: Arc<DesktopHost> }

fn args<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| "invalid_arguments".into())
}
fn channel_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Empty {}
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sign { key_ref: String, device_id: String, nonce: String, client_nonce: String }
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignAction { key_ref: String, statement: Statement }
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Forget { key_ref: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct Allocate { kind: Kind, document: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct Id { id: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct HttpOpen { id: String, input: HttpInput }
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SocketOpen { id: String, origin: String, hub_key: Option<String>, certificate_authority: Option<String>, channel: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct SocketSend { id: String, text: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct SocketAck { id: String, sequence: u64 }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct SocketClose { id: String, code: u16, reason: String }
#[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
struct Host { action: String, device: Option<Value> }

/// A reply plus, for `net_socket_open`, the starter released after the
/// response line is queued.
type Reply = (Result<Value, String>, Option<oneshot::Sender<()>>);

async fn dispatch(services: &Services, output: &Output, command: &str, value: Value) -> Reply {
    let plain = |result: Result<Value, String>| (result, None);
    let ok = |_: ()| Value::Null;
    match command {
        "helper_info" => plain(args::<Empty>(value).map(|_| json!({ "protocol": PROTOCOL, "version": env!("CARGO_PKG_VERSION") }))),
        "net_reset" => plain(args::<Empty>(value).map(|_| { services.transport.reset(VIEW); Value::Null })),
        "device_create" => plain(match args::<Empty>(value) {
            Ok(_) => services.identity.create().await.and_then(|v| serde_json::to_value(v).map_err(|_| "device_storage_failed".into())),
            Err(e) => Err(e),
        }),
        "device_sign" => plain(match args::<Sign>(value) {
            Ok(a) => services.identity.sign(a.key_ref, a.device_id, a.nonce, a.client_nonce).await.map(Value::String),
            Err(e) => Err(e),
        }),
        "device_sign_action" => plain(match args::<SignAction>(value) {
            Ok(a) => services.identity.sign_action(a.key_ref, a.statement).await.map(Value::String),
            Err(e) => Err(e),
        }),
        "device_forget" => plain(match args::<Forget>(value) {
            Ok(a) => services.identity.forget(a.key_ref).await.map(ok),
            Err(e) => Err(e),
        }),
        "net_document" => plain(args::<Empty>(value).and_then(|_| services.transport.document(VIEW).map(Value::String))),
        "net_allocate" => plain(args::<Allocate>(value).and_then(|a| services.transport.allocate(a.kind, &a.document, VIEW).map(Value::String))),
        "net_cancel" => plain(args::<Id>(value).map(|a| { services.transport.cancel(&a.id, VIEW); Value::Null })),
        "net_http_open" => plain(match args::<HttpOpen>(value) {
            Ok(a) => services.transport.http_open(&a.id, a.input, VIEW).await
                .and_then(|head| serde_json::to_value(head).map_err(|_| "native_response_failed".into())),
            Err(e) => Err(e),
        }),
        // Binary chunks travel as base64 (mobile `httpRead` shape); "" is EOF.
        "net_http_read" => plain(match args::<Id>(value) {
            Ok(a) => services.transport.http_read(&a.id, VIEW).await.map(|bytes| json!({ "data": STANDARD.encode(bytes) })),
            Err(e) => Err(e),
        }),
        "net_socket_open" => match args::<SocketOpen>(value) {
            Ok(a) if channel_valid(&a.channel) => {
                let (output, channel) = (output.clone(), a.channel);
                let emit: crate::transport::Emit = Arc::new(move |document: &str, event: SocketEvent| {
                    let payload = serde_json::to_value(event).map_err(|_| "native_view_unavailable".to_owned())?;
                    match protocol::event(document, &channel, payload) {
                        Some(line) => if output.try_send(line) { Ok(()) } else { Err("native_view_unavailable".to_owned()) },
                        None => Err("native_view_unavailable".to_owned()),
                    }
                });
                match services.transport.socket_open(a.id, a.origin, a.hub_key, a.certificate_authority, emit, VIEW) {
                    Ok(start) => (Ok(Value::Null), Some(start)),
                    Err(e) => plain(Err(e)),
                }
            }
            Ok(_) => plain(Err("invalid_arguments".into())),
            Err(e) => plain(Err(e)),
        },
        "net_socket_send" => plain(match args::<SocketSend>(value) {
            Ok(a) => services.transport.socket_send(&a.id, a.text, VIEW).await.map(ok),
            Err(e) => Err(e),
        }),
        "net_socket_ack" => plain(args::<SocketAck>(value).and_then(|a| services.transport.socket_ack(&a.id, a.sequence, VIEW).map(ok))),
        "net_socket_close" => plain(match args::<SocketClose>(value) {
            Ok(a) => services.transport.socket_close(&a.id, a.code, a.reason, VIEW).await.map(Value::Bool),
            Err(e) => Err(e),
        }),
        "desktop_host" => plain(match args::<Host>(value) {
            Ok(a) => services.host.run(&a.action, a.device).await,
            Err(e) => Err(e),
        }),
        _ => plain(Err("unknown_command".into())),
    }
}

async fn respond(services: Arc<Services>, output: Output, request: Request) {
    let (result, start) = dispatch(&services, &output, &request.command, request.args).await;
    let line = match result {
        Ok(value) => protocol::success(&request.id, value),
        Err(code) => protocol::failure(&request.id, &code),
    };
    let queued = output.send(line).await;
    if let Some(start) = start {
        // Without a reader the socket never connects: a dropped starter ends
        // the slot as a lost view.
        if queued { let _ = start.send(()); }
    }
}

/// Serves until stdin closes or stdout fails, then cancels every slot.
pub async fn serve<R, W>(services: Arc<Services>, input: R, stdout: W)
where R: AsyncRead + Unpin, W: AsyncWrite + Unpin + Send + 'static {
    serve_authorized(services, input, stdout, || true).await;
}

/// `serve`, but every request line must pass `authorized` (its sender is the
/// verified launcher); the first one that does not ends the session. Returns
/// whether a request was refused.
pub async fn serve_authorized<R, W, A>(services: Arc<Services>, input: R, mut stdout: W, authorized: A) -> bool
where R: AsyncRead + Unpin, W: AsyncWrite + Unpin + Send + 'static, A: Fn() -> bool {
    let mut refused = false;
    let (output, mut lines) = Output::new();
    let writer = tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            if stdout.write_all(&line).await.is_err() { return; }
            if lines.is_empty() && stdout.flush().await.is_err() { return; }
        }
        let _ = stdout.flush().await;
    });
    let inflight = Arc::new(Semaphore::new(MAX_INFLIGHT));
    let mut reader = BufReader::with_capacity(64 * 1024, input);
    loop {
        if writer.is_finished() { break; }
        let line = match protocol::read_line(&mut reader, MAX_REQUEST_LINE).await {
            Ok(Line::Data(line)) => line,
            Ok(Line::TooLarge) => { output.send(protocol::failure(&Value::Null, "request_too_large")).await; continue; }
            Ok(Line::Eof) | Err(_) => break,
        };
        if !authorized() { refused = true; break; }
        if line.iter().all(u8::is_ascii_whitespace) { continue; }
        let request = match protocol::parse(&line) {
            Ok(request) => request,
            Err((id, code)) => { output.send(protocol::failure(&id, code)).await; continue; }
        };
        let Ok(permit) = inflight.clone().try_acquire_owned() else {
            output.send(protocol::failure(&request.id, "helper_busy")).await;
            continue;
        };
        let (services, output) = (services.clone(), output.clone());
        tokio::spawn(async move { respond(services, output, request).await; drop(permit); });
    }
    // The view is gone: retire its document and every slot at once. A Host
    // control command may still finish within its own 180 s limit (Tauri
    // commands also outlived their window); nothing waits longer.
    services.transport.reset(VIEW);
    let _ = tokio::time::timeout(Duration::from_secs(185), inflight.acquire_many(MAX_INFLIGHT as u32)).await;
    drop(output);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    refused
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::memory::MemoryVault;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    struct Harness { input: tokio::io::DuplexStream, output: tokio::io::Lines<BufReader<tokio::io::DuplexStream>>, done: tokio::task::JoinHandle<()>, root: std::path::PathBuf }
    impl Harness {
        fn start() -> Self {
            let root = std::env::temp_dir().join(format!("desktop-core-server-{}", uuid::Uuid::new_v4().simple()));
            let identity = Identity::new(Arc::new(MemoryVault::default()), root.join("state"));
            let services = Arc::new(Services {
                host: DesktopHost::new(identity.clone(), root.join("resources/host"), root.join("data/com.tarobot.client")),
                identity, transport: Arc::new(Transport::new().unwrap()),
            });
            let (input, server_in) = tokio::io::duplex(1 << 20);
            let (server_out, output) = tokio::io::duplex(1 << 20);
            let done = tokio::spawn(serve(services, server_in, server_out));
            Self { input, output: BufReader::new(output).lines(), done, root }
        }
        async fn send(&mut self, raw: &str) { self.input.write_all(raw.as_bytes()).await.unwrap(); self.input.write_all(b"\n").await.unwrap(); }
        async fn next(&mut self) -> Value {
            let line = tokio::time::timeout(Duration::from_secs(5), self.output.next_line()).await.unwrap().unwrap().unwrap();
            serde_json::from_str(&line).unwrap()
        }
        async fn call(&mut self, id: u64, command: &str, args: Value) -> Value {
            self.send(&json!({"id": id, "command": command, "args": args}).to_string()).await;
            let reply = self.next().await;
            assert_eq!(reply["id"], id);
            reply
        }
    }
    impl Drop for Harness { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

    #[tokio::test]
    async fn routes_commands_with_tauri_error_codes_and_rejects_unknown_shapes() {
        let mut h = Harness::start();
        assert_eq!(h.call(1, "helper_info", json!({})).await["result"]["protocol"], 1);
        let lease = h.call(2, "net_document", json!({})).await["result"].as_str().unwrap().to_owned();
        let id = h.call(3, "net_allocate", json!({"kind": "http", "document": lease})).await["result"].as_str().unwrap().to_owned();
        assert_eq!(h.call(4, "net_allocate", json!({"kind": "http", "document": "old"})).await["error"]["code"], "native_document_retired");
        assert_eq!(h.call(5, "net_allocate", json!({"kind": "ftp", "document": lease})).await["error"]["code"], "invalid_arguments");
        assert_eq!(h.call(6, "net_http_read", json!({"id": id})).await["error"]["code"], "native_response_unavailable");
        // The failed read released the slot.
        assert_eq!(h.call(7, "net_http_read", json!({"id": id})).await["error"]["code"], "native_request_cancelled");
        assert_eq!(h.call(8, "net_socket_close", json!({"id": "missing", "code": 1000, "reason": ""})).await["result"], false);
        assert_eq!(h.call(9, "net_socket_ack", json!({"id": "missing", "sequence": 1})).await["error"]["code"], "native_request_cancelled");
        assert_eq!(h.call(10, "net_cancel", json!({"id": "missing"})).await["result"], Value::Null);
        assert_eq!(h.call(11, "restart_client", json!({})).await["error"], json!({"code": "unknown_command", "message": "unknown_command"}));
        assert_eq!(h.call(12, "net_document", json!({"extra": 1})).await["error"]["code"], "invalid_arguments");
        assert_eq!(h.call(13, "desktop_host", json!({"action": "status", "path": "/bin"})).await["error"]["code"], "invalid_arguments");
        assert_eq!(h.call(14, "desktop_host", json!({"action": "exec"})).await["error"]["code"], "invalid_desktop_host_action");
        assert_eq!(h.call(15, "desktop_host", json!({"action": "status"})).await["result"], json!({"available": false, "running": false}));
        let socket = h.call(16, "net_allocate", json!({"kind": "socket", "document": lease})).await["result"].as_str().unwrap().to_owned();
        for channel in ["", "a b", "../x"] {
            assert_eq!(h.call(17, "net_socket_open", json!({"id": socket, "origin": "https://127.0.0.1", "hubKey": null, "channel": channel})).await["error"]["code"], "invalid_arguments");
        }
        assert_eq!(h.call(18, "net_socket_open", json!({"id": socket, "origin": "https://127.0.0.1", "hubKey": null, "events": {}})).await["error"]["code"], "invalid_arguments");
        assert_eq!(h.call(19, "device_sign", json!({"keyRef": "device_a", "deviceId": "device_b", "nonce": "n", "clientNonce": "c"})).await["error"]["code"], "invalid_challenge");
        assert_eq!(h.call(20, "net_reset", json!({})).await["result"], Value::Null);
        assert_eq!(h.call(21, "net_allocate", json!({"kind": "http", "document": lease})).await["error"]["code"], "native_document_retired");
    }

    #[tokio::test]
    async fn malformed_and_oversized_lines_are_answered_without_stopping_the_helper() {
        let mut h = Harness::start();
        h.send("not json").await;
        assert_eq!(h.next().await, json!({"id": null, "error": {"code": "invalid_request", "message": "invalid_request"}}));
        h.send(r#"{"id":"x","command":"net_document","args":[]}"#).await;
        assert_eq!(h.next().await["id"], "x");
        h.send(&format!("{{\"id\":1,\"command\":\"net_document\",\"pad\":\"{}\"}}", "a".repeat(MAX_REQUEST_LINE))).await;
        assert_eq!(h.next().await, json!({"id": null, "error": {"code": "request_too_large", "message": "request_too_large"}}));
        assert!(h.call(2, "net_document", json!({})).await["result"].is_string());
    }

    #[tokio::test]
    async fn end_of_input_retires_the_document_and_stops_the_helper() {
        let mut h = Harness::start();
        let lease = h.call(1, "net_document", json!({})).await["result"].clone();
        h.call(2, "net_allocate", json!({"kind": "socket", "document": lease})).await;
        h.input.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), &mut h.done).await.unwrap().unwrap();
        assert!(h.output.next_line().await.unwrap().is_none());
    }
}
