pub mod core;

use base64::{engine::general_purpose::STANDARD, Engine};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, Response},
    State, WebviewWindow,
};
use tokio::sync::{mpsc, watch, Mutex as AsyncMutex, Semaphore};
use tokio_tungstenite::tungstenite::{
    protocol::{frame::coding::CloseCode, CloseFrame},
    Message,
};

const MAX_HTTP: usize = 32;
const MAX_SOCKETS: usize = 64;
const BODY_LIMIT: usize = 8 * 1024 * 1024;
const READ_BYTES: usize = 256 * 1024;
const SOCKET_CREDITS: usize = 8;

#[derive(Clone, Copy, serde::Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Http,
    Socket,
}
struct Body {
    response: reqwest::Response,
    pending: Bytes,
}
struct Slot {
    owner: String,
    kind: Kind,
    expires: Instant,
    started: AtomicBool,
    cancel: watch::Sender<bool>,
    body: AsyncMutex<Option<Body>>,
    sender: Mutex<Option<mpsc::Sender<Message>>>,
    open: AtomicBool,
    credits: Arc<Semaphore>,
    sent: AtomicU64,
    acknowledged: AtomicU64,
}
impl Slot {
    fn established_socket(&self) -> bool {
        self.kind == Kind::Socket && self.open.load(Ordering::SeqCst)
    }
    fn expired(&self) -> bool {
        self.expires <= Instant::now() && !self.established_socket()
    }
}
pub struct Transport {
    network: Arc<core::Network>,
    slots: Arc<Mutex<HashMap<String, Arc<Slot>>>>,
    // Lock order is documents, then slots. Reset and allocation must be atomic
    // with respect to each other, including invokes queued by an unloading page.
    documents: Mutex<HashMap<String, String>>,
}
impl Transport {
    #[cfg(feature = "native-transport-audit")]
    pub fn with_network(network: core::Network) -> Self {
        Self {
            network: Arc::new(network),
            slots: Arc::new(Mutex::new(HashMap::new())),
            documents: Mutex::new(HashMap::new()),
        }
    }
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            network: Arc::new(core::Network::new()?),
            slots: Arc::new(Mutex::new(HashMap::new())),
            documents: Mutex::new(HashMap::new()),
        })
    }
    fn get(&self, id: &str, owner: &str, kind: Kind) -> Result<Arc<Slot>, String> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| "native_transport_unavailable")?
            .get(id)
            .cloned()
            .ok_or("native_request_cancelled")?;
        if slot.owner != owner
            || slot.kind != kind
            || slot.expired()
            || *slot.cancel.borrow()
        {
            return Err("native_request_cancelled".into());
        }
        Ok(slot)
    }
    fn cancel(&self, id: &str, owner: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            if slots.get(id).is_some_and(|slot| slot.owner == owner) {
                if let Some(slot) = slots.remove(id) {
                    slot.cancel.send_replace(true);
                    slot.credits.close();
                }
            }
        }
    }
    pub fn reset(&self, owner: &str) {
        let Ok(mut documents) = self.documents.lock() else {
            return;
        };
        documents.insert(owner.to_owned(), uuid::Uuid::new_v4().to_string());
        if let Ok(mut slots) = self.slots.lock() {
            slots.retain(|_, slot| {
                if slot.owner == owner {
                    slot.cancel.send_replace(true);
                    slot.credits.close();
                    false
                } else {
                    true
                }
            });
        }
    }
    fn document(&self, owner: &str) -> Result<String, String> {
        let mut documents = self
            .documents
            .lock()
            .map_err(|_| "native_transport_unavailable")?;
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "native_transport_unavailable")?;
        let lease = uuid::Uuid::new_v4().to_string();
        documents.insert(owner.to_owned(), lease.clone());
        slots.retain(|_, slot| {
            if slot.owner != owner {
                return true;
            }
            slot.cancel.send_replace(true);
            slot.credits.close();
            false
        });
        Ok(lease)
    }
}
async fn cancellable<T>(
    slot: &Slot,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let mut cancel = slot.cancel.subscribe();
    if *cancel.borrow() {
        return Err("native_request_cancelled".into());
    }
    // Match the Electron helper: an established socket belongs to its document
    // and peer; only allocation/connect and HTTP retain an absolute deadline.
    tokio::pin!(future);
    let mut deadline = true;
    loop {
        tokio::select! { biased;
            _ = cancel.changed() => return Err("native_request_cancelled".into()),
            _ = tokio::time::sleep_until(slot.expires.into()), if deadline => {
                if slot.established_socket() { deadline = false; }
                else { return Err("native_request_timeout".into()); }
            },
            result = &mut future => return result,
        }
    }
}

