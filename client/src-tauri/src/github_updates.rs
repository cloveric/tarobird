//! Private release credentials and updater resources never cross the IPC boundary.
#[path = "../shared/github_update_credential.rs"]
mod credential;
#[path = "../shared/github_update_net.rs"]
mod net;
use crate::{
    device_keychain,
    github_updates_policy::{self as policy, FlowCadence, Generation, GithubConfig},
};
use credential::{epoch_seconds, valid_device_code, valid_login, valid_user_code, Credential};
use net::{asset_redirects, bounded_json, headers, DEVICE_URI, MAX_API_BYTES};
use futures_util::future::{AbortHandle, Abortable};
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};


#[derive(Default)]
pub struct GithubUpdateState {
    inner: Mutex<Inner>,
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
            install.abort.abort();
        }
        self.checks.advance();
        self.generation.advance()
    }
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
    fn cancel_queued_during_keychain_write_revokes_exact_completed_flow() {
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
    fn stale_cancel_cannot_revoke_new_login_or_prior_stored_account() {
        let mut inner = Inner::default();
        inner.flow = Some(flow("first"));
        inner.finish_login();
        inner.invalidate();
        inner.flow = Some(flow("second"));
        let generation = inner.generation.current();
        assert_eq!(inner.cancel_flow("first"), None);
        assert!(inner.generation.matches(generation));
        assert_eq!(inner.cancel_flow("second"), Some(false));
    }

    #[test]
    fn ipc_login_and_progress_payloads_contain_only_public_contract() {
        let start = LoginStart {
            flow_id: "opaque-flow".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: DEVICE_URI,
            expires_in: 900,
            interval: 5,
        };
        assert_eq!(
            serde_json::to_value(start).unwrap(),
            json!({"flowId":"opaque-flow","userCode":"ABCD-EFGH","verificationUri":DEVICE_URI,"expiresIn":900,"interval":5})
        );
        assert_eq!(
            serde_json::to_value(LoginPoll {
                status: "authorized",
                interval: None
            })
            .unwrap(),
            json!({"status":"authorized"})
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Progress { chunk_length: 42 }).unwrap(),
            json!({"event":"Progress","data":{"chunkLength":42}})
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Finished).unwrap(),
            json!({"event":"Finished"})
        );
    }

    #[test]
    fn legacy_credentials_remain_usable_and_expiring_tokens_rotate_before_expiry() {
        let legacy: Credential =
            serde_json::from_value(json!({"token":"gho_exampletoken","login":"example"})).unwrap();
        assert!(!legacy.needs_refresh(100000));
        let token = Credential::from_response(json!({"access_token":"gho_exampletoken","token_type":"bearer","scope":"repo", "expires_in":28800,
            "refresh_token":"ghr_exampletoken","refresh_token_expires_in":15897600}), "example".into(), 100).unwrap();
        assert!(!token.needs_refresh(200));
        assert!(token.needs_refresh(28840));
        assert_eq!(token.refresh_expires_at, Some(15897700));
    }

    #[test]
    fn incomplete_rotations_and_missing_repo_scope_are_rejected() {
        for response in [
            json!({"access_token":"gho_exampletoken","token_type":"bearer","scope":"repo","expires_in":28800}),
            json!({"access_token":"gho_exampletoken","token_type":"bearer","scope":"repo","refresh_token":"bad token"}),
            json!({"access_token":"gho_exampletoken","token_type":"bearer","scope":"user"}),
            json!({"access_token":"gho_exampletoken","token_type":"bearer","scope":"repo","expires_in":0}),
        ] {
            assert!(Credential::from_response(response, "example".into(), 100).is_err());
        }
    }
}
struct DeviceFlow {
    id: String,
    code: Zeroizing<String>,
    cadence: FlowCadence,
    authorized: bool,
}
struct Offer {
    id: String,
    update: Update,
    size: u64,
}
struct Installing {
    id: String,
    abort: AbortHandle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    configured: bool,
    version: String,
    provider: &'static str,
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    flow_id: String,
    user_code: String,
    verification_uri: &'static str,
    expires_in: u64,
    interval: u64,
}
#[derive(Serialize)]
pub struct LoginPoll {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<u64>,
}
impl LoginPoll {
    fn pending(interval: u64) -> Self {
        Self {
            status: "pending",
            interval: Some(interval),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    offer_id: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    Started {
        #[serde(rename = "contentLength", skip_serializing_if = "Option::is_none")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
    WaitingForHost,
    Installing,
    RestartingHost,
}

fn configuration(app: &tauri::AppHandle) -> Result<GithubConfig, String> {
    let plugins = &app.config().plugins.0;
    policy::github_config(plugins.get("github-updates"), plugins.get("updater"))
}
fn keychain_entry(config: &GithubConfig) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        credential::KEYCHAIN_SERVICE,
        &credential::keychain_account(&config.repository, &config.client_id),
    )
    .map_err(|_| "github_update_keychain".into())
}
async fn delete_saved_credential(config: &GithubConfig) -> Result<(), String> {
    let account = credential::keychain_account(&config.repository, &config.client_id);
    device_keychain::run(move || device_keychain::delete_credential(credential::KEYCHAIN_SERVICE, &account))
        .await.map_err(|_| "github_update_keychain".into())
}
async fn credential(config: &GithubConfig) -> Result<Option<Credential>, String> {
    let entry = keychain_entry(config)?;
    let stored: Option<Credential> = device_keychain::run(move || {
        let secret = match entry.get_secret() {
            Ok(secret) => Zeroizing::new(secret),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err("github_update_keychain".into()),
        };
        Credential::from_stored(&secret).map(Some)
    })
    .await
    .map_err(|_| "github_update_keychain")?;
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
    let response = oauth(
        "oauth/access_token",
        json!({"client_id":config.client_id,"grant_type":"refresh_token","refresh_token":refresh}),
    )
    .await?;
    if response.get("error").is_some() {
        return Ok(None);
    }
    let refreshed = Credential::from_response(response, stored.login.clone(), now)?;
    persist_credential(config, &refreshed).await?;
    Ok(Some(refreshed))
}
async fn persist_credential(config: &GithubConfig, credential: &Credential) -> Result<(), String> {
    let entry = keychain_entry(config)?;
    let secret = credential.to_secret()?;
    device_keychain::run(move || {
        entry
            .set_secret(&secret)
            .map_err(|_| "github_update_keychain".into())
    })
    .await
    .map_err(|_| "github_update_keychain".into())
}
fn tls_config() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone())
        .map_err(|_| "github_update_network")?;
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "github_update_network")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}
fn client(asset: bool) -> Result<Client, String> {
    net::client_builder(asset, tls_config()?)
        .build()
        .map_err(|_| "github_update_network".into())
}
async fn oauth(path: &str, body: Value) -> Result<Value, String> {
    net::oauth_with(client(false)?, path, body).await
}
fn updater_error(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::MissingSignedVersion
        | Error::SignedVersionMismatch { .. } => "github_update_signature",
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => "github_update_network",
        _ => "github_update_install",
    }
    .into()
}

