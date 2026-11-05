#[path = "../src/transport/core.rs"]
mod core;
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

struct Fixture {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
    root: PathBuf,
    info: serde_json::Value,
}
impl Fixture {
    fn start() -> Self {
        let root = std::env::temp_dir().join(format!("native-tls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node")
            .args(["--import", "tsx", "tests/helpers/native-tls-fixture.ts"])
            .arg(&root)
            .current_dir(repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let info = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_dir_all(&root);
                panic!("fixture startup: {e}");
            }
        };
        Self {
            child,
            output,
            root,
            info,
        }
    }
    fn value(&self, key: &str) -> String {
        self.info[key].as_str().unwrap().to_owned()
    }
    fn command(&mut self, command: &str) -> String {
        writeln!(self.child.stdin.as_mut().unwrap(), "{command}").unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        line.trim().to_owned()
    }
    fn network(&self) -> core::Network {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                std::fs::read(self.root.join("ca.der")).unwrap(),
            ))
            .unwrap();
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(roots),
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .unwrap();
        core::Network::with_verifier(verifier)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn origins_and_paths_cannot_escape_the_hub() {
    for bad in [
        "http://example.com",
        "file:///etc/passwd",
        "https://user:pass@host",
        "https://host/path",
        "https://host/#x",
        "https://host/?x",
    ] {
        assert!(core::origin(bad).is_err(), "{bad}");
    }
    let base = core::origin("https://hub.example").unwrap();
    for bad in [
        "//evil/api/x",
        "/\\evil/api/x",
        "/api/../secret",
        "/api/instance/status",
        "/api/x#fragment",
        "/api/%2e%2e/private",
    ] {
        assert!(core::target(&base, bad).is_err(), "{bad}");
    }
    assert_eq!(
        core::origin("http://localhost:1234").unwrap().host_str(),
        Some("127.0.0.1")
    );
    assert!(core::target(&base, "/api/attachments/a?offset=1").is_ok());
}