#[tauri::command]
pub fn net_document(window: WebviewWindow, state: State<'_, Transport>) -> Result<String, String> {
    state.document(window.label())
}

#[tauri::command]
pub fn net_allocate(
    kind: Kind,
    document: String,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<String, String> {
    state.allocate(kind, &document, window.label())
}

impl Transport {
    fn allocate(&self, kind: Kind, document: &str, owner: &str) -> Result<String, String> {
        let documents = self
            .documents
            .lock()
            .map_err(|_| "native_transport_unavailable")?;
        if documents.get(owner).map(String::as_str) != Some(document) {
            return Err("native_document_retired".into());
        }
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "native_transport_unavailable")?;
        slots.retain(|_, slot| {
            if slot.expired() {
                slot.cancel.send_replace(true);
                slot.credits.close();
                false
            } else {
                true
            }
        });
        if slots.values().filter(|slot| slot.kind == kind).count()
            >= if kind == Kind::Http {
                MAX_HTTP
            } else {
                MAX_SOCKETS
            }
        {
            return Err("native_transport_busy".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (cancel, _) = watch::channel(false);
        slots.insert(
            id.clone(),
            Arc::new(Slot {
                owner: owner.to_owned(),
                kind,
                expires: Instant::now()
                    + Duration::from_secs(if kind == Kind::Http { 300 } else { 1200 }),
                started: AtomicBool::new(false),
                cancel,
                body: AsyncMutex::new(None),
                sender: Mutex::new(None),
                open: AtomicBool::new(false),
                credits: Arc::new(Semaphore::new(SOCKET_CREDITS)),
                sent: AtomicU64::new(0),
                acknowledged: AtomicU64::new(0),
            }),
        );
        Ok(id)
    }
}
#[tauri::command]
pub fn net_cancel(id: String, window: WebviewWindow, state: State<'_, Transport>) {
    state.cancel(&id, window.label());
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpInput {
    origin: String,
    hub_key: Option<String>,
    certificate_authority: Option<String>,
    path: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}
#[derive(serde::Serialize)]
pub struct HttpHead {
    status: u16,
    headers: Vec<(String, String)>,
}

#[tauri::command]
pub async fn net_http_open(
    id: String,
    input: HttpInput,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<HttpHead, String> {
    let slot = state.get(&id, window.label(), Kind::Http)?;
    if slot.started.swap(true, Ordering::SeqCst) {
        return Err("native_request_already_started".into());
    }
    let result = cancellable(&slot, async {
        if !matches!(
            input.method.as_str(),
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
        ) {
            return Err("invalid_http_method".into());
        }
        let body = match &input.body {
            Some(raw) => {
                if raw.len() > BODY_LIMIT.div_ceil(3) * 4 {
                    return Err("native_body_too_large".into());
                }
                let decoded = STANDARD.decode(raw).map_err(|_| "invalid_http_body")?;
                if decoded.len() > BODY_LIMIT || matches!(input.method.as_str(), "GET" | "HEAD") {
                    return Err("invalid_http_body".into());
                }
                Some(decoded)
            }
            None => None,
        };
        if input.headers.len() > 32
            || input
                .headers
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>()
                > 16384
        {
            return Err("invalid_http_headers".into());
        }
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in &input.headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization"
                    | "content-type"
                    | "accept"
                    | "range"
                    | "if-range"
                    | "if-none-match"
            ) {
                return Err("invalid_http_headers".into());
            }
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "invalid_http_headers")?,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| "invalid_http_headers")?,
            );
        }
        let route = state
            .network
            .prepare_with_ca(&input.origin, input.hub_key.as_deref(), input.certificate_authority.as_deref())
            .await?;
        let mut request = route
            .client
            .request(
                reqwest::Method::from_bytes(input.method.as_bytes())
                    .map_err(|_| "invalid_http_method")?,
                core::target(&route.base, &input.path)?,
            )
            .headers(headers)
            .timeout(Duration::from_secs(300));
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = match request.send().await {
            Ok(value) => value,
            Err(_) => {
                state
                    .network
                    .forget(&input.origin, input.hub_key.as_deref())
                    .await;
                return Err("native_request_failed".into());
            }
        };
        let head = HttpHead {
            status: response.status().as_u16(),
            headers: response
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
                .collect(),
        };
        if (300..400).contains(&head.status) && head.status != 304 {
            return Err("hub_redirect_rejected".into());
        }
        *slot.body.lock().await = Some(Body {
            response,
            pending: Bytes::new(),
        });
        Ok(head)
    })
    .await;
    if result.is_err() {
        state.cancel(&id, window.label());
    }
    result
}

