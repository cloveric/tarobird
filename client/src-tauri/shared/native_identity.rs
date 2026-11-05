//! Native application identity is new; an existing Host keeps its original
//! directory and absolute workspace paths. Client vaults are never migrated.
use std::{fs, io::ErrorKind, path::{Path, PathBuf}};
pub const APP_ID: &str = "com.tarobot.client";
pub const LEGACY_APP_ID: &str = "com.tarocub.client";

/// Bounded error protocol for the read-only Windows storage helper.
/// Never send filesystem paths or OS diagnostics through stderr.
pub fn probe_failure(error: &str) -> &str {
    match error {
        "host_directory_conflict" | "host_directory_redirected" => error,
        _ => "host_directory_probe_failed",
    }
}

fn directory_present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() && !info.file_type().is_symlink() => {
            #[cfg(windows)] {
                use std::os::windows::fs::MetadataExt;
                if info.file_attributes() & 0x400 != 0 { return Err("host_directory_redirected".into()); }
            }
            Ok(true)
        },
        Ok(_) => Err("host_directory_redirected".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err("host_directory_probe_failed".into()),
    }
}

/// Resolve only these fixed per-user roots. Both present is ambiguous, even if
/// one is empty: a failed/partial setup must not silently create another Host.
pub fn host_directory(base: &Path) -> Result<PathBuf, String> {
    let current = base.join(APP_ID).join("host");
    let legacy = base.join(LEGACY_APP_ID).join("host");
    let present = |id: &str, host: &Path| -> Result<bool, String> {
        if !directory_present(&base.join(id))? { return Ok(false); }
        directory_present(host)
    };
    match (present(APP_ID, &current)?, present(LEGACY_APP_ID, &legacy)?) {
        (true, true) => Err("host_directory_conflict".into()),
        (false, true) => Ok(legacy),
        _ => Ok(current),
    }
}

/// Audit Apps retain their isolated roots rather than discovering real data.
pub fn for_app_data(root: &Path) -> Result<PathBuf, String> {
    if root.file_name().is_some_and(|name| name == APP_ID) {
        host_directory(root.parent().ok_or("host_directory_probe_failed")?)
    } else { Ok(root.join("host")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn fixture() -> PathBuf {
        // SystemTime can have microsecond resolution even when expressed as
        // nanoseconds. This module is also included by multiple native crates.
        loop {
            let sequence = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("tarobot-identity-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), sequence));
            match fs::create_dir(&path) {
                Ok(()) => return path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("identity fixture: {error}"),
            }
        }
    }
    #[test]
    fn parallel_fixtures_have_distinct_live_directories() {
        let workers: Vec<_> = (0..8).map(|_| std::thread::spawn(|| (0..16).map(|_| fixture()).collect::<Vec<_>>())).collect();
        let paths: Vec<_> = workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect();
        let distinct: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(distinct.len(), paths.len());
        for path in paths { fs::remove_dir_all(path).unwrap(); }
    }
    #[test]
    fn probe_refusals_keep_the_actionable_reason_without_exposing_details() {
        assert_eq!(probe_failure("host_directory_conflict"), "host_directory_conflict");
        assert_eq!(probe_failure("host_directory_redirected"), "host_directory_redirected");
        assert_eq!(probe_failure("private filesystem diagnostic"), "host_directory_probe_failed");
    }
    #[test]
    fn new_install_uses_new_identity_existing_host_stays_and_conflicts_fail_closed() {
        let base = fixture(); let current = base.join(APP_ID).join("host"); let old = base.join(LEGACY_APP_ID).join("host");
        assert_eq!(host_directory(&base).unwrap(), current);
        assert!(!base.join(APP_ID).exists());
        fs::create_dir_all(&old).unwrap(); fs::write(old.join("identity.json"), b"unchanged").unwrap();
        assert_eq!(host_directory(&base).unwrap(), old);
        assert_eq!(for_app_data(&base.join(APP_ID)).unwrap(), old);
        assert_eq!(fs::read(old.join("identity.json")).unwrap(), b"unchanged");
        fs::create_dir_all(&current).unwrap();
        assert_eq!(host_directory(&base).unwrap_err(), "host_directory_conflict");
        assert_eq!(for_app_data(&base.join("com.tarobot.audit")).unwrap(), base.join("com.tarobot.audit/host"));
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn malformed_legacy_root_cannot_be_silently_abandoned() {
        let base = fixture(); fs::write(base.join(LEGACY_APP_ID), b"bad").unwrap();
        assert_eq!(host_directory(&base).unwrap_err(), "host_directory_redirected");
        fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_roots_require_explicit_recovery() {
        let base = fixture(); fs::create_dir(base.join("other")).unwrap();
        std::os::unix::fs::symlink(base.join("other"), base.join(LEGACY_APP_ID)).unwrap();
        assert_eq!(host_directory(&base).unwrap_err(), "host_directory_redirected");
        fs::remove_dir_all(base).unwrap();
    }
}
