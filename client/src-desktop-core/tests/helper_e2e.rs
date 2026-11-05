//! Drives the compiled helper over real stdin/stdout JSONL. Network cases use
//! the repository's isolated TLS fixture (own CA, own Hub state) through the
//! scoped `certificateAuthority` path; nothing touches system trust, a real
//! Host, production state or the OS credential store.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

fn lab(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("desktop-core-e2e-{name}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&root).unwrap();
    root
}
fn repo() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..") }

struct Helper { child: Child, stdin: Option<ChildStdin>, lines: mpsc::Receiver<String>, events: Vec<Value>, next: u64, root: PathBuf }
impl Helper {
    fn start(root: &Path, env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tarobot-desktop-core"));
        command.args(["--state-dir"]).arg(root.join("state"))
            .args(["--keyring-service", "com.tarobot.client.device.e2e-unused"])
            .args(["--resources-dir"]).arg(root.join("resources/host"))
            .args(["--host-state-dir"]).arg(root.join("data/com.tarobot.client"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (key, value) in env { command.env(key, value); }
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = mpsc::channel();
        std::thread::spawn(move || for line in BufReader::new(stdout).lines() { if send.send(line.unwrap()).is_err() { return; } });
        Self { stdin: child.stdin.take(), child, lines, events: Vec::new(), next: 1, root: root.to_owned() }
    }
    fn line(&self, timeout: Duration) -> Option<Value> {
        self.lines.recv_timeout(timeout).ok().map(|line| serde_json::from_str(&line).unwrap_or_else(|_| panic!("non-protocol stdout: {line}")))
    }
    fn call(&mut self, command: &str, args: Value) -> Value {
        let id = self.next; self.next += 1;
        writeln!(self.stdin.as_mut().unwrap(), "{}", json!({"id": id, "command": command, "args": args})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let value = self.line(deadline.saturating_duration_since(Instant::now())).unwrap_or_else(|| panic!("no reply to {command}"));
            if value.get("event").is_some() { self.events.push(value); continue; }
            assert_eq!(value["id"], id, "{value}");
            return value;
        }
    }
    fn ok(&mut self, command: &str, args: Value) -> Value {
        let reply = self.call(command, args);
        assert!(reply.get("error").is_none(), "{command}: {reply}");
        reply["result"].clone()
    }
    fn error(&mut self, command: &str, args: Value) -> String {
        let reply = self.call(command, args);
        assert_eq!(reply["error"]["code"], reply["error"]["message"]);
        reply["error"]["code"].as_str().unwrap_or_else(|| panic!("{command} succeeded: {reply}")).to_owned()
    }
    /// Next event for `channel`, consuming earlier buffered ones first.
    fn event(&mut self, channel: &str, timeout: Duration) -> Option<Value> {
        if let Some(index) = self.events.iter().position(|e| e["channel"] == channel) { return Some(self.events.remove(index)); }
        let deadline = Instant::now() + timeout;
        while let Some(value) = self.line(deadline.saturating_duration_since(Instant::now())) {
            assert!(value.get("event").is_some(), "unexpected reply {value}");
            if value["channel"] == channel { return Some(value); }
            self.events.push(value);
        }
        None
    }
    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() { return status; }
            assert!(Instant::now() < deadline, "helper did not exit after stdin EOF");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Helper {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.root); }
}

struct Fixture { child: Child, output: BufReader<std::process::ChildStdout>, root: PathBuf, info: Value }
impl Fixture {
    fn start() -> Self {
        let root = lab("tls");
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap(); }
        let mut child = Command::new("node").args(["--import", "tsx", "tests/helpers/native-tls-fixture.ts"]).arg(&root)
            .current_dir(repo()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()
            .expect("node is required for the isolated TLS fixture");
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let info = serde_json::from_str(&line).unwrap_or_else(|e| { let _ = child.kill(); panic!("fixture startup: {e}: {line}") });
        Self { child, output, root, info }
    }
    fn value(&self, key: &str) -> String { self.info[key].as_str().unwrap().to_owned() }
    fn command(&mut self, command: &str) -> String {
        writeln!(self.child.stdin.as_mut().unwrap(), "{command}").unwrap();
        let mut line = String::new(); self.output.read_line(&mut line).unwrap(); line.trim().to_owned()
    }
    fn authority(&self) -> String { STANDARD.encode(std::fs::read(self.root.join("ca.der")).unwrap()) }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.root); }
}