#[tauri::command]
pub async fn net_http_read(
    id: String,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<Response, String> {
    let slot = state.get(&id, window.label(), Kind::Http)?;
    let result = cancellable(&slot, async {
        let mut locked = slot.body.lock().await;
        let body = locked.as_mut().ok_or("native_response_unavailable")?;
        while body.pending.is_empty() {
            match body
                .response
                .chunk()
                .await
                .map_err(|_| "native_response_failed")?
            {
                Some(bytes) => body.pending = bytes,
                None => {
                    *locked = None;
                    return Ok(Vec::new());
                }
            }
        }
        Ok(body
            .pending
            .split_to(body.pending.len().min(READ_BYTES))
            .to_vec())
    })
    .await;
    if result.as_ref().map_or(true, |bytes| bytes.is_empty()) {
        state.cancel(&id, window.label());
    }
    result.map(Response::new)
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SocketEvent {
    Open,
    Message {
        data: String,
        sequence: u64,
    },
    Error {
        error: String,
    },
    Close {
        code: u16,
        reason: String,
        clean: bool,
    },
}

#[tauri::command]
pub fn net_socket_open(
    id: String,
    origin: String,
    hub_key: Option<String>,
    certificate_authority: Option<String>,
    events: Channel<SocketEvent>,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<(), String> {
    let slot = state.get(&id, window.label(), Kind::Socket)?;
    if slot.started.swap(true, Ordering::SeqCst) {
        return Err("native_request_already_started".into());
    }
    let network = state.network.clone();
    let slots = state.slots.clone();
    let (sender, outgoing) = mpsc::channel::<Message>(16);
    *slot
        .sender
        .lock()
        .map_err(|_| "native_transport_unavailable")? = Some(sender);
    tauri::async_runtime::spawn(async move {
        let result = cancellable(&slot, async {
            let route = network.prepare_with_ca(&origin, hub_key.as_deref(), certificate_authority.as_deref()).await?;
            let socket = match core::websocket(&route).await {
                Ok(socket) => socket,
                Err(error) => {
                    network.forget(&origin, hub_key.as_deref()).await;
                    return Err(error);
                }
            };
            slot.open.store(true, Ordering::SeqCst);
            events
                .send(SocketEvent::Open)
                .map_err(|_| "native_view_unavailable")?;
            forward_socket(socket, &slot, outgoing, |event| {
                events
                    .send(event)
                    .map_err(|_| "native_view_unavailable".into())
            })
            .await
        })
        .await;
        slot.open.store(false, Ordering::SeqCst);
        let (code, reason, clean) = match result {
            Ok(value) => value,
            Err(error) => {
                if error != "native_request_cancelled" {
                    let _ = events.send(SocketEvent::Error { error });
                }
                (1006, String::new(), false)
            }
        };
        let _ = events.send(SocketEvent::Close {
            code,
            reason,
            clean,
        });
        if let Ok(mut entries) = slots.lock() {
            entries.remove(&id);
        }
        slot.cancel.send_replace(true);
        slot.credits.close();
    });
    Ok(())
}

// Keep flow-control waits separate from outgoing traffic: a suspended WebView
// must not prevent a pending stop/close frame from reaching the Hub.
async fn forward_socket<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    slot: &Slot,
    mut outgoing: mpsc::Receiver<Message>,
    emit: impl Fn(SocketEvent) -> Result<(), String>,
) -> Result<(u16, String, bool), String> {
    let (mut writer, mut reader) = socket.split();
    let mut pending: Option<String> = None;
    let mut credit_deadline = Instant::now();
    let mut closing = false;
    let mut close_deadline = Instant::now();
    loop {
        tokio::select! {
            item = outgoing.recv(), if !closing => {
                let message = item.ok_or("native_socket_closed")?;
                let starts_close = message.is_close();
                tokio::time::timeout(Duration::from_secs(5), writer.send(message)).await.map_err(|_| "native_socket_timeout")?.map_err(|_| "native_socket_failed")?;
                if starts_close { closing = true; pending = None; close_deadline = Instant::now() + Duration::from_secs(5); }
            },
            _ = tokio::time::sleep_until(close_deadline.into()), if closing => return Ok((1006, String::new(), false)),
            _ = tokio::time::sleep_until(credit_deadline.into()), if pending.is_some() => return Err("native_view_timeout".into()),
            permit = slot.credits.acquire(), if pending.is_some() => {
                let permit = permit.map_err(|_| "native_socket_closed")?;
                let sequence = slot.sent.fetch_add(1, Ordering::SeqCst) + 1;
                emit(SocketEvent::Message { data: pending.take().unwrap(), sequence })?;
                permit.forget();
            },
            item = reader.next(), if pending.is_none() => {
                match item {
                    Some(Ok(Message::Text(text))) => {
                        if !closing { pending = Some(text.to_string()); credit_deadline = Instant::now() + Duration::from_secs(10); }
                    },
                    Some(Ok(Message::Ping(bytes))) => { tokio::time::timeout(Duration::from_secs(5), writer.send(Message::Pong(bytes))).await.map_err(|_| "native_socket_timeout")?.map_err(|_| "native_socket_failed")?; },
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Close(frame))) => {
                        let clean = matches!(tokio::time::timeout(Duration::from_secs(1), writer.flush()).await, Ok(Ok(())));
                        return Ok(frame.map_or((1005, String::new(), clean), |f| (u16::from(f.code), f.reason.to_string(), clean)));
                    },
                    None => return Ok((1006, String::new(), false)),
                    _ => return Err("native_socket_failed".into()),
                }
            }
        }
    }
}

