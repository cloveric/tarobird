//! The GitHub credential lives in the OS keychain entry the Tauri App already
//! uses (`com.tarobot.client.github-updates`, `<repo>:<clientId>`), so an
//! existing login carries over. It is never returned through the protocol.
use crate::{credential, device_keychain};
use std::sync::Arc;
use zeroize::Zeroizing;

pub trait Vault: Send + Sync {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn set(&self, secret: &[u8]) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

pub struct Keychain {
    account: String,
}
impl Keychain {
    pub fn new(repository: &str, client_id: &str) -> Self {
        Self {
            account: credential::keychain_account(repository, client_id),
        }
    }
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(credential::KEYCHAIN_SERVICE, &self.account)
            .map_err(|_| "github_update_keychain".into())
    }
}
impl Vault for Keychain {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match self.entry()?.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("github_update_keychain".into()),
        }
    }
    fn set(&self, secret: &[u8]) -> Result<(), String> {
        self.entry()?
            .set_secret(secret)
            .map_err(|_| "github_update_keychain".into())
    }
    fn delete(&self) -> Result<(), String> {
        device_keychain::delete_credential(credential::KEYCHAIN_SERVICE, &self.account)
            .map_err(|_| "github_update_keychain".into())
    }
}

/// Lab builds store the credential in a fixture file and can never reach the
/// user's keychain. The path comes from the lab harness environment.
#[cfg(feature = "lab")]
pub struct LabFile(pub std::path::PathBuf);
#[cfg(feature = "lab")]
impl Vault for LabFile {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match std::fs::read(&self.0) {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("github_update_keychain".into()),
        }
    }
    fn set(&self, secret: &[u8]) -> Result<(), String> {
        std::fs::write(&self.0, secret).map_err(|_| "github_update_keychain".into())
    }
    fn delete(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.0) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("github_update_keychain".into()),
        }
    }
}

#[derive(Default)]
pub struct Memory(std::sync::Mutex<Option<Vec<u8>>>);
impl Vault for Memory {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn set(&self, secret: &[u8]) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(secret.to_vec());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

/// OS credential calls can block on an unlock prompt; run them off the async
/// workers, one at a time, exactly like the Tauri App.
pub async fn run<T: Send + 'static>(
    vault: &Arc<dyn Vault>,
    operation: impl FnOnce(&dyn Vault) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let vault = vault.clone();
    device_keychain::run(move || operation(vault.as_ref()))
        .await
        .map_err(|error| {
            if error.starts_with("github_update_") {
                error
            } else {
                "github_update_keychain".into()
            }
        })
}