fn http(helper: &mut Helper, lease: &Value, input: Value) -> (Result<Value, String>, String) {
    let id = helper.ok("net_allocate", json!({"kind": "http", "document": lease})).as_str().unwrap().to_owned();
    let reply = helper.call("net_http_open", json!({"id": id, "input": input}));
    match reply.get("error") {
        Some(error) => (Err(error["code"].as_str().unwrap().to_owned()), id),
        None => (Ok(reply["result"].clone()), id),
    }
}
fn read_all(helper: &mut Helper, id: &str) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let chunk = helper.ok("net_http_read", json!({"id": id}));
        let data = chunk["data"].as_str().unwrap();
        assert!(data.len() <= 349_528);
        if data.is_empty() { return body; }
        body.extend(STANDARD.decode(data).unwrap());
    }
}

#[test]
fn invalid_startup_arguments_exit_without_protocol_output() {
    let output = Command::new(env!("CARGO_BIN_EXE_tarobot-desktop-core")).args(["--state-dir", "relative"]).output().unwrap();
    assert_eq!(output.status.code(), Some(64));
    assert!(output.stdout.is_empty());
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "invalid_arguments\n");
    let output = Command::new(env!("CARGO_BIN_EXE_tarobot-desktop-core"))
        .args(["--state-dir", "/tmp/a", "--keyring-service", "svc", "--resources-dir", "/tmp/r", "--host-state-dir", "/tmp/data/host"]).output().unwrap();
    assert_eq!((output.status.code(), output.stdout.is_empty()), (Some(64), true));
    assert_eq!(String::from_utf8(output.stderr).unwrap(), "invalid_host_state_dir\n");
}