#[tauri::command]
pub async fn net_socket_send(
    id: String,
    text: String,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<(), String> {
    let slot = state.get(&id, window.label(), Kind::Socket)?;
    if !slot.open.load(Ordering::SeqCst) || text.len() > core::MAX_FRAME {
        return Err("native_socket_not_open".into());
    }
    let sender = slot
        .sender
        .lock()
        .map_err(|_| "native_transport_unavailable")?
        .clone()
        .ok_or("native_socket_not_open")?;
    cancellable(&slot, async {
        sender
            .send(Message::Text(text.into()))
            .await
            .map_err(|_| "native_socket_closed".into())
    })
    .await
}
#[tauri::command]
pub fn net_socket_ack(
    id: String,
    sequence: u64,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<(), String> {
    let slot = state.get(&id, window.label(), Kind::Socket)?;
    if sequence > slot.sent.load(Ordering::SeqCst) {
        return Err("invalid_socket_receipt".into());
    }
    let previous = slot.acknowledged.fetch_max(sequence, Ordering::SeqCst);
    if sequence > previous {
        slot.credits.add_permits((sequence - previous) as usize);
    }
    Ok(())
}
#[tauri::command]
pub async fn net_socket_close(
    id: String,
    code: u16,
    reason: String,
    window: WebviewWindow,
    state: State<'_, Transport>,
) -> Result<bool, String> {
    let slot = match state.get(&id, window.label(), Kind::Socket) {
        Ok(slot) => slot,
        Err(_) => return Ok(false),
    };
    if reason.len() > 123 || !(code == 1000 || (3000..5000).contains(&code)) {
        return Err("invalid_socket_close".into());
    }
    if !slot.open.load(Ordering::SeqCst) {
        state.cancel(&id, window.label());
        return Ok(false);
    }
    let sender = slot
        .sender
        .lock()
        .map_err(|_| "native_transport_unavailable")?
        .clone();
    if let Some(sender) = sender {
        tokio::time::timeout(
            Duration::from_secs(5),
            sender.send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(code),
                reason: reason.into(),
            }))),
        )
        .await
        .map_err(|_| "native_close_timeout")?
        .map_err(|_| "native_socket_closed")?;
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

    #[tokio::test]
    async fn allocation_deadlines_bound_http_and_connecting_slots_but_not_open_sockets() {
        for (kind, established) in [(Kind::Http, false), (Kind::Socket, false), (Kind::Socket, true)] {
            let state = Transport::new().unwrap();
            let doc = state.document("main").unwrap();
            let id = state.allocate(kind, &doc, "main").unwrap();
            {
                let mut slots = state.slots.lock().unwrap();
                let slot = Arc::get_mut(slots.get_mut(&id).unwrap()).unwrap();
                slot.expires = Instant::now() - Duration::from_secs(1);
                slot.open.store(established, Ordering::SeqCst);
            }
            let slot = state.slots.lock().unwrap()[&id].clone();
            let result = cancellable(&slot, async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                Ok(())
            }).await;
            if established {
                assert!(result.is_ok());
                state.allocate(Kind::Http, &doc, "main").unwrap();
                assert!(state.get(&id, "main", kind).is_ok());
                state.reset("main");
                assert_eq!(cancellable(&slot, std::future::pending::<Result<(), String>>()).await.unwrap_err(), "native_request_cancelled");
            } else {
                assert_eq!(result.unwrap_err(), "native_request_timeout");
                assert!(state.get(&id, "main", kind).is_err());
                state.allocate(kind, &doc, "main").unwrap();
                assert!(*slot.cancel.borrow());
            }
        }
    }

    #[test]
    fn a_retired_document_cannot_allocate_after_reload_or_use_another_window() {
        let state = Transport::new().unwrap();
        let old = state.document("main").unwrap();
        let id = state.allocate(Kind::Http, &old, "main").unwrap();
        let pending = state.get(&id, "main", Kind::Http).unwrap();
        let other = state.document("other").unwrap();
        let other_id = state.allocate(Kind::Socket, &other, "other").unwrap();
        assert!(state.get(&id, "other", Kind::Http).is_err());
        assert!(state.allocate(Kind::Http, &old, "other").is_err());
        state.reset("main");
        assert!(*pending.cancel.borrow());
        assert!(state.get(&id, "main", Kind::Http).is_err());
        assert!(state.allocate(Kind::Http, &old, "main").is_err());
        assert!(state.get(&other_id, "other", Kind::Socket).is_ok());
        let next = state.document("main").unwrap();
        assert_ne!(old, next);
        assert!(state.allocate(Kind::Http, &next, "main").is_ok());
        let next_id = state.allocate(Kind::Socket, &next, "main").unwrap();
        let next_slot = state.get(&next_id, "main", Kind::Socket).unwrap();
        let replacement = state.document("main").unwrap();
        assert_ne!(replacement, next);
        assert!(*next_slot.cancel.borrow());
        assert!(state.allocate(Kind::Http, &next, "main").is_err());
        assert!(state.get(&next_id, "main", Kind::Socket).is_err());
    }

    #[tokio::test]
    async fn socket_close_still_reaches_peer_when_view_credits_are_exhausted() {
        let state = Transport::new().unwrap();
        let doc = state.document("main").unwrap();
        let id = state.allocate(Kind::Socket, &doc, "main").unwrap();
        let slot = state.get(&id, "main", Kind::Socket).unwrap();
        slot.credits
            .acquire_many(SOCKET_CREDITS as u32)
            .await
            .unwrap()
            .forget();
        let (client, server) = tokio::io::duplex(4096);
        let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        let mut server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let (send, outgoing) = mpsc::channel(16);
        let actor = tokio::spawn(async move {
            forward_socket(client, &slot, outgoing, |_| panic!("no view credit")).await
        });
        server
            .send(Message::Text("waiting for view".into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        send.send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "done".into(),
        })))
        .await
        .unwrap();
        let received = tokio::time::timeout(Duration::from_secs(1), server.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(received.is_close());
        server.flush().await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), actor)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result, (1000, "done".to_owned(), true));
    }

    #[tokio::test]
    async fn empty_peer_close_is_1005_and_dropped_peer_is_unclean() {
        for clean in [true, false] {
            let state = Transport::new().unwrap();
            let doc = state.document("main").unwrap();
            let id = state.allocate(Kind::Socket, &doc, "main").unwrap();
            let slot = state.get(&id, "main", Kind::Socket).unwrap();
            let (client, server) = tokio::io::duplex(4096);
            let client = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
            let mut server = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
            let (_sender, outgoing) = mpsc::channel(16);
            let actor =
                tokio::spawn(
                    async move { forward_socket(client, &slot, outgoing, |_| Ok(())).await },
                );
            if clean {
                server.send(Message::Close(None)).await.unwrap();
                assert!(server.next().await.unwrap().unwrap().is_close());
            } else {
                drop(server);
            }
            let result = tokio::time::timeout(Duration::from_secs(1), actor)
                .await
                .unwrap()
                .unwrap();
            if clean {
                assert_eq!(result.unwrap(), (1005, String::new(), true));
            } else {
                assert!(result.is_err() || result == Ok((1006, String::new(), false)));
            }
        }
    }
}
