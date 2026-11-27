//! Canvas credentials are stored in one OS credential entry per app scope.
//! Keeping the small map in one entry avoids a plaintext index and lets
//! uninstall remove the entire scope without enumerating unrelated entries.
use crate::identity::device_keychain;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::{Arc, Mutex}};
use zeroize::{Zeroize, Zeroizing};

const MAX_ENTRY_BYTES: usize = 2048; // Fits the Windows Credential Manager blob limit.
const MAX_CREDENTIALS: usize = 8;
const UNAVAILABLE: &str = "credentials_unavailable";
static UPDATE: Mutex<()> = Mutex::new(());

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    Get { scope_id: String, key: String },
    Set { scope_id: String, key: String, value: String },
    Remove { scope_id: String, key: String },
    Clear { scope_id: String },
}

struct Secrets(BTreeMap<String, String>);
impl Drop for Secrets {
    fn drop(&mut self) { for value in self.0.values_mut() { value.zeroize(); } }
}

trait Backend: Send + Sync + 'static {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn write(&self, account: &str, value: &[u8]) -> Result<(), String>;
    fn remove(&self, account: &str) -> Result<(), String>;
}

struct OsVault(String);
impl OsVault {
    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.0, account).map_err(|_| UNAVAILABLE.into())
    }
}
impl Backend for OsVault {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match self.entry(account)?.get_secret() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
    fn write(&self, account: &str, value: &[u8]) -> Result<(), String> {
        self.entry(account)?.set_secret(value).map_err(|_| UNAVAILABLE.into())
    }
    fn remove(&self, account: &str) -> Result<(), String> {
        device_keychain::delete_credential(&self.0, account).map_err(|_| UNAVAILABLE.into())
    }
}

#[derive(Clone, Default)]
pub struct CanvasCredentials {
    backend: Option<Arc<dyn Backend>>,
}
impl CanvasCredentials {
    /// The caller supplies the startup-configured installation service. The
    /// renderer cannot choose a service name or request a raw account.
    pub fn new(installation_service: String, allowed: bool) -> Self {
        let available = allowed && cfg!(any(target_os = "macos", target_os = "windows"));
        Self {
            backend: available.then(|| Arc::new(OsVault(format!("{installation_service}.canvas-credentials.v1"))) as Arc<dyn Backend>),
        }
    }

    pub async fn run(&self, request: Request) -> Result<Value, String> {
        let backend = self.backend.as_ref().ok_or(UNAVAILABLE)?.clone();
        device_keychain::run(move || run_with_backend(backend.as_ref(), request)).await
    }
}

fn account(scope: &str) -> Result<String, String> {
    if scope.is_empty() || scope == "default" || scope.encode_utf16().count() > 512
        || scope.trim() != scope || scope.chars().any(|c| c.is_ascii_control()) {
        return Err("credential_scope_invalid".into());
    }
    let mut digest = Sha256::new();
    digest.update(b"tarobird.infinite-canvas\0canvas-credentials.v1\0");
    digest.update(scope.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(digest.finalize()))
}

fn validate_key(key: &str) -> Result<(), String> {
    if !key.is_empty() && key.len() <= 128
        && key.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)) {
        return Ok(());
    }
    Err("credential_key_invalid".into())
}

