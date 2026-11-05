//! GitHub device-flow credential rules shared by the Tauri updater and the
//! Electron update helper. Secrets live in zeroizing owners; no Tauri types.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, Zeroizing};

/// Existing installations keep one login per repository and OAuth app.
pub const KEYCHAIN_SERVICE: &str = "com.tarobot.client.github-updates";
pub fn keychain_account(repository: &str, client_id: &str) -> String {
    format!("{repository}:{client_id}")
}

#[derive(Deserialize, Serialize)]
pub struct Credential {
    pub token: String,
    pub login: String,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub refresh_expires_at: Option<u64>,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.token.zeroize();
        if let Some(token) = self.refresh_token.as_mut() {
            token.zeroize();
        }
    }
}

pub fn epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "github_update_response".into())
}
impl Credential {
    pub fn needs_refresh(&self, now: u64) -> bool {
        self.expires_at
            .is_some_and(|expiry| expiry <= now.saturating_add(60))
    }
    /// The refresh token, while it is still accepted by GitHub.
    pub fn usable_refresh(&self, now: u64) -> Option<&str> {
        self.refresh_token
            .as_deref()
            .filter(|_| self.refresh_expires_at.is_some_and(|expiry| expiry > now))
    }
    /// Validates a keychain secret before any field is used.
    pub fn from_stored(secret: &[u8]) -> Result<Self, String> {
        if secret.len() > 4096 {
            return Err("github_update_keychain".into());
        }
        let credential: Credential =
            serde_json::from_slice(secret).map_err(|_| "github_update_keychain")?;
        if !valid_token(&credential.token)
            || !valid_login(&credential.login)
            || credential
                .refresh_token
                .as_ref()
                .is_some_and(|token| !valid_token(token))
        {
            return Err("github_update_keychain".into());
        }
        Ok(credential)
    }
    pub fn to_secret(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        Ok(Zeroizing::new(
            serde_json::to_vec(self).map_err(|_| "github_update_keychain")?,
        ))
    }
    pub fn from_response(mut response: Value, login: String, now: u64) -> Result<Self, String> {
        let take_token = |response: &mut Value, key: &str| -> Option<String> {
            match response.as_object_mut()?.remove(key)? {
                Value::String(token) => Some(token),
                _ => None,
            }
        };
        // Capture secrets in the zeroizing owner before validating other fields.
        let mut credential = Self {
            token: take_token(&mut response, "access_token").unwrap_or_default(),
            login,
            refresh_token: take_token(&mut response, "refresh_token"),
            expires_at: None,
            refresh_expires_at: None,
        };
        if !valid_token(&credential.token)
            || !response
                .get("token_type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("bearer"))
            || !response
                .get("scope")
                .and_then(Value::as_str)
                .is_some_and(|scopes| scopes.split([',', ' ']).any(|scope| scope == "repo"))
        {
            return Err("github_update_response".into());
        }
        let expiry = |key: &str| -> Result<Option<u64>, String> {
            match response.get(key) {
                None => Ok(None),
                Some(value) => value
                    .as_u64()
                    .filter(|seconds| *seconds > 60 && *seconds <= 366 * 86400)
                    .and_then(|seconds| now.checked_add(seconds))
                    .map(Some)
                    .ok_or("github_update_response".into()),
            }
        };
        credential.expires_at = expiry("expires_in")?;
        credential.refresh_expires_at = expiry("refresh_token_expires_in")?;
        if credential
            .refresh_token
            .as_ref()
            .is_some_and(|token| !valid_token(token))
            || credential.expires_at.is_some() != credential.refresh_token.is_some()
            || credential.refresh_token.is_some() != credential.refresh_expires_at.is_some()
        {
            return Err("github_update_response".into());
        }
        Ok(credential)
    }
}
pub fn valid_token(token: &str) -> bool {
    (10..=512).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 100
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
/// Device codes are bearer secrets for the pending flow; user codes are shown.
pub fn valid_device_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 1024
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn valid_user_code(code: &str) -> bool {
    (4..=32).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
}
