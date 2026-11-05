use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::{Client, Response, Url};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_tungstenite::{
    tungstenite::{
        handshake::derive_accept_key,
        protocol::{Role, WebSocketConfig},
    },
    WebSocketStream,
};

const PIN_AGE: Duration = Duration::from_secs(300);
const MAX_ROUTES: usize = 64;
const MAX_PROOF: usize = 4096;
pub const MAX_FRAME: usize = 1024 * 1024;

#[derive(Debug)]
struct PinnedVerifier {
    normal: Arc<dyn ServerCertVerifier>,
    leaf: [u8; 32],
}
impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let verified = self
            .normal
            .verify_server_cert(leaf, chain, name, ocsp, now)?;
        if Sha256::digest(leaf.as_ref()).as_slice() != self.leaf {
            return Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(verified)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.normal.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.normal.supported_verify_schemes()
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityProof {
    v: u8,
    r#type: String,
    public_key: String,
    nonce: String,
    certificate_sha256: String,
    signature: String,
}

fn hub_key(raw: &str) -> Result<VerifyingKey, String> {
    if raw.len() != 60 {
        return Err("invalid_hub_key".into());
    }
    let bytes = STANDARD.decode(raw).map_err(|_| "invalid_hub_key")?;
    const PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if bytes.len() != 44 || !bytes.starts_with(PREFIX) || STANDARD.encode(&bytes) != raw {
        return Err("invalid_hub_key".into());
    }
    VerifyingKey::from_bytes(bytes[12..].try_into().map_err(|_| "invalid_hub_key")?)
        .map_err(|_| "invalid_hub_key".into())
}

fn verify_proof(bytes: &[u8], key: &str, nonce: &str, observed: &[u8]) -> Result<[u8; 32], String> {
    let parsed: IdentityProof =
        serde_json::from_slice(bytes).map_err(|_| "tls_identity_mismatch")?;
    let fingerprint: [u8; 32] = Sha256::digest(observed).into();
    let hex = fingerprint
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if parsed.v != 1
        || parsed.r#type != "tls.identity"
        || parsed.public_key != key
        || parsed.nonce != nonce
        || parsed.certificate_sha256 != hex
    {
        return Err("tls_identity_mismatch".into());
    }
    // Exact cross-language UTF-8 transcript. All values are restricted ASCII;
    // in particular '/' is literal, never Foundation's escaped '\\/'.
    let proof = format!("[\"tarocub/tls-identity/v1\",\"{key}\",\"{nonce}\",\"{hex}\"]");
    let sig_bytes = STANDARD
        .decode(&parsed.signature)
        .map_err(|_| "tls_identity_mismatch")?;
    if STANDARD.encode(&sig_bytes) != parsed.signature {
        return Err("tls_identity_mismatch".into());
    }
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| "tls_identity_mismatch")?;
    hub_key(key)?
        .verify_strict(proof.as_bytes(), &sig)
        .map_err(|_| "tls_identity_mismatch")?;
    Ok(fingerprint)
}

pub fn origin(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "invalid_hub_origin")?;
    if raw.len() > 2048
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid_hub_origin".into());
    }
    if url.scheme() == "http" {
        if url.host_str() == Some("localhost") {
            url.set_host(Some("127.0.0.1"))
                .map_err(|_| "invalid_hub_origin")?;
        }
        if !matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]")) {
            return Err("https_required".into());
        }
    } else if url.scheme() != "https" {
        return Err("https_required".into());
    }
    Ok(url)
}

pub fn target(base: &Url, path: &str) -> Result<Url, String> {
    if path.len() > 8192 || !path.starts_with('/') || path.starts_with("//") || path.contains('\\')
    {
        return Err("invalid_hub_path".into());
    }
    let url = base.join(path).map_err(|_| "invalid_hub_path")?;
    if url.origin() != base.origin()
        || url.fragment().is_some()
        || !(url.path() == "/health" || url.path().starts_with("/api/"))
        || url.path().starts_with("/api/instance/")
    {
        return Err("invalid_hub_path".into());
    }
    Ok(url)
}