fn run_with_backend(vault: &dyn Backend, request: Request) -> Result<Value, String> {
    let (scope, key) = match &request {
        Request::Get { scope_id, key } | Request::Set { scope_id, key, .. } | Request::Remove { scope_id, key } => (scope_id, Some(key)),
        Request::Clear { scope_id } => (scope_id, None),
    };
    let account = account(scope)?;
    if let Some(key) = key { validate_key(key)?; }
    // A blocked OS prompt must not accumulate same-store changes or race a
    // read-modify-write with another update in the trusted app main document.
    let _guard = UPDATE.try_lock().map_err(|_| "system_keychain_busy")?;
    if matches!(request, Request::Clear { .. }) {
        vault.remove(&account)?;
        return Ok(Value::Bool(true));
    }
    let mut secrets = match vault.read(&account)? {
        Some(bytes) if bytes.len() <= MAX_ENTRY_BYTES => {
            Secrets(serde_json::from_slice(bytes.as_slice()).map_err(|_| UNAVAILABLE)?)
        }
        Some(_) => return Err(UNAVAILABLE.into()),
        None => Secrets(BTreeMap::new()),
    };
    match request {
        Request::Get { key, .. } => Ok(secrets.0.remove(&key).map_or(Value::Null, Value::String)),
        Request::Set { key, value, .. } => {
            let value = Zeroizing::new(value);
            if value.len() > MAX_ENTRY_BYTES { return Err("credential_value_invalid".into()); }
            if let Some(mut old) = secrets.0.insert(key, value.to_string()) { old.zeroize(); }
            let serialized = Zeroizing::new(serde_json::to_vec(&secrets.0).map_err(|_| UNAVAILABLE)?);
            if secrets.0.len() > MAX_CREDENTIALS || serialized.len() > MAX_ENTRY_BYTES {
                return Err("credentials_quota_exceeded".into());
            }
            vault.write(&account, serialized.as_slice())?;
            Ok(Value::Bool(true))
        }
        Request::Remove { key, .. } => {
            let Some(mut old) = secrets.0.remove(&key) else { return Ok(Value::Bool(true)); };
            old.zeroize();
            if secrets.0.is_empty() {
                vault.remove(&account)?;
            } else {
                let serialized = Zeroizing::new(serde_json::to_vec(&secrets.0).map_err(|_| UNAVAILABLE)?);
                vault.write(&account, serialized.as_slice())?;
            }
            Ok(Value::Bool(true))
        }
        Request::Clear { .. } => unreachable!("handled before reading the entry"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct MemoryVault(Mutex<BTreeMap<String, Vec<u8>>>);
    impl Backend for MemoryVault {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            Ok(self.0.lock().unwrap().get(account).cloned().map(Zeroizing::new))
        }
        fn write(&self, account: &str, value: &[u8]) -> Result<(), String> {
            self.0.lock().unwrap().insert(account.into(), value.to_vec()); Ok(())
        }
        fn remove(&self, account: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(account); Ok(())
        }
    }
    fn request(vault: &MemoryVault, json: Value) -> Result<Value, String> {
        run_with_backend(vault, serde_json::from_value(json).unwrap())
    }

    #[test]
    fn bounds_credentials_and_preserves_scopes_and_existing_values_when_refusing_an_update() {
        use serde_json::json;
        let vault = MemoryVault::default();
        let get = |scope| json!({"action":"get","scopeId":scope,"key":"channel:default:apiKey"});
        let set = |scope,value| json!({"action":"set","scopeId":scope,"key":"channel:default:apiKey","value":value});
        assert_eq!(request(&vault, get("scope-one")).unwrap(), Value::Null);
        assert_eq!(request(&vault, set("scope-one", "fixture".to_owned())).unwrap(), Value::Bool(true));
        assert_eq!(request(&vault, set("scope-two", "other".to_owned())).unwrap(), Value::Bool(true));
        assert_eq!(request(&vault, set("scope-one", "x".repeat(MAX_ENTRY_BYTES))).unwrap_err(), "credentials_quota_exceeded");
        assert_eq!(request(&vault, get("scope-one")).unwrap(), "fixture");
        assert_eq!(request(&vault, get("default")).unwrap_err(), "credential_scope_invalid");
        assert_eq!(request(&vault, json!({"action":"remove","scopeId":"scope-one","key":"channel:default:apiKey"})).unwrap(), true);
        assert_eq!(request(&vault, get("scope-one")).unwrap(), Value::Null);
        assert_eq!(request(&vault, get("scope-two")).unwrap(), "other");
        assert_eq!(request(&vault, json!({"action":"clear","scopeId":"scope-two"})).unwrap(), true);
        assert!(vault.0.lock().unwrap().is_empty());
    }

    #[test]
    fn request_rejects_caller_selected_service_and_account() {
        for field in ["service", "account"] {
            let mut value = serde_json::json!({"action":"get","scopeId":"scope-one","key":"apiKey"});
            value[field] = Value::String("foreign".into());
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }
}