#[test]
fn idle_helper_exits_cleanly_on_stdin_eof() {
    let mut helper = Helper::start(&lab("eof"), &[]);
    assert_eq!(helper.ok("helper_info", json!({}))["protocol"], 1);
    let started = Instant::now();
    assert!(helper.finish().success());
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn pinned_http_streams_base64_chunks_and_rejects_substituted_or_untrusted_certificates() {
    let mut fixture = Fixture::start();
    let mut helper = Helper::start(&lab("http"), &[]);
    let (hub, key, rotating, proxy, ca) = (fixture.value("hub"), fixture.value("key"), fixture.value("rotating"), fixture.value("proxy"), fixture.authority());
    let lease = helper.ok("net_document", json!({}));
    let get = |origin: &str, path: &str| json!({"origin": origin, "hubKey": key, "certificateAuthority": ca, "path": path, "method": "GET", "headers": [], "body": null});

    let (head, id) = http(&mut helper, &lease, get(&hub, "/health"));
    assert_eq!(head.unwrap()["status"], 200);
    let health: Value = serde_json::from_slice(&read_all(&mut helper, &id)).unwrap();
    assert_eq!(health["publicKey"], key.as_str());
    assert_eq!(helper.error("net_http_read", json!({"id": id})), "native_request_cancelled", "EOF releases the slot");

    // Large body: every read is at most 256 KiB, then an explicit cancel.
    let (head, id) = http(&mut helper, &lease, get(&rotating, "/api/large"));
    assert_eq!(head.unwrap()["status"], 200);
    for _ in 0..6 {
        let bytes = STANDARD.decode(helper.ok("net_http_read", json!({"id": id}))["data"].as_str().unwrap()).unwrap();
        assert!(!bytes.is_empty() && bytes.len() <= 256 * 1024 && bytes.iter().all(|b| *b == b'a'));
    }
    assert_eq!(helper.ok("net_cancel", json!({"id": id})), Value::Null);
    assert_eq!(helper.error("net_http_read", json!({"id": id})), "native_request_cancelled");

    // Upload round trip of a 1 MiB binary body.
    let body: Vec<u8> = (0..1024 * 1024).map(|i| (i % 251) as u8).collect();
    let mut post = get(&rotating, "/api/echo");
    post["method"] = "POST".into(); post["body"] = STANDARD.encode(&body).into();
    post["headers"] = json!([["Content-Type", "application/octet-stream"]]);
    let (head, id) = http(&mut helper, &lease, post.clone());
    assert_eq!(head.unwrap()["status"], 200);
    assert_eq!(read_all(&mut helper, &id), body);

    // Rejections keep their Tauri codes and never fall back to an unpinned route.
    assert_eq!(http(&mut helper, &lease, get(&rotating, "/api/redirect")).0.unwrap_err(), "hub_redirect_rejected");
    assert_eq!(http(&mut helper, &lease, get(&proxy, "/health")).0.unwrap_err(), "tls_identity_mismatch");
    let mut untrusted = get(&hub, "/health"); untrusted.as_object_mut().unwrap().remove("certificateAuthority");
    assert_eq!(http(&mut helper, &lease, untrusted).0.unwrap_err(), "tls_connection_failed");
    let mut keyless = get(&hub, "/health"); keyless["hubKey"] = Value::Null;
    assert_eq!(http(&mut helper, &lease, keyless).0.unwrap_err(), "trusted_hub_key_required");
    assert_eq!(http(&mut helper, &lease, get(&hub, "/api/instance/status")).0.unwrap_err(), "invalid_hub_path");
    let mut header = get(&hub, "/health"); header["headers"] = json!([["Cookie", "x"]]);
    assert_eq!(http(&mut helper, &lease, header).0.unwrap_err(), "invalid_http_headers");
    // Tauri limits: decoded size first within the base64 bound, then the bound itself.
    let mut oversized = post; oversized["body"] = STANDARD.encode(vec![0u8; 8 * 1024 * 1024 + 1]).into();
    assert_eq!(http(&mut helper, &lease, oversized.clone()).0.unwrap_err(), "invalid_http_body");
    oversized["body"] = STANDARD.encode(vec![0u8; 8 * 1024 * 1024 + 3]).into();
    assert_eq!(http(&mut helper, &lease, oversized).0.unwrap_err(), "native_body_too_large");

    // Legitimate Hub certificate rotation: the established pin rejects the new
    // certificate and forgets the route; the next request re-proves identity.
    assert_eq!(fixture.command("rotate"), "ok");
    assert_eq!(http(&mut helper, &lease, get(&rotating, "/health")).0.unwrap_err(), "native_request_failed");
    let (head, id) = http(&mut helper, &lease, get(&rotating, "/health"));
    assert_eq!(head.unwrap()["status"], 200);
    assert_eq!(read_all(&mut helper, &id), br#"{"ok":true}"#);
    assert_eq!(fixture.command("rotate-back"), "ok");
    assert!(helper.finish().success());
}

#[test]
fn sockets_deliver_ordered_credited_events_and_retire_with_their_document() {
    let fixture = Fixture::start();
    let mut helper = Helper::start(&lab("socket"), &[]);
    let (rotating, key, ca) = (fixture.value("rotating"), fixture.value("key"), fixture.authority());
    let lease = helper.ok("net_document", json!({}));
    let open = |helper: &mut Helper, channel: &str| -> String {
        let id = helper.ok("net_allocate", json!({"kind": "socket", "document": lease})).as_str().unwrap().to_owned();
        // The response is written before any event of this socket.
        assert_eq!(helper.ok("net_socket_open", json!({"id": id, "origin": rotating, "hubKey": key, "certificateAuthority": ca, "channel": channel})), Value::Null);
        assert!(helper.events.iter().all(|e| e["channel"] != channel));
        let event = helper.event(channel, Duration::from_secs(10)).unwrap();
        assert_eq!(event, json!({"event": "transport", "document": lease, "channel": channel, "payload": {"kind": "open"}}));
        id
    };
    let id = open(&mut helper, "c1");
    helper.ok("net_socket_send", json!({"id": id, "text": "hello"}));
    let message = helper.event("c1", Duration::from_secs(5)).unwrap();
    assert_eq!(message["payload"], json!({"kind": "message", "data": "hello", "sequence": 1}));
    helper.ok("net_socket_ack", json!({"id": id, "sequence": 1}));
    // Nine messages against eight credits: the ninth waits for a receipt.
    helper.ok("net_socket_send", json!({"id": id, "text": "$audit:burst"}));
    let mut sequences = Vec::new();
    while let Some(event) = helper.event("c1", Duration::from_millis(800)) { sequences.push(event["payload"]["sequence"].as_u64().unwrap()); }
    assert_eq!(sequences, (2..=9).collect::<Vec<_>>());
    assert_eq!(helper.error("net_socket_ack", json!({"id": id, "sequence": 11})), "invalid_socket_receipt");
    helper.ok("net_socket_ack", json!({"id": id, "sequence": 9}));
    let last = helper.event("c1", Duration::from_secs(5)).unwrap();
    assert_eq!(last["payload"], json!({"kind": "message", "data": "receipt-8", "sequence": 10}));
    helper.ok("net_socket_ack", json!({"id": id, "sequence": 10}));
    helper.ok("net_socket_send", json!({"id": id, "text": "$audit:peer-close"}));
    let close = helper.event("c1", Duration::from_secs(5)).unwrap();
    assert_eq!(close["payload"], json!({"kind": "close", "code": 3333, "reason": "peer done", "clean": true}));
    assert_eq!(helper.ok("net_socket_close", json!({"id": id, "code": 1000, "reason": ""})), false);

    // Client close.
    let id = open(&mut helper, "c2");
    assert_eq!(helper.error("net_socket_close", json!({"id": id, "code": 1001, "reason": ""})), "invalid_socket_close");
    assert_eq!(helper.ok("net_socket_close", json!({"id": id, "code": 1000, "reason": "bye"})), true);
    let close = helper.event("c2", Duration::from_secs(10)).unwrap();
    assert_eq!(close["payload"]["kind"], "close");
    assert_eq!(close["payload"]["code"], 1000);

    // A new document claim retires the old lease and closes its sockets,
    // whose final event still names the retired document.
    let id = open(&mut helper, "c3");
    let next = helper.ok("net_document", json!({}));
    assert_ne!(next, lease);
    let close = helper.event("c3", Duration::from_secs(5)).unwrap();
    assert_eq!(close, json!({"event": "transport", "document": lease, "channel": "c3", "payload": {"kind": "close", "code": 1006, "reason": "", "clean": false}}));
    assert_eq!(helper.error("net_socket_send", json!({"id": id, "text": "late"})), "native_request_cancelled");
    assert_eq!(helper.error("net_allocate", json!({"kind": "socket", "document": lease})), "native_document_retired");

    // net_reset (main process on navigation) retires the current lease too.
    let id = helper.ok("net_allocate", json!({"kind": "socket", "document": next})).as_str().unwrap().to_owned();
    helper.ok("net_reset", json!({}));
    assert_eq!(helper.error("net_socket_open", json!({"id": id, "origin": rotating, "hubKey": key, "certificateAuthority": ca, "channel": "c4"})), "native_request_cancelled");
    assert_eq!(helper.error("net_allocate", json!({"kind": "http", "document": next})), "native_document_retired");
    assert!(helper.finish().success());
}

#[test]
fn stdin_eof_cancels_open_sockets_and_exits_promptly() {
    let fixture = Fixture::start();
    let mut helper = Helper::start(&lab("eof-socket"), &[]);
    let lease = helper.ok("net_document", json!({}));
    let id = helper.ok("net_allocate", json!({"kind": "socket", "document": lease})).as_str().unwrap().to_owned();
    helper.ok("net_socket_open", json!({"id": id, "origin": fixture.value("rotating"), "hubKey": fixture.value("key"), "certificateAuthority": fixture.authority(), "channel": "c1"}));
    assert_eq!(helper.event("c1", Duration::from_secs(10)).unwrap()["payload"]["kind"], "open");
    let http = helper.ok("net_allocate", json!({"kind": "http", "document": lease})).as_str().unwrap().to_owned();
    let input = json!({"origin": fixture.value("rotating"), "hubKey": fixture.value("key"), "certificateAuthority": fixture.authority(), "path": "/api/hang", "method": "GET", "headers": [], "body": null});
    assert_eq!(helper.ok("net_http_open", json!({"id": http, "input": input}))["status"], 200);
    // A read that would block forever on the hanging body.
    writeln!(helper.stdin.as_mut().unwrap(), "{}", json!({"id": 999, "command": "net_http_read", "args": {"id": http}})).unwrap();
    let started = Instant::now();
    drop(helper.stdin.take());
    let mut saw_cancel = false;
    while let Some(line) = helper.line(Duration::from_secs(5)) {
        if line["id"] == 999 { assert_eq!(line["error"]["code"], "native_request_cancelled"); saw_cancel = true; }
    }
    assert!(saw_cancel);
    let status = helper.finish();
    assert!(status.success());
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

#[cfg(unix)]
#[test]
fn desktop_host_uses_only_startup_paths_and_a_clean_node_environment() {
    let root = lab("host");
    let resources = root.join("resources/host");
    std::fs::create_dir_all(resources.join("dist/src")).unwrap();
    let node = String::from_utf8(Command::new("/bin/sh").args(["-c", "command -v node"]).output().unwrap().stdout).unwrap();
    std::os::unix::fs::symlink(node.trim(), resources.join("node")).unwrap();
    std::fs::write(resources.join("dist/src/index.js"), "let i='';process.stdin.on('data',c=>i+=c).on('end',()=>console.log(JSON.stringify({running:false,argv:process.argv.slice(2),stdin:i,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null})))").unwrap();
    let mut helper = Helper::start(&root, &[("NODE_OPTIONS", "--require=/nonexistent/inject.js"), ("NODE_PATH", "/nonexistent")]);
    let result = helper.ok("desktop_host", json!({"action": "status"}));
    assert_eq!(result["argv"], json!(["desktop-host", "status", root.join("data/com.tarobot.client/host")]));
    assert_eq!((result["stdin"].as_str(), &result["nodeOptions"], &result["nodePath"]), (Some("null"), &Value::Null, &Value::Null));
    assert_eq!(helper.error("desktop_host", json!({"action": "status", "resources": "/bin"})), "invalid_arguments");
    assert_eq!(helper.error("desktop_host", json!({"action": "--help"})), "invalid_desktop_host_action");
    assert!(helper.finish().success());
}

/// Opt-in: writes and deletes one item under a unique test service in the OS
/// credential store. Reported as ignored unless run with `--ignored`.
#[test]
#[ignore = "touches the OS credential store; run with --ignored and TAROBOT_DESKTOP_CORE_KEYCHAIN_TEST=1"]
fn os_credential_store_round_trip_with_an_isolated_service() {
    assert!(std::env::var_os("TAROBOT_DESKTOP_CORE_KEYCHAIN_TEST").is_some(), "set TAROBOT_DESKTOP_CORE_KEYCHAIN_TEST=1 to confirm");
    let root = lab("keychain");
    let service = format!("com.tarobot.client.device.e2e-{}", uuid::Uuid::new_v4().simple());
    let mut child = Command::new(env!("CARGO_BIN_EXE_tarobot-desktop-core"))
        .args(["--state-dir"]).arg(root.join("state")).args(["--keyring-service", &service])
        .args(["--resources-dir"]).arg(root.join("resources/host")).args(["--host-state-dir"]).arg(root.join("data/com.tarobot.client"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, lines) = mpsc::channel();
    std::thread::spawn(move || for line in BufReader::new(stdout).lines() { if send.send(line.unwrap()).is_err() { return; } });
    let mut helper = Helper { stdin: child.stdin.take(), child, lines, events: Vec::new(), next: 1, root: root.clone() };
    let created = helper.ok("device_create", json!({}));
    let id = created["deviceId"].as_str().unwrap().to_owned();
    let signature = helper.ok("device_sign", json!({"keyRef": id, "deviceId": id, "nonce": "server", "clientNonce": "client"}));
    let spki = STANDARD.decode(created["publicKey"].as_str().unwrap()).unwrap();
    let key = ed25519_dalek::VerifyingKey::from_bytes(spki[12..].try_into().unwrap()).unwrap();
    let signature = ed25519_dalek::Signature::from_slice(&STANDARD.decode(signature.as_str().unwrap()).unwrap()).unwrap();
    key.verify_strict(format!("tarocub/device/v1\0{id}\0server\0client").as_bytes(), &signature).unwrap();
    assert_eq!(helper.ok("device_forget", json!({"keyRef": id})), Value::Null);
    assert_eq!(helper.error("device_sign", json!({"keyRef": id, "deviceId": id, "nonce": "n", "clientNonce": "c"})), "device_key_unavailable");
    assert!(helper.finish().success());
}