#[derive(Clone)]
pub struct VerifiedRoute {
    pub client: Client,
    pub base: Url,
    created: Instant,
}
type RouteSlot = Arc<Mutex<Option<VerifiedRoute>>>;
pub struct Network {
    normal: Arc<dyn ServerCertVerifier>,
    routes: Mutex<HashMap<String, RouteSlot>>,
    authorities: Mutex<HashMap<String, Arc<Network>>>,
}
impl Network {
    pub fn new() -> Result<Self, String> {
        let normal = rustls_platform_verifier::Verifier::new(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .map_err(|_| "system_tls_unavailable")?;
        Ok(Self {
            normal: Arc::new(normal),
            routes: Mutex::new(HashMap::new()),
            authorities: Mutex::new(HashMap::new()),
        })
    }
    #[cfg(any(test, feature = "native-transport-audit"))]
    pub fn with_verifier(normal: Arc<dyn ServerCertVerifier>) -> Self {
        Self {
            normal,
            routes: Mutex::new(HashMap::new()),
            authorities: Mutex::new(HashMap::new()),
        }
    }
    pub async fn prepare_with_ca(&self, raw: &str, key: Option<&str>, ca: Option<&str>) -> Result<VerifiedRoute, String> {
        let Some(ca) = ca else { return self.prepare(raw, key).await; };
        if ca.len() > 4096 || origin(raw)?.scheme() != "https" { return Err("invalid_host_authority".into()); }
        let identity = format!("{raw}\0{}\0{ca}", key.ok_or("trusted_hub_key_required")?);
        let network = {
            let mut authorities = self.authorities.lock().await;
            if let Some(existing) = authorities.get(&identity) { existing.clone() } else {
                let der = STANDARD.decode(ca).map_err(|_| "invalid_host_authority")?;
                let mut roots = rustls::RootCertStore::empty();
                roots.add(CertificateDer::from(der)).map_err(|_| "invalid_host_authority")?;
                let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(rustls::crypto::ring::default_provider()))
                    .build().map_err(|_| "invalid_host_authority")?;
                let network = Arc::new(Network { normal: verifier, routes: Mutex::new(HashMap::new()), authorities: Mutex::new(HashMap::new()) });
                if authorities.len() >= MAX_ROUTES { authorities.clear(); }
                authorities.insert(identity, network.clone()); network
            }
        };
        network.prepare(raw, key).await
    }
    fn client(&self, pin: Option<[u8; 32]>) -> Result<Client, String> {
        let verifier: Arc<dyn ServerCertVerifier> = match pin {
            Some(leaf) => Arc::new(PinnedVerifier {
                normal: self.normal.clone(),
                leaf,
            }),
            None => self.normal.clone(),
        };
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "system_tls_unavailable")?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
        // Every new physical connection presents and verifies its certificate.
        // rustls rejects TLS renegotiation; pooled connections retain their pin.
        tls.resumption = rustls::client::Resumption::disabled();
        Client::builder()
            .tls_backend_preconfigured(tls)
            .tls_info(true)
            .http1_only()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "native_transport_unavailable".into())
    }
    pub async fn prepare(&self, raw: &str, key: Option<&str>) -> Result<VerifiedRoute, String> {
        let base = origin(raw)?;
        if base.scheme() == "http" {
            return Ok(VerifiedRoute {
                client: self.client(None)?,
                base,
                created: Instant::now(),
            });
        }
        let key = key
            .filter(|v| !v.is_empty())
            .ok_or("trusted_hub_key_required")?;
        hub_key(key)?;
        let cache_key = format!("{}\0{key}", base.origin().ascii_serialization());
        let slot = {
            let mut routes = self.routes.lock().await;
            if !routes.contains_key(&cache_key) && routes.len() >= MAX_ROUTES {
                routes.clear();
            }
            routes
                .entry(cache_key)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut cached = slot.lock().await;
        if let Some(route) = cached.as_ref().filter(|r| r.created.elapsed() < PIN_AGE) {
            return Ok(route.clone());
        }
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "secure_random_unavailable")?;
        let nonce = URL_SAFE_NO_PAD.encode(random);
        // Bootstrap carries only a fresh nonce, never a device ID or credential.
        let mut response = self
            .client(None)?
            .get(
                base.join(&format!("/api/tls-identity?nonce={nonce}"))
                    .map_err(|_| "invalid_hub_origin")?,
            )
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| "tls_connection_failed")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("hub_tls_identity_required".into());
        }
        let certificate = response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(|v| v.peer_certificate())
            .ok_or("tls_certificate_unavailable")?
            .to_vec();
        let mut body = Vec::new();
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| "tls_identity_unavailable")?
        {
            if body.len() + bytes.len() > MAX_PROOF {
                return Err("tls_identity_too_large".into());
            }
            body.extend_from_slice(&bytes);
        }
        let pin = verify_proof(&body, key, &nonce, &certificate)?;
        let route = VerifiedRoute {
            client: self.client(Some(pin))?,
            base,
            created: Instant::now(),
        };
        *cached = Some(route.clone());
        Ok(route)
    }
    pub async fn forget(&self, raw: &str, key: Option<&str>) {
        if let Ok(base) = origin(raw) {
            let cache_key = format!("{}\0{}", base.origin().ascii_serialization(), key.unwrap_or(""));
            self.routes.lock().await.remove(&cache_key);
            for network in self.authorities.lock().await.values() {
                network.routes.lock().await.remove(&cache_key);
            }
        }
    }
}

pub async fn websocket(
    route: &VerifiedRoute,
) -> Result<WebSocketStream<reqwest::Upgraded>, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "secure_random_unavailable")?;
    let key = STANDARD.encode(random);
    let response: Response = route
        .client
        .get(route.base.join("/ws").map_err(|_| "invalid_hub_origin")?)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", &key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| "native_socket_failed")?;
    let headers = response.headers();
    if response.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS
        || headers
            .get("Sec-WebSocket-Accept")
            .and_then(|v| v.to_str().ok())
            != Some(derive_accept_key(key.as_bytes()).as_str())
        || !headers
            .get("Upgrade")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.eq_ignore_ascii_case("websocket"))
        || !headers
            .get("Connection")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| {
                s.split(',')
                    .any(|p| p.trim().eq_ignore_ascii_case("upgrade"))
            })
        || headers.contains_key("Sec-WebSocket-Extensions")
        || headers.contains_key("Sec-WebSocket-Protocol")
    {
        return Err("native_socket_handshake_invalid".into());
    }
    let stream = response
        .upgrade()
        .await
        .map_err(|_| "native_socket_failed")?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME));
    Ok(WebSocketStream::from_raw_socket(stream, Role::Client, Some(config)).await)
}
