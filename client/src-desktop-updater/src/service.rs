// Installers exist for macOS bundles and Windows NSIS; elsewhere `check`
// reports the gap.
#![cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
//! The Tauri `github_updates` command semantics, hosted outside Tauri: login,
//! check, install and close share one lifecycle lock and generation fences.
//! Private release credentials and updater resources never cross the protocol.
use crate::{
    config::{Args, Provider, PublicConfig, Settings},
    credential::{epoch_seconds, valid_device_code, valid_login, valid_user_code, Credential},
    manifest, net,
    policy::{self, FlowCadence, Generation, GithubConfig, MAX_INSTALLER_BYTES, MAX_MANIFEST_BYTES},
    signature::Verifier,
    transport,
    vault::{self, Vault},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started {
        #[serde(rename = "contentLength", skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: u64,
    },
    Finished,
    WaitingForHost,
    Installing,
    RestartingHost,
}
pub type Emit = Arc<dyn Fn(&str, DownloadEvent) + Send + Sync>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub configured: bool,
    pub version: String,
    pub provider: &'static str,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// Public release repository: no GitHub sign-in is offered or needed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub public: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: &'static str,
    pub expires_in: u64,
    pub interval: u64,
}
#[derive(Debug, Serialize)]
pub struct LoginPoll {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
}
impl LoginPoll {
    fn pending(interval: u64) -> Self {
        Self { status: "pending", interval: Some(interval) }
    }
    fn authorized() -> Self {
        Self { status: "authorized", interval: None }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub offer_id: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Cancels download, staging and the Host drain wait. The replacement itself
/// runs under the lifecycle lock and cannot be interrupted part-way.
#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}
impl Cancel {
    fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
    fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
    async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.cancelled() {
                return;
            }
            notified.await;
        }
    }
    async fn guard<T>(&self, work: impl std::future::Future<Output = T>) -> Result<T, String> {
        tokio::select! {
            result = work => Ok(result),
            _ = self.wait() => Err("github_update_cancelled".into()),
        }
    }
}

struct DeviceFlow {
    id: String,
    code: Zeroizing<String>,
    cadence: FlowCadence,
    authorized: bool,
}
enum Source {
    /// GitHub asset with the size GitHub declared for it; no token when the
    /// release repository is public.
    Github { token: Option<Zeroizing<String>>, size: u64 },
    Public,
}
struct Offer {
    id: String,
    version: String,
    url: String,
    signature: String,
    source: Source,
}
struct Installing {
    id: String,
    cancel: Arc<Cancel>,
}
#[derive(Default)]
struct Inner {
    generation: Generation,
    checks: Generation,
    flow: Option<DeviceFlow>,
    offer: Option<Offer>,
    install: Option<Installing>,
}
impl Inner {
    fn finish_login(&mut self) {
        // Keep only the completed ID so a cancel queued during credential
        // persistence can still revoke exactly that login.
        if let Some(flow) = self.flow.as_mut() {
            flow.authorized = true;
            flow.code.zeroize();
        }
        self.offer = None;
        self.checks.advance();
        self.generation.advance();
    }
    fn cancel_flow(&mut self, id: &str) -> Option<bool> {
        let flow = self.flow.as_ref().filter(|flow| flow.id == id)?;
        let authorized = flow.authorized;
        self.invalidate();
        Some(authorized)
    }
    fn invalidate(&mut self) -> u64 {
        self.flow = None;
        self.offer = None;
        if let Some(install) = self.install.take() {
            install.cancel.cancel();
        }
        self.checks.advance();
        self.generation.advance()
    }
    fn installing(&self, generation: u64, id: &str) -> bool {
        self.generation.matches(generation) && self.install.as_ref().is_some_and(|install| install.id == id)
    }
}

pub struct Service {
    args: Args,
    settings: Settings,
    vault: Option<Arc<dyn Vault>>,
    inner: Mutex<Inner>,
    emit: Emit,
    /// Windows: a verified NSIS installer to start once Electron has exited.
    handoff: std::sync::Mutex<Option<PathBuf>>,
}

/// Download scratch space: private, outside the bundle, removed on drop.
struct WorkDir(PathBuf);
impl WorkDir {
    fn create(root: &std::path::Path) -> Result<Self, String> {
        #[cfg(unix)]
        use std::os::unix::fs::DirBuilderExt;
        std::fs::create_dir_all(root).map_err(|_| "github_update_install")?;
        let path = root.join(format!("tarobot-update-{}", uuid::Uuid::new_v4()));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(&path).map_err(|_| "github_update_install")?;
        Ok(Self(path))
    }
}
impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One install per App across processes. Electron main may start a fresh
/// updater after losing contact with one that is still replacing the bundle;
/// the OS releases this lock when the owning process exits.
struct InstallLock(std::fs::File);
impl InstallLock {
    fn acquire(root: &std::path::Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|_| "github_update_install")?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(".install.lock"))
            .map_err(|_| "github_update_install")?;
        match file.try_lock() {
            Ok(()) => Ok(Self(file)),
            Err(std::fs::TryLockError::WouldBlock) => Err("github_update_busy".into()),
            Err(_) => Err("github_update_install".into()),
        }
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        // Closing our descriptor alone can leave the lock held by a concurrent
        // fork until its CLOEXEC descriptors close. End the installation lock
        // with this guard, rather than with the last inherited descriptor.
        let _ = self.0.unlock();
    }
}