#[tokio::test]
async fn real_tls_pins_cover_http_websocket_rotation_and_large_streams() {
    let mut fixture = Fixture::start();
    let network = fixture.network();
    let key = fixture.value("key");
    let hub = fixture.value("hub");
    let proxy = fixture.value("proxy");
    let rotating = fixture.value("rotating");
    assert!(network
        .prepare(&hub, None)
        .await
        .err()
        .unwrap()
        .contains("trusted_hub_key_required"));
    assert!(
        core::Network::new()
            .unwrap()
            .prepare(&hub, Some(&key))
            .await
            .is_err(),
        "system trust must reject the isolated CA"
    );
    assert!(
        network
            .prepare(&hub.replace("127.0.0.1", "localhost"), Some(&key))
            .await
            .is_err(),
        "CA trust must not bypass hostnames"
    );
    let route = network.prepare(&hub, Some(&key)).await.unwrap();
    let health: serde_json::Value = serde_json::from_str(
        &route
            .client
            .get(core::target(&route.base, "/health").unwrap())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(health["publicKey"], key);
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    let device = SigningKey::from_bytes(&seed);
    let mut spki = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    spki.extend(device.verifying_key().as_bytes());
    let mut pairing_body = serde_json::json!({"deviceId":"native-test-device","name":"Isolated native test","platform":"macos","publicKey":STANDARD.encode(spki)});
    let uninvited = route.client.post(core::target(&route.base, "/api/pair").unwrap()).body(pairing_body.to_string()).send().await.unwrap();
    assert_eq!(uninvited.status(), 403);
    let rejected: serde_json::Value = serde_json::from_str(&uninvited.text().await.unwrap()).unwrap();
    assert_eq!(rejected["error"], "pairing_invite_required");
    pairing_body["invite"] = fixture.value("invite").into();
    let mut request_id = [0u8; 32];
    getrandom::fill(&mut request_id).unwrap();
    pairing_body["requestId"] = URL_SAFE_NO_PAD.encode(request_id).into();
    let pairing = route.client.post(core::target(&route.base, "/api/pair").unwrap()).body(pairing_body.to_string()).send().await.unwrap();
    let pairing_status = pairing.status();
    let pairing: serde_json::Value = serde_json::from_str(&pairing.text().await.unwrap()).unwrap();
    assert!(pairing_status.is_success(), "pairing {pairing_status}: {pairing}");
    assert_eq!(
        fixture.command(&format!("approve:{}", pairing["code"].as_str().unwrap())),
        "ok"
    );
    let mut ws = core::websocket(&route).await.unwrap();
    let nonce = "a".repeat(43);
    ws.send(tokio_tungstenite::tungstenite::Message::Text(serde_json::json!({ "v":1,"type":"hello","deviceId":"native-test-device","nonce":nonce,"protocolVersions":[1],"capabilities":[],"cursors":{} }).to_string().into())).await.unwrap();
    let challenge = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap();
    let challenge: serde_json::Value = serde_json::from_str(&challenge).unwrap();
    assert_eq!(challenge["type"], "challenge");
    let signature = device.sign(
        format!(
            "tarocub/device/v1\0native-test-device\0{}\0{nonce}",
            challenge["nonce"].as_str().unwrap()
        )
        .as_bytes(),
    );
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({"v":1,"type":"auth","signature":STANDARD.encode(signature.to_bytes())})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
    assert_eq!(ready["type"], "ready");
    let content = route
        .client
        .get(core::target(&route.base, "/api/conversations").unwrap())
        .bearer_auth(ready["sessionToken"].as_str().unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(content.status(), 200);
    assert_eq!(content.text().await.unwrap(), "[]");
    drop(ws);
    // The terminating peer has a different but otherwise valid same-CA leaf.
    assert_eq!(
        network.prepare(&proxy, Some(&key)).await.err().unwrap(),
        "tls_identity_mismatch"
    );
    let route = network.prepare(&rotating, Some(&key)).await.unwrap();
    let payload = vec![0x61; 8 * 1024 * 1024];
    let echoed = route
        .client
        .post(core::target(&route.base, "/api/echo").unwrap())
        .header("Authorization", "synthetic-only")
        .body(payload.clone())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(echoed.as_ref(), payload);
    let redirect = route
        .client
        .get(core::target(&route.base, "/api/redirect").unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), 307);
    let mut ws = core::websocket(&route).await.unwrap();
    // The HTTP upgrade's five-second timeout must not kill an established WS.
    tokio::time::sleep(Duration::from_secs(10)).await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        "native-echo".into(),
    ))
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap(),
        "native-echo"
    );
    drop(ws);
    // Bootstrap-to-request race, including a pooled client opening new sockets.
    assert_eq!(fixture.command("rotate"), "ok");
    assert!(route
        .client
        .post(core::target(&route.base, "/api/echo").unwrap())
        .header("Authorization", "synthetic-only")
        .body("must-not-arrive")
        .send()
        .await
        .is_err());
    assert!(core::websocket(&route).await.is_err());
    network.forget(&rotating, Some(&key)).await;
    let renewed = network.prepare(&rotating, Some(&key)).await.unwrap();
    let mut response = renewed
        .client
        .get(core::target(&renewed.base, "/api/large").unwrap())
        .send()
        .await
        .unwrap();
    let mut hash = Sha256::new();
    let mut length = 0;
    while let Some(chunk) = response.chunk().await.unwrap() {
        length += chunk.len();
        hash.update(&chunk);
    }
    let mut expected = Sha256::new();
    for _ in 0..64 {
        expected.update(&payload);
    }
    assert_eq!(length, 512 * 1024 * 1024);
    assert_eq!(hash.finalize(), expected.finalize());
    let stats: serde_json::Value = serde_json::from_str(&fixture.command("stats")).unwrap();
    assert_eq!(stats["sensitive"], 0);
    assert_eq!(stats["proofs"], 1);
}

#[tokio::test]
async fn qr_authority_is_scoped_and_keeps_hostname_and_identity_checks() {
    let fixture = Fixture::start();
    let network = core::Network::new().unwrap();
    let hub = fixture.value("hub");
    let key = fixture.value("key");
    let ca = STANDARD.encode(std::fs::read(fixture.root.join("ca.der")).unwrap());
    assert!(network.prepare(&hub, Some(&key)).await.is_err());
    assert!(network.prepare_with_ca(&hub, Some(&key), Some(&ca)).await.is_ok());
    assert!(network.prepare_with_ca(&hub.replace("127.0.0.1", "localhost"), Some(&key), Some(&ca)).await.is_err());
    assert!(network.prepare(&hub, Some(&key)).await.is_err());
    assert!(network.prepare_with_ca(&hub, Some(&key), Some("invalid")).await.is_err());
}
