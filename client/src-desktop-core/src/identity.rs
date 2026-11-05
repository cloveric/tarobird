//! Device identity, ported from the Tauri commands in `src-tauri/src/main.rs`.
//! Signing domains, installation binding and the credential layout are the
//! shared modules themselves, included read-only.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use std::{path::PathBuf, sync::Arc};
use zeroize::Zeroizing;

#[path = "../../src-tauri/src/device_installation.rs"]
pub mod device_installation;
#[path = "../../src-tauri/src/device_actions.rs"]
pub mod device_actions;
#[path = "../../src-tauri/src/device_keychain.rs"]
pub mod device_keychain;

pub const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

pub fn spki(key: &SigningKey) -> String {
    let mut spki = SPKI_PREFIX.to_vec();
    spki.extend(key.verifying_key().as_bytes());
    STANDARD.encode(spki)
}

pub fn valid_device_id(device_id: &str) -> bool {
    device_id.starts_with("device_") && device_id.len() <= 80
        && device_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// The OS credential store. Errors use the existing Tauri codes.
pub trait Vault: Send + Sync + 'static {
    fn get(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, String>;
    fn set(&self, device_id: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, device_id: &str) -> Result<(), String>;
}

pub struct KeyringVault { service: String }
impl KeyringVault {
    pub fn new(service: String) -> Self { Self { service } }
    fn entry(&self, device_id: &str) -> Result<keyring::Entry, String> {
        if !valid_device_id(device_id) { return Err("invalid_device_id".into()); }
        keyring::Entry::new(&self.service, device_id).map_err(|_| "system_keychain_unavailable".into())
    }
}
impl Vault for KeyringVault {
    fn get(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        Ok(Zeroizing::new(self.entry(device_id)?.get_secret().map_err(|_| "device_key_unavailable")?))
    }
    fn set(&self, device_id: &str, value: &[u8]) -> Result<(), String> {
        self.entry(device_id)?.set_secret(value).map_err(|_| "system_keychain_write_failed".into())
    }
    fn delete(&self, device_id: &str) -> Result<(), String> {
        if !valid_device_id(device_id) { return Err("invalid_device_id".into()); }
        device_keychain::delete_credential(&self.service, device_id).map_err(|_| "device_key_delete_failed".into())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity { device_id: String, key_ref: String, public_key: String }

/// Raw saved value for the local-controller path, which alone may migrate a
/// legacy unbound 32-byte key after the local Host accepts its proof.
pub struct PairSecret { pub seed: Zeroizing<Vec<u8>>, pub legacy: bool }

#[derive(Clone)]
pub struct Identity { vault: Arc<dyn Vault>, state_dir: PathBuf }
impl Identity {
    pub fn new(vault: Arc<dyn Vault>, state_dir: PathBuf) -> Self { Self { vault, state_dir } }
    fn installation(&self) -> Result<[u8; 32], String> { device_installation::identifier(&self.state_dir) }
    fn seed(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        if !valid_device_id(device_id) { return Err("invalid_device_id".into()); }
        let marker = self.installation()?;
        let saved = self.vault.get(device_id)?;
        device_installation::seed(&marker, &saved)
    }

    pub async fn create(&self) -> Result<DeviceIdentity, String> {
        let this = self.clone();
        device_keychain::run(move || {
            let device_id = format!("device_{}", uuid::Uuid::new_v4().simple());
            let mut seed = Zeroizing::new([0u8; 32]);
            getrandom::fill(seed.as_mut()).map_err(|_| "secure_random_unavailable")?;
            let key = SigningKey::from_bytes(&seed);
            let saved = device_installation::bind(&this.installation()?, seed.as_ref())?;
            this.vault.set(&device_id, saved.as_slice())?;
            // Only the public SubjectPublicKeyInfo leaves native code.
            Ok(DeviceIdentity { key_ref: device_id.clone(), device_id, public_key: spki(&key) })
        }).await
    }

    pub async fn sign(&self, key_ref: String, device_id: String, nonce: String, client_nonce: String) -> Result<String, String> {
        if key_ref != device_id || nonce.len() > 256 || client_nonce.len() > 256 || nonce.is_empty() || client_nonce.is_empty()
            || nonce.contains('\0') || client_nonce.contains('\0') {
            return Err("invalid_challenge".into());
        }
        let this = self.clone();
        device_keychain::run(move || {
            let secret = this.seed(&key_ref)?;
            let seed: &[u8; 32] = secret.as_slice().try_into().map_err(|_| "device_key_invalid")?;
            let proof = format!("tarocub/device/v1\0{device_id}\0{nonce}\0{client_nonce}");
            Ok(STANDARD.encode(SigningKey::from_bytes(seed).sign(proof.as_bytes()).to_bytes()))
        }).await
    }

    pub async fn forget(&self, key_ref: String) -> Result<(), String> {
        let this = self.clone();
        device_keychain::run(move || {
            if !valid_device_id(&key_ref) { return Err("invalid_device_id".into()); }
            this.vault.delete(&key_ref)
        }).await
    }

    pub async fn sign_action(&self, key_ref: String, statement: device_actions::Statement) -> Result<String, String> {
        if key_ref != statement.device_id { return Err("invalid_device_id".into()); }
        statement.proof()?;
        let this = self.clone();
        device_keychain::run(move || {
            let secret = this.seed(&key_ref)?;
            let seed: &[u8; 32] = secret.as_slice().try_into().map_err(|_| "device_key_invalid")?;
            device_actions::sign(&SigningKey::from_bytes(seed), &statement)
        }).await
    }

    /// Reads the native secret for the local controller (Tauri `desktop_host` pair).
    pub fn pair_secret(&self, device_id: &str) -> Result<PairSecret, String> {
        if !valid_device_id(device_id) { return Err("invalid_device_id".into()); }
        let saved = self.vault.get(device_id)?;
        if saved.len() == 32 { return Ok(PairSecret { seed: saved, legacy: true }); }
        Ok(PairSecret { seed: device_installation::seed(&self.installation()?, &saved)?, legacy: false })
    }

    /// Commits a legacy key migration only after the local Host accepted it.
    pub fn bind_legacy(&self, device_id: &str, seed: &[u8]) -> Result<(), String> {
        let saved = device_installation::bind(&self.installation()?, seed)?;
        self.vault.set(device_id, saved.as_slice()).map_err(|_| "system_keychain_write_failed".into())
    }
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};
    #[derive(Default)]
    pub struct MemoryVault(pub Mutex<HashMap<String, Vec<u8>>>);
    impl Vault for MemoryVault {
        fn get(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
            if !valid_device_id(id) { return Err("invalid_device_id".into()); }
            self.0.lock().unwrap().get(id).cloned().map(Zeroizing::new).ok_or_else(|| "device_key_unavailable".into())
        }
        fn set(&self, id: &str, value: &[u8]) -> Result<(), String> {
            if !valid_device_id(id) { return Err("invalid_device_id".into()); }
            self.0.lock().unwrap().insert(id.into(), value.to_vec()); Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            if !valid_device_id(id) { return Err("invalid_device_id".into()); }
            self.0.lock().unwrap().remove(id); Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{memory::MemoryVault, *};
    use ed25519_dalek::{Signature, VerifyingKey};

    pub fn lab(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("desktop-core-{name}-{}", uuid::Uuid::new_v4().simple()))
    }
    fn verify(public_key: &str, message: &str, signature: &str) {
        let spki = STANDARD.decode(public_key).unwrap();
        let key = VerifyingKey::from_bytes(spki[12..].try_into().unwrap()).unwrap();
        let signature = Signature::from_slice(&STANDARD.decode(signature).unwrap()).unwrap();
        key.verify_strict(message.as_bytes(), &signature).unwrap();
    }

    #[tokio::test]
    async fn created_keys_are_installation_bound_and_sign_the_existing_domain() {
        let vault = Arc::new(MemoryVault::default());
        let state = lab("identity");
        let identity = Identity::new(vault.clone(), state.clone());
        let created = serde_json::to_value(identity.create().await.unwrap()).unwrap();
        let id = created["deviceId"].as_str().unwrap().to_owned();
        assert_eq!(created["keyRef"], created["deviceId"]);
        assert!(valid_device_id(&id));
        assert_eq!(vault.0.lock().unwrap()[&id].len(), 68, "stored value must be the bound vault format");
        let signature = identity.sign(id.clone(), id.clone(), "server".into(), "client".into()).await.unwrap();
        verify(created["publicKey"].as_str().unwrap(), &format!("tarocub/device/v1\0{id}\0server\0client"), &signature);
        // Full data removal (a new installation marker) cannot reactivate the vault value.
        std::fs::remove_dir_all(&state).unwrap();
        assert_eq!(identity.sign(id.clone(), id.clone(), "n".into(), "c".into()).await.unwrap_err(), "device_pairing_required");
        identity.forget(id.clone()).await.unwrap();
        assert!(vault.0.lock().unwrap().is_empty());
        identity.forget(id.clone()).await.unwrap();
        let _ = std::fs::remove_dir_all(state);
    }

    #[tokio::test]
    async fn invalid_requests_fail_before_the_vault_is_touched() {
        let state = lab("invalid");
        let identity = Identity::new(Arc::new(MemoryVault::default()), state.clone());
        for (key, device, nonce, client) in [("device_a", "device_b", "n", "c"), ("device_a", "device_a", "", "c"),
            ("device_a", "device_a", "n\0", "c"), ("device_a", "device_a", &"n".repeat(257) as &str, "c")] {
            assert_eq!(identity.sign(key.into(), device.into(), nonce.into(), client.into()).await.unwrap_err(), "invalid_challenge");
        }
        for bad in ["device_../x", "other_1", "device_a-b"] {
            assert_eq!(identity.sign(bad.into(), bad.into(), "n".into(), "c".into()).await.unwrap_err(), "invalid_device_id");
            assert_eq!(identity.forget(bad.into()).await.unwrap_err(), "invalid_device_id");
        }
        assert_eq!(identity.sign("device_missing".into(), "device_missing".into(), "n".into(), "c".into()).await.unwrap_err(), "device_key_unavailable");
        let _ = std::fs::remove_dir_all(state);
    }

    #[tokio::test]
    async fn device_actions_use_the_shared_vector_domain_and_require_the_matching_key_ref() {
        let vault = Arc::new(MemoryVault::default());
        let state = lab("action");
        let identity = Identity::new(vault.clone(), state.clone());
        let vector: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/device-action-vector.json")).unwrap();
        let device_id = vector["statement"]["deviceId"].as_str().unwrap().to_owned();
        let marker = device_installation::identifier(&state).unwrap();
        // The shared vector uses a device id outside the native `device_` namespace.
        let native_id = "device_vector".to_owned();
        vault.set(&native_id, &device_installation::bind(&marker, &[7u8; 32]).unwrap()).unwrap();
        let mut statement = vector["statement"].clone();
        statement["deviceId"] = native_id.clone().into();
        let parsed: device_actions::Statement = serde_json::from_value(statement.clone()).unwrap();
        let expected = device_actions::sign(&SigningKey::from_bytes(&[7u8; 32]), &parsed).unwrap();
        let signed = identity.sign_action(native_id.clone(), serde_json::from_value(statement.clone()).unwrap()).await.unwrap();
        assert_eq!(signed, expected);
        assert_eq!(identity.sign_action(device_id, serde_json::from_value(statement).unwrap()).await.unwrap_err(), "invalid_device_id");
        let _ = std::fs::remove_dir_all(state);
    }

    #[test]
    fn local_controller_reads_bound_and_legacy_keys_and_binds_legacy_only_on_commit() {
        let vault = Arc::new(MemoryVault::default());
        let state = lab("pair");
        let identity = Identity::new(vault.clone(), state.clone());
        vault.set("device_legacy", &[9u8; 32]).unwrap();
        let legacy = identity.pair_secret("device_legacy").unwrap();
        assert!(legacy.legacy);
        assert_eq!(vault.0.lock().unwrap()["device_legacy"].len(), 32, "reading must not migrate");
        identity.bind_legacy("device_legacy", &legacy.seed).unwrap();
        let bound = identity.pair_secret("device_legacy").unwrap();
        assert!(!bound.legacy);
        assert_eq!(bound.seed.as_slice(), &[9u8; 32]);
        vault.set("device_broken", &[1u8; 40]).unwrap();
        assert_eq!(identity.pair_secret("device_broken").err().unwrap(), "device_pairing_required");
        let _ = std::fs::remove_dir_all(state);
    }
}