/// macOS replaces the app bundle in place. Windows hands a verified NSIS
/// installer to the OS after Electron exits, as the Tauri updater did. Other
/// platforms report a configuration gap instead of an uninstallable offer.
pub const INSTALL_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));
const PROGRESS_BYTES: u64 = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

impl Service {
    pub fn new(args: Args, settings: Settings, vault: Option<Arc<dyn Vault>>, emit: Emit) -> Self {
        Self { args, settings, vault, inner: Mutex::new(Inner::default()), emit, handoff: std::sync::Mutex::new(None) }
    }

    fn github(&self) -> Result<&GithubConfig, String> {
        match &self.settings.provider {
            Provider::Github(Ok(config)) if self.settings.pubkey.is_some() => Ok(config),
            _ => Err("github_update_configuration".into()),
        }
    }
    fn public(&self) -> Result<&PublicConfig, String> {
        match &self.settings.provider {
            Provider::Default(Some(config)) => Ok(config),
            _ => Err("github_update_configuration".into()),
        }
    }
    fn vault(&self) -> Result<Arc<dyn Vault>, String> {
        self.vault.clone().ok_or_else(|| "github_update_keychain".into())
    }
    async fn oauth(&self, path: &str, body: Value) -> Result<Value, String> {
        net::oauth_with(transport::github(false)?, path, body).await
    }

    async fn credential(&self, config: &GithubConfig) -> Result<Option<Credential>, String> {
        let stored = vault::run(&self.vault()?, |vault| match vault.get()? {
            None => Ok(None),
            Some(secret) => Credential::from_stored(&secret).map(Some),
        })
        .await?;
        let Some(stored) = stored else {
            return Ok(None);
        };
        let now = epoch_seconds()?;
        if !stored.needs_refresh(now) {
            return Ok(Some(stored));
        }
        let Some(refresh) = stored.usable_refresh(now) else {
            return Ok(None);
        };
        // The caller holds the lifecycle mutex, serializing rotation with logout.
        // Device-flow tokens can refresh without an embedded client secret.
        let response = self
            .oauth(
                "oauth/access_token",
                json!({"client_id":config.client_id,"grant_type":"refresh_token","refresh_token":refresh}),
            )
            .await?;
        if response.get("error").is_some() {
            return Ok(None);
        }
        let refreshed = Credential::from_response(response, stored.login.clone(), now)?;
        self.persist(&refreshed).await?;
        Ok(Some(refreshed))
    }
    async fn persist(&self, credential: &Credential) -> Result<(), String> {
        let secret = credential.to_secret()?;
        vault::run(&self.vault()?, move |vault| vault.set(&secret)).await
    }
    async fn forget(&self) -> Result<(), String> {
        vault::run(&self.vault()?, |vault| vault.delete()).await
    }

    pub async fn info(&self) -> Result<UpdateInfo, String> {
        let mut result = UpdateInfo {
            configured: self.settings.configured(),
            version: self.args.app_version.clone(),
            provider: "default",
            authenticated: false,
            login: None,
            public: false,
        };
        if matches!(self.settings.provider, Provider::Github(_)) {
            result.provider = "github";
            if let Ok(config) = self.github() {
                if self.settings.public_repository {
                    // No keychain read: a public repository never uses the credential.
                    result.public = true;
                    return Ok(result);
                }
                let _guard = self.inner.lock().await;
                if let Some(credential) = self.credential(config).await? {
                    result.authenticated = true;
                    result.login = Some(credential.login.clone());
                }
            }
        }
        Ok(result)
    }

    pub async fn login_start(&self) -> Result<LoginStart, String> {
        let config = self.github()?;
        let generation = self.inner.lock().await.invalidate();
        let mut response = self
            .oauth("device/code", json!({"client_id":config.client_id,"scope":"repo"}))
            .await?;
        let device_code = Zeroizing::new(
            match response.as_object_mut().and_then(|object| object.remove("device_code")) {
                Some(Value::String(code)) => code,
                _ => String::new(),
            },
        );
        let user_code = response
            .get("user_code")
            .and_then(Value::as_str)
            .filter(|code| valid_user_code(code))
            .ok_or("github_update_response")?
            .to_owned();
        if !valid_device_code(&device_code)
            || response.get("verification_uri").and_then(Value::as_str) != Some(net::DEVICE_URI)
        {
            return Err("github_update_response".into());
        }
        let expires_in = response
            .get("expires_in")
            .and_then(Value::as_u64)
            .ok_or("github_update_response")?;
        let interval = response.get("interval").and_then(Value::as_u64).unwrap_or(5);
        let cadence = FlowCadence::new(Instant::now(), expires_in, interval)?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let mut inner = self.inner.lock().await;
        if !inner.generation.matches(generation) {
            return Err("github_update_cancelled".into());
        }
        inner.flow = Some(DeviceFlow { id: flow_id.clone(), code: device_code, cadence, authorized: false });
        Ok(LoginStart { flow_id, user_code, verification_uri: net::DEVICE_URI, expires_in, interval })
    }