#[tauri::command]
pub async fn github_update_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<UpdateInfo, String> {
    let plugins = &app.config().plugins.0;
    let mut result = UpdateInfo {
        configured: false,
        version: app.package_info().version.to_string(),
        provider: "default",
        authenticated: false,
        login: None,
    };
    if plugins.contains_key("github-updates") {
        result.provider = "github";
        if let Ok(config) = configuration(&app) {
            result.configured = true;
            let _guard = state.inner.lock().await;
            if let Some(credential) = credential(&config).await? {
                result.authenticated = true;
                result.login = Some(credential.login.clone());
            }
        }
    } else {
        let updater = plugins.get("updater");
        result.configured = updater
            .and_then(|v| v.get("pubkey"))
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
            && updater
                .and_then(|v| v.get("endpoints"))
                .and_then(Value::as_array)
                .is_some_and(|urls| {
                    !urls.is_empty()
                        && urls
                            .iter()
                            .all(|v| v.as_str().is_some_and(|url| url.starts_with("https://")))
                });
    }
    Ok(result)
}

#[tauri::command]
pub async fn github_update_login_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<LoginStart, String> {
    let config = configuration(&app)?;
    let generation = state.inner.lock().await.invalidate();
    let mut response = oauth(
        "device/code",
        json!({"client_id":config.client_id,"scope":"repo"}),
    )
    .await?;
    let device_code = Zeroizing::new(
        match response
            .as_object_mut()
            .and_then(|object| object.remove("device_code"))
        {
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
        || response.get("verification_uri").and_then(Value::as_str) != Some(DEVICE_URI)
    {
        return Err("github_update_response".into());
    }
    let expires_in = response
        .get("expires_in")
        .and_then(Value::as_u64)
        .ok_or("github_update_response")?;
    let interval = response
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5);
    let cadence = FlowCadence::new(Instant::now(), expires_in, interval)?;
    let flow_id = uuid::Uuid::new_v4().to_string();
    let mut inner = state.inner.lock().await;
    if !inner.generation.matches(generation) {
        return Err("github_update_cancelled".into());
    }
    inner.flow = Some(DeviceFlow {
        id: flow_id.clone(),
        code: device_code,
        cadence,
        authorized: false,
    });
    Ok(LoginStart {
        flow_id,
        user_code,
        verification_uri: DEVICE_URI,
        expires_in,
        interval,
    })
}

#[tauri::command]
pub async fn github_update_login_poll(
    flow_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<LoginPoll, String> {
    let config = configuration(&app)?;
    let (generation, code) = {
        let mut inner = state.inner.lock().await;
        let generation = inner.generation.current();
        let flow = inner
            .flow
            .as_mut()
            .filter(|flow| flow.id == flow_id)
            .ok_or("github_update_cancelled")?;
        if flow.authorized {
            return Ok(LoginPoll {
                status: "authorized",
                interval: None,
            });
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
    let result = oauth("oauth/access_token", json!({"client_id":config.client_id,"device_code":code.as_str(),"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})).await;
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            let mut inner = state.inner.lock().await;
            if inner.generation.matches(generation) {
                if let Some(flow) = inner.flow.as_mut().filter(|flow| flow.id == flow_id) {
                    flow.cadence.pending(Instant::now(), false);
                }
            }
            return Err(error);
        }
    };
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        let mut inner = state.inner.lock().await;
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
    let user = client(false)?
        .get("https://api.github.com/user")
        .headers(headers(&credential.token, false)?)
        .send()
        .await
        .map_err(|_| "github_update_network")?;
    let user = bounded_json(user, 32 * 1024).await?;
    let login = user
        .get("login")
        .and_then(Value::as_str)
        .filter(|login| valid_login(login))
        .ok_or("github_update_response")?
        .to_owned();
    let mut inner = state.inner.lock().await;
    if !inner.generation.matches(generation)
        || !inner.flow.as_ref().is_some_and(|flow| flow.id == flow_id)
    {
        return Err("github_update_cancelled".into());
    }
    if inner
        .flow
        .as_ref()
        .is_some_and(|flow| flow.cadence.expired(Instant::now()))
    {
        inner.flow = None;
        return Err("github_update_expired".into());
    }
    credential.login = login;
    // The lifecycle lock is held until credential persistence completes. A
    // queued logout/cancel runs after it, so a stale poll cannot recreate login.
    persist_credential(&config, &credential).await?;
    inner.finish_login();
    Ok(LoginPoll {
        status: "authorized",
        interval: None,
    })
}

#[tauri::command]
pub async fn github_update_login_cancel(
    flow_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if let Some(authorized) = inner.cancel_flow(&flow_id) {
        if authorized {
            delete_saved_credential(&configuration(&app)?).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn github_update_logout(
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<(), String> {
    let config = configuration(&app)?;
    let mut inner = state.inner.lock().await;
    inner.invalidate();
    delete_saved_credential(&config).await
}

#[tauri::command]
pub async fn github_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<Option<UpdateOffer>, String> {
    let config = configuration(&app)?;
    let (generation, check, credential) = {
        let mut inner = state.inner.lock().await;
        if inner.install.is_some() {
            return Err("github_update_busy".into());
        }
        inner.offer = None;
        (
            inner.generation.current(),
            inner.checks.advance(),
            credential(&config)
                .await?
                .ok_or("github_update_login_required")?,
        )
    };
    let releases = client(false)?
        .get(format!(
            "https://api.github.com/repos/{}/releases?per_page=100",
            config.repository
        ))
        .headers(headers(&credential.token, false)?)
        .send()
        .await
        .map_err(|_| "github_update_network")?;
    let releases = bounded_json(releases, MAX_API_BYTES).await?;
    let Some(release) = policy::select_release(
        &releases,
        &config.repository,
        policy::UpdatePlatform::current()?,
    )?
    else {
        return Ok(None);
    };
    let manifest = client(true)?
        .get(&release.manifest_url)
        .headers(headers(&credential.token, true)?)
        .send()
        .await
        .map_err(|_| "github_update_network")?;
    let manifest = bounded_json(manifest, policy::MAX_MANIFEST_BYTES).await?;
    let tls = tls_config()?;
    let updater = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(&release.manifest_url).map_err(|_| "github_update_manifest")?
        ])
        .map_err(|_| "github_update_configuration")?
        .headers(headers(&credential.token, true)?)
        .timeout(Duration::from_secs(120))
        .configure_client(move |builder| {
            builder
                .tls_backend_preconfigured(tls.clone())
                .redirect(asset_redirects())
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(20))
        })
        .build()
        .map_err(updater_error)?;
    // Upstream check buffers its own JSON. The asset's declared size, bounded
    // prefetch and exact JSON equality constrain acceptance; upstream provides
    // no streaming manifest limit. Release assets must remain immutable.
    let Some(update) = updater.check().await.map_err(updater_error)? else {
        return Ok(None);
    };
    if update.raw_json != manifest
        || update.version != release.version
        || !policy::stable_version(&update.version)
    {
        return Err("github_update_manifest".into());
    }
    let size = release.installer(update.download_url.as_str(), &config.repository)?;
    let mut inner = state.inner.lock().await;
    if !inner.generation.matches(generation) || !inner.checks.matches(check) {
        return Err("github_update_cancelled".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let offer = UpdateOffer {
        offer_id: id.clone(),
        version: update.version.clone(),
        body: update.body.clone(),
    };
    inner.offer = Some(Offer { id, update, size });
    Ok(Some(offer))
}

#[tauri::command]
pub async fn github_update_install(
    app: tauri::AppHandle,
    offer_id: String,
    on_event: tauri::ipc::Channel<DownloadEvent>,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<(), String> {
    let (abort, registration) = AbortHandle::new_pair();
    let (generation, offer) = {
        let mut inner = state.inner.lock().await;
        if inner.install.is_some() {
            return Err("github_update_busy".into());
        }
        if !inner
            .offer
            .as_ref()
            .is_some_and(|offer| offer.id == offer_id)
        {
            return Err("github_update_invalid_offer".into());
        }
        let offer = inner.offer.take().ok_or("github_update_invalid_offer")?;
        inner.install = Some(Installing {
            id: offer_id.clone(),
            abort: abort.clone(),
        });
        (inner.generation.current(), offer)
    };
    let bytes_seen = Arc::new(AtomicU64::new(0));
    let too_large = Arc::new(AtomicBool::new(false));
    let bytes = bytes_seen.clone();
    let exceeded = too_large.clone();
    let progress = on_event.clone();
    let size = offer.size;
    let mut started = false;
    let result = Abortable::new(
        offer.update.download(
            move |length, total| {
                let seen = bytes
                    .fetch_add(length as u64, Ordering::Relaxed)
                    .saturating_add(length as u64);
                if seen > size
                    || seen > policy::MAX_INSTALLER_BYTES
                    || total.is_some_and(|total| total != size)
                {
                    exceeded.store(true, Ordering::Relaxed);
                    abort.abort();
                    return;
                }
                if !started {
                    started = true;
                    let _ = progress.send(DownloadEvent::Started {
                        content_length: total,
                    });
                }
                let _ = progress.send(DownloadEvent::Progress {
                    chunk_length: length,
                });
            },
            || {},
        ),
        registration,
    )
    .await;
    let mut inner = state.inner.lock().await;
    if !inner.generation.matches(generation)
        || !inner
            .install
            .as_ref()
            .is_some_and(|install| install.id == offer_id)
    {
        return Err("github_update_cancelled".into());
    }
    let verified = (|| {
        if too_large.load(Ordering::Relaxed) {
            return Err("github_update_bounds".to_owned());
        }
        let bytes = result
            .map_err(|_| "github_update_cancelled")?
            .map_err(updater_error)?;
        if bytes.len() as u64 != size || bytes_seen.load(Ordering::Relaxed) != size {
            return Err("github_update_bounds".into());
        }
        Ok(bytes)
    })();
    let bytes = match verified {
        Ok(bytes) => bytes,
        Err(error) => {
            inner.install = None;
            return Err(error);
        }
    };
    #[cfg(target_os = "macos")]
    {
        let (wait_abort, wait_registration) = AbortHandle::new_pair();
        inner
            .install
            .as_mut()
            .ok_or("github_update_cancelled")?
            .abort = wait_abort;
        drop(inner);
        let _ = on_event.send(DownloadEvent::WaitingForHost);
        let prepared = Abortable::new(
            async {
                let backup = crate::macos_update::AppBackup::create(&app).await?;
                let pause = crate::macos_update::HostPause::prepare(&app).await?;
                Ok::<_, String>((backup, pause))
            },
            wait_registration,
        )
        .await;
        let mut inner = state.inner.lock().await;
        if !inner.generation.matches(generation)
            || !inner
                .install
                .as_ref()
                .is_some_and(|install| install.id == offer_id)
        {
            // Dropping the prepared child's stdin resumes an already paused Hub.
            drop(prepared);
            return Err("github_update_cancelled".into());
        }
        let prepared = prepared
            .map_err(|_| "github_update_cancelled".to_owned())
            .and_then(|result| result);
        let (mut backup, pause) = match prepared {
            Ok(value) => value,
            Err(error) => {
                inner.install = None;
                return Err(error);
            }
        };
        let _ = on_event.send(DownloadEvent::Installing);
        if let Err(error) = backup.begin() {
            inner.install = None;
            return Err(error);
        }
        let installed = offer
            .update
            .install(bytes)
            .map_err(updater_error)
            .and_then(|_| backup.validate(&offer.update.version, &app.config().identifier));
        let result = match installed {
            Err(error) => match backup.restore() {
                Ok(()) => pause.finish().await.and(Err(error)),
                Err(recovery) => Err(recovery),
            },
            Ok(()) => {
                let _ = on_event.send(DownloadEvent::RestartingHost);
                let result = pause.finish().await;
                if result.is_ok() {
                    backup.commit();
                }
                result
            }
        };
        inner.install = None;
        if result.is_ok() {
            let _ = on_event.send(DownloadEvent::Finished);
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        inner.install = None;
        // Keep upstream NSIS/passive/current-exe handling and Windows exit semantics.
        let _ = on_event.send(DownloadEvent::Finished);
        offer.update.install(bytes).map_err(updater_error)
    }
}

#[tauri::command]
pub async fn github_update_close(
    offer_id: String,
    state: tauri::State<'_, GithubUpdateState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if inner
        .offer
        .as_ref()
        .is_some_and(|offer| offer.id == offer_id)
    {
        inner.offer = None;
    }
    if inner
        .install
        .as_ref()
        .is_some_and(|install| install.id == offer_id)
    {
        if let Some(install) = inner.install.take() {
            install.abort.abort();
        }
    }
    Ok(())
}
