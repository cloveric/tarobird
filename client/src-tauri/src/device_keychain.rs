//! OS credential APIs can block while the user unlocks or authorizes access.
//! They must never occupy the async workers that drive HTTP and WebSockets.
use tokio::sync::Semaphore;

static ACCESS: Semaphore = Semaphore::const_new(1);

/// Delete exactly one application-owned service/account without reading its
/// secret. The macOS keyring store creates legacy Keychain items, but its
/// SecItemDelete path can fail with errSecInvalidOwnerEdit after a separately
/// signed executable takes over. Use the matching item-reference API; the OS
/// still enforces the original access control and signing requirements.
pub fn delete_credential(service: &str, account: &str) -> Result<(), String> {
    if service.is_empty() || account.is_empty() || service.contains('\0') || account.contains('\0')
        || service.len() > u32::MAX as usize || account.len() > u32::MAX as usize {
        return Err("system_keychain_delete_failed".into());
    }
    #[cfg(target_os = "macos")]
    { macos_delete(service, account) }
    #[cfg(not(target_os = "macos"))]
    {
        let entry = keyring::Entry::new(service, account).map_err(|_| "system_keychain_delete_failed")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("system_keychain_delete_failed".into()),
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_delete(service: &str, account: &str) -> Result<(), String> {
    use std::{ffi::c_void, ptr};
    type Ref = *mut c_void;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecKeychainCopyDomainDefault(domain: i32, keychain: *mut Ref) -> i32;
        fn SecKeychainFindGenericPassword(keychain: Ref, service_len: u32, service: *const u8,
            account_len: u32, account: *const u8, password_len: *mut u32,
            password: *mut Ref, item: *mut Ref) -> i32;
        fn SecKeychainItemDelete(item: Ref) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" { fn CFRelease(value: Ref); }
    struct Owned(Ref);
    impl Drop for Owned { fn drop(&mut self) { if !self.0.is_null() { unsafe { CFRelease(self.0); } } } }
    let mut keychain = Owned(ptr::null_mut());
    // kSecPreferencesDomainUser: same domain as apple-native-keyring-store.
    if unsafe { SecKeychainCopyDomainDefault(0, &mut keychain.0) } != 0 || keychain.0.is_null() {
        return Err("system_keychain_delete_failed".into());
    }
    let mut item = Owned(ptr::null_mut());
    let found = unsafe { SecKeychainFindGenericPassword(keychain.0, service.len() as u32, service.as_ptr(),
        account.len() as u32, account.as_ptr(), ptr::null_mut(), ptr::null_mut(), &mut item.0) };
    if found == -25300 { return Ok(()); } // errSecItemNotFound: idempotent forget.
    if found != 0 || item.0.is_null() { return Err("system_keychain_delete_failed".into()); }
    match unsafe { SecKeychainItemDelete(item.0) } {
        0 | -25300 => Ok(()),
        _ => Err("system_keychain_delete_failed".into()),
    }
}

pub async fn run<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // Do not queue a new OS prompt on every reconnect. The permit stays with
    // the blocking operation even if its caller/document has gone away.
    let permit = ACCESS.try_acquire().map_err(|_| "system_keychain_busy".to_owned())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    }).await.map_err(|_| "system_keychain_unavailable".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn deletion_refuses_empty_or_nul_selectors_before_accessing_the_vault() {
        for (service, account) in [("", "device_a"), ("svc", ""), ("s\0v", "device_a"), ("svc", "a\0b")] {
            assert_eq!(delete_credential(service, account).unwrap_err(), "system_keychain_delete_failed");
        }
    }

    #[tokio::test]
    async fn blocked_keychain_keeps_network_executor_live_and_does_not_queue_prompts() {
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let operation = tokio::spawn(run(move || {
            let _ = started.send(());
            wait.recv_timeout(Duration::from_secs(5)).map_err(|_| "test_release_timeout".to_owned())?;
            Ok(7)
        }));
        tokio::time::timeout(Duration::from_secs(1), ready).await.unwrap().unwrap();
        let rejected = run(|| Ok(9)).await;
        let tick = tokio::time::timeout(Duration::from_millis(100), tokio::time::sleep(Duration::from_millis(1))).await;
        release.send(()).unwrap();
        assert_eq!(rejected.unwrap_err(), "system_keychain_busy");
        assert!(tick.is_ok());
        assert_eq!(operation.await.unwrap().unwrap(), 7);
        assert_eq!(run(|| Ok(11)).await.unwrap(), 11);
    }
}