    pub async fn login_poll(&self, flow_id: &str) -> Result<LoginPoll, String> {
        let config = self.github()?;
        let (generation, code) = {
            let mut inner = self.inner.lock().await;
            let generation = inner.generation.current();
            let flow = inner
                .flow
                .as_mut()
                .filter(|flow| flow.id == flow_id)
                .ok_or("github_update_cancelled")?;
            if flow.authorized {
                return Ok(LoginPoll::authorized());
            }
            match flow.cadence.reserve(Instant::now()) {
                Ok(Some(interval)) => return Ok(LoginPoll::pending(interval)),
                Err(error) => {
                    inner.flow = None;
                    return Err(error);
                }
                Ok(None) => {}
            }
            (generation, Zeroizing::new(flow.code.to_string()))
        };
        let result = self
            .oauth(
                "oauth/access_token",
                json!({"client_id":config.client_id,"device_code":code.as_str(),"grant_type":"urn:ietf:params:oauth:grant-type:device_code"}),
            )
            .await;
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                let mut inner = self.inner.lock().await;
                if inner.generation.matches(generation) {
                    if let Some(flow) = inner.flow.as_mut().filter(|flow| flow.id == flow_id) {
                        flow.cadence.pending(Instant::now(), false);
                    }
                }
                return Err(error);
            }
        };
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            let mut inner = self.inner.lock().await;
            if !inner.generation.matches(generation) {
                return Err("github_update_cancelled".into());
            }
            let flow = inner
                .flow
                .as_mut()
                .filter(|flow| flow.id == flow_id)
                .ok_or("github_update_cancelled")?;
            if matches!(error, "authorization_pending" | "slow_down") {
                flow.cadence.pending(Instant::now(), error == "slow_down");
                if let Some(interval) = response.get("interval").and_then(Value::as_u64) {
                    flow.cadence.provider_interval(Instant::now(), interval)?;
                }
                return Ok(LoginPoll::pending(flow.cadence.interval));
            }
            inner.flow = None;
            return Err(match error {
                "access_denied" => "github_update_denied",
                "expired_token" | "token_expired" => "github_update_expired",
                _ => "github_update_response",
            }
            .into());
        }
        let mut credential = Credential::from_response(response, String::new(), epoch_seconds()?)?;
        let user = transport::github(false)?
            .get("https://api.github.com/user")
            .headers(net::headers(&credential.token, false)?)
            .send()
            .await
            .map_err(|_| "github_update_network")?;
        let user = net::bounded_json(user, 32 * 1024).await?;
        let login = user
            .get("login")
            .and_then(Value::as_str)
            .filter(|login| valid_login(login))
            .ok_or("github_update_response")?
            .to_owned();
        let mut inner = self.inner.lock().await;
        if !inner.generation.matches(generation) || !inner.flow.as_ref().is_some_and(|flow| flow.id == flow_id) {
            return Err("github_update_cancelled".into());
        }
        if inner.flow.as_ref().is_some_and(|flow| flow.cadence.expired(Instant::now())) {
            inner.flow = None;
            return Err("github_update_expired".into());
        }
        credential.login = login;
        // The lifecycle lock is held until credential persistence completes. A
        // queued logout/cancel runs after it, so a stale poll cannot recreate login.
        self.persist(&credential).await?;
        inner.finish_login();
        Ok(LoginPoll::authorized())
    }

    pub async fn login_cancel(&self, flow_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if let Some(authorized) = inner.cancel_flow(flow_id) {
            if authorized {
                self.github()?;
                self.forget().await?;
            }
        }
        Ok(())
    }

    pub async fn logout(&self) -> Result<(), String> {
        self.github()?;
        let mut inner = self.inner.lock().await;
        inner.invalidate();
        self.forget().await
    }

    pub async fn check(&self) -> Result<Option<UpdateOffer>, String> {
        if !INSTALL_SUPPORTED {
            return Err("github_update_configuration".into());
        }
        match &self.settings.provider {
            Provider::Github(_) => self.check_github().await,
            Provider::Default(_) => self.check_public().await,
        }
    }

    async fn check_github(&self) -> Result<Option<UpdateOffer>, String> {
        let config = self.github()?;
        let (generation, check, credential) = {
            let mut inner = self.inner.lock().await;
            if inner.install.is_some() {
                return Err("github_update_busy".into());
            }
            inner.offer = None;
            let token = if self.settings.public_repository {
                None
            } else {
                Some(Zeroizing::new(self.credential(config).await?.ok_or("github_update_login_required")?.token.clone()))
            };
            (inner.generation.current(), inner.checks.advance(), token)
        };
        let headers = |asset: bool| match &credential {
            Some(token) => net::headers(token, asset),
            None => Ok(net::public_headers(asset)),
        };
        // Anonymously, 401/403/404 mean rate limiting or an unreachable
        // repository, not an account to sign in with.
        let anonymous = |error: String| if self.settings.public_repository && matches!(error.as_str(), "github_update_repo_unavailable" | "github_update_login_required") { "github_update_network".to_owned() } else { error };
        let releases = transport::github(false)?
            .get(format!("https://api.github.com/repos/{}/releases?per_page=100", config.repository))
            .headers(headers(false)?)
            .send()
            .await
            .map_err(|_| "github_update_network")?;
        let releases = net::bounded_json(releases, net::MAX_API_BYTES).await.map_err(anonymous)?;
        let Some(release) =
            policy::select_release(&releases, &config.repository, policy::UpdatePlatform::current()?)?
        else {
            return Ok(None);
        };
        let manifest = transport::github(true)?
            .get(&release.manifest_url)
            .headers(headers(true)?)
            .send()
            .await
            .map_err(|_| "github_update_network")?;
        let manifest = net::bounded_json(manifest, MAX_MANIFEST_BYTES).await.map_err(anonymous)?;
        let update = manifest::parse(&manifest, &manifest::targets())?;
        // The plugin decides "no update" before the release/manifest binding.
        if !manifest::newer(&update.version, &self.args.app_version) {
            return Ok(None);
        }
        if update.version != release.version {
            return Err("github_update_manifest".into());
        }
        let size = release.installer(&update.url, &config.repository)?;
        let mut inner = self.inner.lock().await;
        if !inner.generation.matches(generation) || !inner.checks.matches(check) {
            return Err("github_update_cancelled".into());
        }
        Ok(Some(self.offer(
            &mut inner,
            update,
            Source::Github { token: credential, size },
        )))
    }

    async fn check_public(&self) -> Result<Option<UpdateOffer>, String> {
        let config = self.public()?;
        let (generation, check) = {
            let mut inner = self.inner.lock().await;
            if inner.install.is_some() {
                return Err("github_update_busy".into());
            }
            inner.offer = None;
            (inner.generation.current(), inner.checks.advance())
        };
        let client = transport::public()?;
        let mut found = None;
        let mut last_error = String::from("github_update_network");
        for template in &config.endpoints {
            let url = manifest::endpoint(template, &self.args.app_version);
            let response = match client.get(&url).header(reqwest::header::ACCEPT, "application/json").send().await {
                Ok(response) => response,
                Err(_) => continue,
            };
            if response.status() == reqwest::StatusCode::NO_CONTENT {
                return Ok(None);
            }
            if !response.status().is_success() {
                continue;
            }
            match net::bounded_json(response, MAX_MANIFEST_BYTES)
                .await
                .and_then(|value| manifest::parse(&value, &manifest::targets()))
            {
                Ok(release) => {
                    found = Some(release);
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        let update = found.ok_or(last_error)?;
        if !manifest::newer(&update.version, &self.args.app_version) {
            return Ok(None);
        }
        let mut inner = self.inner.lock().await;
        if !inner.generation.matches(generation) || !inner.checks.matches(check) {
            return Err("github_update_cancelled".into());
        }
        Ok(Some(self.offer(&mut inner, update, Source::Public)))
    }

    fn offer(&self, inner: &mut Inner, update: manifest::Release, source: Source) -> UpdateOffer {
        let id = uuid::Uuid::new_v4().to_string();
        let offer = UpdateOffer { offer_id: id.clone(), version: update.version.clone(), body: update.notes };
        inner.offer = Some(Offer { id, version: update.version, url: update.url, signature: update.signature, source });
        offer
    }

    pub async fn close(&self, offer_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.offer.as_ref().is_some_and(|offer| offer.id == offer_id) {
            inner.offer = None;
        }
        if inner.install.as_ref().is_some_and(|install| install.id == offer_id) {
            if let Some(install) = inner.install.take() {
                install.cancel.cancel();
            }
        }
        Ok(())
    }

    /// Stdin closed: Electron main is gone. Cancel what is still cancellable;
    /// a replacement already under the lock completes first.
    pub async fn shutdown(&self) {
        self.inner.lock().await.invalidate();
    }

    /// `None` (macOS: installed, restart when ready) or `{"quit": true}`
    /// (Windows: the App must exit so its installer can run).
    pub async fn install(&self, offer_id: &str) -> Result<Option<Value>, String> {
        let cancel = Arc::new(Cancel::default());
        let (generation, offer) = {
            let mut inner = self.inner.lock().await;
            if inner.install.is_some() {
                return Err("github_update_busy".into());
            }
            if !inner.offer.as_ref().is_some_and(|offer| offer.id == offer_id) {
                return Err("github_update_invalid_offer".into());
            }
            let offer = inner.offer.take().ok_or("github_update_invalid_offer")?;
            inner.install = Some(Installing { id: offer_id.to_owned(), cancel: cancel.clone() });
            (inner.generation.current(), offer)
        };
        let result = self.perform(&offer, generation, &cancel).await;
        let mut inner = self.inner.lock().await;
        if inner.install.as_ref().is_some_and(|install| install.id == offer_id) {
            inner.install = None;
        }
        result
    }

    async fn download(&self, offer: &Offer, cancel: &Cancel, work: &WorkDir) -> Result<std::fs::File, String> {
        let pubkey = self.settings.pubkey.as_deref().ok_or("github_update_configuration")?;
        let verifier = Verifier::new(pubkey, &offer.signature, &offer.version)?;
        let (github, size) = match &offer.source {
            Source::Github { size, .. } => (true, Some(*size)),
            Source::Public => (false, None),
        };
        let limit = size.unwrap_or(MAX_INSTALLER_BYTES).min(MAX_INSTALLER_BYTES);
        let mut request = transport::download(github)?.get(&offer.url);
        if let Source::Github { token, .. } = &offer.source {
            request = request.headers(match token {
                Some(token) => net::headers(token, true)?,
                None => net::public_headers(true),
            });
        }
        let mut response = cancel
            .guard(request.send())
            .await?
            .map_err(|_| "github_update_network")?;
        if !response.status().is_success() {
            return Err("github_update_network".into());
        }
        let total = response.content_length();
        if total.is_some_and(|total| size.is_some_and(|size| total != size) || total > limit) {
            return Err("github_update_bounds".into());
        }
        let path = work.0.join("update.archive");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path).map_err(|_| "github_update_install")?;
        let mut stream = verifier.stream();
        let (mut seen, mut pending, mut flushed, mut started) = (0u64, 0u64, Instant::now(), false);
        while let Some(chunk) = cancel
            .guard(response.chunk())
            .await?
            .map_err(|_| "github_update_network")?
        {
            seen = seen.saturating_add(chunk.len() as u64);
            if seen > limit {
                return Err("github_update_bounds".into());
            }
            if let Some(stream) = stream.as_mut() {
                stream.update(&chunk);
            }
            file.write_all(&chunk).map_err(|_| "github_update_install")?;
            if !started {
                started = true;
                (self.emit)(&offer.id, DownloadEvent::Started { content_length: total });
            }
            pending += chunk.len() as u64;
            if pending >= PROGRESS_BYTES || flushed.elapsed() >= PROGRESS_INTERVAL {
                (self.emit)(&offer.id, DownloadEvent::Progress { chunk_length: pending });
                pending = 0;
                flushed = Instant::now();
            }
        }
        if pending > 0 {
            (self.emit)(&offer.id, DownloadEvent::Progress { chunk_length: pending });
        }
        if size.is_some_and(|size| seen != size) || seen == 0 {
            return Err("github_update_bounds".into());
        }
        file.flush().map_err(|_| "github_update_install")?;
        match stream {
            Some(stream) => verifier.finish(stream)?,
            None => {
                // Legacy signatures cover raw bytes; the Tauri updater also
                // held the whole (bounded) archive in memory to verify it.
                let bytes = Zeroizing::new(std::fs::read(&path).map_err(|_| "github_update_install")?);
                if bytes.len() as u64 != seen {
                    return Err("github_update_bounds".into());
                }
                verifier.verify_bytes(&bytes)?;
            }
        }
        Ok(file)
    }

    /// The installer that `shutdown` left for the process to start.
    pub fn take_handoff(&self) -> Option<PathBuf> {
        self.handoff.lock().ok()?.take()
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    async fn perform(&self, _offer: &Offer, _generation: u64, _cancel: &Arc<Cancel>) -> Result<Option<Value>, String> {
        Err("github_update_configuration".into())
    }

    /// Tauri semantics: verify, then hand the NSIS installer `/P /UPDATE /R`
    /// to the OS and exit. Its hooks stop the local Host, keep data, replace
    /// files, re-register the notification shortcut and restart the App.
    #[cfg(windows)]
    async fn perform(&self, offer: &Offer, generation: u64, cancel: &Arc<Cancel>) -> Result<Option<Value>, String> {
        use std::io::{Read, Seek};
        let _lock = InstallLock::acquire(&self.args.work_dir)?;
        let work = WorkDir::create(&self.args.work_dir)?;
        let mut archive = self.download(offer, cancel, &work).await?;
        let mut magic = [0u8; 2];
        archive.seek(std::io::SeekFrom::Start(0)).and_then(|_| archive.read_exact(&mut magic)).map_err(|_| "github_update_install")?;
        if &magic != b"MZ" {
            return Err("github_update_install".into());
        }
        drop(archive);
        if !self.inner.lock().await.installing(generation, &offer.id) {
            return Err("github_update_cancelled".into());
        }
        // One staged installer at a time; older leftovers are not resumed.
        let staged = self.args.work_dir.join("installers.noindex");
        let _ = std::fs::remove_dir_all(&staged);
        std::fs::create_dir_all(&staged).map_err(|_| "github_update_install")?;
        let installer = staged.join(format!("TaroBird_{}_x64-setup.exe", offer.version));
        std::fs::rename(work.0.join("update.archive"), &installer).map_err(|_| "github_update_install")?;
        *self.handoff.lock().map_err(|_| "github_update_install")? = Some(installer);
        (self.emit)(&offer.id, DownloadEvent::Finished);
        Ok(Some(json!({"quit": true})))
    }

    #[cfg(target_os = "macos")]
    async fn perform(&self, offer: &Offer, generation: u64, cancel: &Arc<Cancel>) -> Result<Option<Value>, String> {
        use crate::{
            archive,
            macos_core::{validate_bundle, AppBackup, HostPause},
            native_identity::{self, APP_ID},
        };
        let _lock = InstallLock::acquire(&self.args.work_dir)?;
        let work = WorkDir::create(&self.args.work_dir)?;
        let archive_file = self.download(offer, cancel, &work).await?;
        if !self.inner.lock().await.installing(generation, &offer.id) {
            return Err("github_update_cancelled".into());
        }
        (self.emit)(&offer.id, DownloadEvent::WaitingForHost);
        let backup = cancel.guard(AppBackup::at(&self.args.app_bundle)).await??;
        // Stage on the bundle's volume so the replacement is a rename, and
        // read back the staged bundle before the Host is paused.
        let staged = {
            let mut file = archive_file.try_clone().map_err(|_| "github_update_install")?;
            // Every temporary bundle this updater creates has a `.noindex`
            // physical parent, so Spotlight/Launch Services ignore it.
            let into = backup.directory.join("staged.noindex");
            let flag = cancel.clone();
            let version = offer.version.clone();
            tokio::task::spawn_blocking(move || {
                let app = archive::extract_app(&mut file, &into, &flag.flag)?;
                if flag.cancelled() {
                    return Err("github_update_cancelled".to_owned());
                }
                validate_bundle(&app, &version, APP_ID)?;
                Ok::<_, String>(app)
            })
            .await
            .map_err(|_| "github_update_install")??
        };
        drop(archive_file);
        drop(work);
        let directory = native_identity::for_app_data(&self.args.host_state_dir).map_err(|_| "github_update_host")?;
        // Dropping the pause before `finish` closes its stdin: the Host resumes.
        let pause = cancel.guard(HostPause::prepare_at(&self.args.resources_dir, &directory)).await??;
        let inner = self.inner.lock().await;
        if !inner.installing(generation, &offer.id) {
            drop(pause);
            return Err("github_update_cancelled".into());
        }
        (self.emit)(&offer.id, DownloadEvent::Installing);
        let mut backup = backup;
        backup.begin()?;
        let version = offer.version.clone();
        let replaced = tokio::task::spawn_blocking(move || {
            let installed = replace(&backup, &staged)
                .and_then(|_| backup.validate(&version, APP_ID).map_err(|error| (error, true)));
            let installed = match installed {
                // Prefer the bundle that was actually running over its copy.
                Err((error, true)) => Err((error, true, rollback(&mut backup, &staged))),
                Err((error, false)) => Err((error, false, Ok(()))),
                Ok(()) => Ok(()),
            };
            (backup, installed)
        })
        .await;
        let (mut backup, installed) = match replaced {
            Ok(value) => value,
            // The install path is unknown: never start the runtime it holds.
            Err(_) => {
                pause.retain_stopped().await;
                return Err("github_update_recovery".into());
            }
        };
        let result = match installed {
            // The running bundle was never moved: nothing to roll back.
            Err((error, false, _)) => {
                backup.commit();
                pause.finish().await.and(Err(error))
            }
            Err((error, true, Ok(()))) => pause.finish().await.and(Err(error)),
            Err((_, true, Err(recovery))) => {
                pause.retain_stopped().await;
                Err(recovery)
            }
            Ok(()) => {
                (self.emit)(&offer.id, DownloadEvent::RestartingHost);
                let result = pause.finish().await;
                if result.is_ok() {
                    backup.commit();
                }
                // The verified bundle is already installed. Keep the recovery
                // copy and tell main to fence new helpers until App restart,
                // even though Host recovery has not been confirmed.
                result.map_err(|_| "github_update_installed_host_failed".to_owned())
            }
        };
        drop(inner);
        if result.is_ok() {
            (self.emit)(&offer.id, DownloadEvent::Finished);
        }
        result.map(|_| None)
    }
}

#[cfg(target_os = "macos")]
fn displaced(backup: &crate::macos_core::AppBackup) -> std::path::PathBuf {
    backup.directory.join("displaced.noindex").join(backup.app.file_name().unwrap_or_else(|| std::ffi::OsStr::new("previous.app")))
}

/// Exchanges the verified staged bundle with the running one in one step, so
/// the install path always names a complete bundle even if this process dies.
/// The previous bundle then moves aside within the backup directory. A volume
/// without exchange support fails closed with the running App in place; two
/// separate renames would reopen the window with no App at the install path.
/// Errors report whether the install path may have changed.
#[cfg(target_os = "macos")]
fn replace(backup: &crate::macos_core::AppBackup, staged: &std::path::Path) -> Result<(), (String, bool)> {
    std::fs::create_dir(backup.directory.join("displaced.noindex")).map_err(|_| ("github_update_install".to_owned(), false))?;
    if let Err(error) = crate::macos_core::exchange(staged, &backup.app) {
        let code = if error.kind() == std::io::ErrorKind::PermissionDenied { "github_update_permissions" } else { "github_update_install" };
        return Err((code.to_owned(), false));
    }
    // The previous bundle is now at `staged`, inside the backup directory
    // either way; moving it aside is bookkeeping, not a failure condition.
    let _ = std::fs::rename(staged, displaced(backup));
    // As the plugin does, let Launch Services notice the new bundle.
    let _ = std::process::Command::new("/usr/bin/touch")
        .arg(&backup.app)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    Ok(())
}

/// Puts the bundle that was running back at the install path: from
/// `displaced.noindex`, or from `staged` when moving it aside after the
/// exchange failed. Only without either does the `previous.app` copy restore it.
#[cfg(target_os = "macos")]
fn rollback(backup: &mut crate::macos_core::AppBackup, staged: &std::path::Path) -> Result<(), String> {
    let displaced = displaced(backup);
    if displaced.exists() { return backup.restore_from(&displaced); }
    if staged.exists() && backup.app.exists() { return backup.restore_from(staged); }
    backup.restore()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(id: &str) -> DeviceFlow {
        DeviceFlow {
            id: id.into(),
            code: Zeroizing::new("native-device-code".into()),
            cadence: FlowCadence::new(Instant::now(), 900, 5).unwrap(),
            authorized: false,
        }
    }

    #[test]
    fn cancel_queued_during_credential_write_revokes_exact_completed_flow() {
        let mut inner = Inner::default();
        inner.flow = Some(flow("first"));
        let before = inner.generation.current();
        inner.finish_login();
        assert!(!inner.generation.matches(before));
        assert!(inner.flow.as_ref().unwrap().code.is_empty());
        assert_eq!(inner.cancel_flow("first"), Some(true));
        assert!(inner.flow.is_none());
    }

    #[test]
    fn invalidation_cancels_an_install_and_fences_its_generation() {
        let mut inner = Inner::default();
        let cancel = Arc::new(Cancel::default());
        inner.install = Some(Installing { id: "offer".into(), cancel: cancel.clone() });
        let generation = inner.generation.current();
        assert!(inner.installing(generation, "offer"));
        inner.invalidate();
        assert!(cancel.cancelled());
        assert!(!inner.installing(generation, "offer"));
    }

    #[tokio::test]
    async fn cancel_wakes_a_waiting_guard_without_a_lost_notification() {
        let cancel = Arc::new(Cancel::default());
        let waiter = cancel.clone();
        let task = tokio::spawn(async move { waiter.guard(std::future::pending::<()>()).await });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap().unwrap_err(),
            "github_update_cancelled"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn replacement_and_rollback_keep_one_complete_bundle_at_the_install_path() {
        use crate::macos_core::AppBackup;
        let root = std::env::temp_dir().join(format!("tarobot-updater-replace-{}", uuid::Uuid::new_v4()));
        let app = root.join("TaroBot.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("old"), "previous").unwrap();
        let mut backup = AppBackup::at(&app).await.unwrap();
        let staged = backup.directory.join("staged.noindex/TaroBot.app");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("new"), "next").unwrap();
        backup.begin().unwrap();
        replace(&backup, &staged).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("new")).unwrap(), "next");
        assert!(backup.directory.join("displaced.noindex/TaroBot.app/old").is_file());
        // A failed read-back restores the durable copy over the new bundle.
        backup.restore().unwrap();
        drop(backup);
        assert_eq!(std::fs::read_to_string(app.join("old")).unwrap(), "previous");
        assert!(!app.join("new").exists());
        let leftovers: Vec<_> = std::fs::read_dir(&root).unwrap().flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tarobot-update-")).collect();
        assert!(leftovers.is_empty());
        // A missing staged bundle leaves the running bundle in place.
        let backup = AppBackup::at(&app).await.unwrap();
        assert_eq!(replace(&backup, &root.join("absent.app")).unwrap_err(), ("github_update_install".to_owned(), false));
        assert!(app.join("old").exists());
        drop(backup);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn replacement_and_rollback_never_leave_the_install_path_missing() {
        use crate::macos_core::AppBackup;
        use std::{os::unix::fs::MetadataExt, sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc}};
        let root = std::env::temp_dir().join(format!("tarobot-updater-exchange-{}.noindex", uuid::Uuid::new_v4()));
        let app = root.join("TaroBot.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("old"), "previous").unwrap();
        let running = std::fs::metadata(&app).unwrap().ino();
        // An observer stands in for Finder, Dock or a relaunch racing the update.
        let (stop, missing, looks) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let observer = {
            let (app, stop, missing, looks) = (app.clone(), stop.clone(), missing.clone(), looks.clone());
            std::thread::spawn(move || while !stop.load(Ordering::Relaxed) {
                looks.fetch_add(1, Ordering::Relaxed);
                if std::fs::symlink_metadata(&app).is_err() { missing.fetch_add(1, Ordering::Relaxed); }
            })
        };
        for _ in 0..25 {
            let mut backup = AppBackup::at(&app).await.unwrap();
            let staged = backup.directory.join("staged.noindex/TaroBot.app");
            std::fs::create_dir_all(staged.join("Contents")).unwrap();
            std::fs::write(staged.join("new"), "next").unwrap();
            let next = std::fs::metadata(&staged).unwrap().ino();
            backup.begin().unwrap();
            replace(&backup, &staged).unwrap();
            assert_eq!(std::fs::metadata(&app).unwrap().ino(), next, "the verified staged bundle is installed in place");
            assert_eq!(std::fs::metadata(displaced(&backup)).unwrap().ino(), running, "the running bundle is retained");
            rollback(&mut backup, &staged).unwrap();
            assert_eq!(std::fs::metadata(&app).unwrap().ino(), running, "rollback restores the bundle that was running, not a copy");
            drop(backup);
        }
        stop.store(true, Ordering::Relaxed);
        observer.join().unwrap();
        assert!(looks.load(Ordering::Relaxed) > 0);
        assert_eq!(missing.load(Ordering::Relaxed), 0, "the install path was observed missing");
        assert_eq!(std::fs::read_to_string(app.join("old")).unwrap(), "previous");
        let leftovers = std::fs::read_dir(&root).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".tarobot-update-")).count();
        assert_eq!(leftovers, 0, "a completed rollback removes its backup");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn rollback_restores_the_running_bundle_when_the_install_path_is_missing() {
        use crate::macos_core::AppBackup;
        use std::os::unix::fs::MetadataExt;
        let root = std::env::temp_dir().join(format!("tarobot-updater-fallback-{}.noindex", uuid::Uuid::new_v4()));
        let app = root.join("TaroBot.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("old"), "previous").unwrap();
        let running = std::fs::metadata(&app).unwrap().ino();
        let mut backup = AppBackup::at(&app).await.unwrap();
        let staged = backup.directory.join("staged.noindex/TaroBot.app");
        std::fs::create_dir_all(&staged).unwrap();
        backup.begin().unwrap();
        // E.g. an interrupted earlier two-step replacement left no App in place.
        std::fs::create_dir(backup.directory.join("displaced.noindex")).unwrap();
        std::fs::rename(&app, displaced(&backup)).unwrap();
        rollback(&mut backup, &staged).unwrap();
        assert_eq!(std::fs::metadata(&app).unwrap().ino(), running);
        drop(backup);
        // A source outside the backup directory is never moved into place.
        let mut other = AppBackup::at(&app).await.unwrap();
        assert_eq!(other.restore_from(&root.join("elsewhere.app")).unwrap_err(), "github_update_recovery");
        assert!(app.join("old").exists());
        drop(other);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_failed_exchange_leaves_the_running_bundle_in_place() {
        use crate::macos_core::AppBackup;
        use std::os::unix::fs::MetadataExt;
        let root = std::env::temp_dir().join(format!("tarobot-updater-closed-{}.noindex", uuid::Uuid::new_v4()));
        let app = root.join("TaroBot.app");
        std::fs::create_dir_all(&app).unwrap();
        let running = std::fs::metadata(&app).unwrap().ino();
        let backup = AppBackup::at(&app).await.unwrap();
        // Any exchange error (here: an invalid or a missing staged path) is
        // refused with the App untouched, never retried as two renames.
        for staged in [std::path::PathBuf::from("/dev/null/TaroBot.app"), backup.directory.join("staged.noindex/absent.app")] {
            let _ = std::fs::remove_dir(backup.directory.join("displaced.noindex"));
            assert_eq!(replace(&backup, &staged).unwrap_err(), ("github_update_install".to_owned(), false));
            assert_eq!(std::fs::metadata(&app).unwrap().ino(), running);
        }
        drop(backup);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_a_volume_without_exchange_support_may_use_two_step_recovery() {
        use crate::macos_core::exchange_unsupported;
        for (errno, fallback) in [(45, true), (78, true), (18, false), (2, false), (13, false), (1, false), (22, false)] {
            assert_eq!(exchange_unsupported(&std::io::Error::from_raw_os_error(errno)), fallback, "errno {errno}");
        }
    }

    #[test]
    fn a_second_installer_process_is_refused_while_the_lock_is_held() {
        let root = std::env::temp_dir().join(format!("tarobot-updater-lock-{}", uuid::Uuid::new_v4()));
        let first = InstallLock::acquire(&root).unwrap();
        assert_eq!(InstallLock::acquire(&root).err().unwrap(), "github_update_busy");
        drop(first);
        drop(InstallLock::acquire(&root).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn releasing_install_guard_unlocks_even_with_an_inherited_descriptor() {
        let root = std::env::temp_dir().join(format!("tarobot-updater-inherited-lock-{}", uuid::Uuid::new_v4()));
        let first = InstallLock::acquire(&root).unwrap();
        // A fork in a concurrent thread temporarily inherits this open-file
        // description until exec closes CLOEXEC descriptors.
        let inherited = first.0.try_clone().unwrap();
        drop(first);
        let second = InstallLock::acquire(&root);
        drop(inherited);
        drop(second.expect("the installation guard owns the lock lifetime"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn public_payloads_match_the_tauri_contract() {
        assert_eq!(
            serde_json::to_value(DownloadEvent::Progress { chunk_length: 42 }).unwrap(),
            json!({"event":"Progress","data":{"chunkLength":42}})
        );
        assert_eq!(serde_json::to_value(DownloadEvent::Finished).unwrap(), json!({"event":"Finished"}));
        assert_eq!(
            serde_json::to_value(DownloadEvent::Started { content_length: None }).unwrap(),
            json!({"event":"Started","data":{}})
        );
        assert_eq!(
            serde_json::to_value(LoginPoll::pending(5)).unwrap(),
            json!({"status":"pending","interval":5})
        );
    }
}
