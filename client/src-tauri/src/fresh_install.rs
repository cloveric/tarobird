#[cfg(windows)]
#[path = "../host-launcher/src/storage_probe.rs"]
mod storage_probe;
// Windows installer recovery. Never depends on the bundled Node runtime or
// opens a WebView. Only the current OS user's fixed application directories
// may be moved; remote hosts and custom CLI state directories are untouched.
use std::{fs, io, path::{Path, PathBuf}};

const APP_ID: &str = "com.tarobot.client";
const LEGACY_APP_ID: &str = "com.tarocub.client";

fn exists(path: &Path) -> Result<bool, &'static str> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("fresh_install_state_unreadable"),
    }
}

fn plain_directory(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "fresh_install_state_unreadable")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("fresh_install_redirected_directory"); }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return Err("fresh_install_redirected_directory"); }
    }
    Ok(())
}

/// An installed CLI can restart itself even while its PID is absent. Refuse to
/// reset that shared state until its service is uninstalled. Unknown/live PIDs
/// and malformed ownership records also block; never terminate an arbitrary PID.
fn host_stopped(root: &Path, alive: &impl Fn(u32, Option<u64>) -> Result<bool, &'static str>) -> Result<(), &'static str> {
    let host = root.join("host");
    if !exists(&host)? { return Ok(()); }
    plain_directory(&host)?;
    for name in ["host-service.json", "host-service-refresh.json", "update-in-progress.json"] {
        if exists(&host.join(name))? { return Err("fresh_install_cli_service_present"); }
    }
    let lock = host.join("instance.lock.json");
    if !exists(&lock)? { return Ok(()); }
    let metadata = fs::symlink_metadata(&lock).map_err(|_| "fresh_install_state_unreadable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Err("fresh_install_host_state_unknown");
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(lock).map_err(|_| "fresh_install_state_unreadable")?)
        .map_err(|_| "fresh_install_host_state_unknown")?;
    let pid = value.get("pid").and_then(|value| value.as_u64()).and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0).ok_or("fresh_install_host_state_unknown")?;
    let birth = value.get("processBirth").and_then(|value| value.as_str()).and_then(|value| value.strip_prefix("win32:")).and_then(|value| value.parse::<u64>().ok());
    if alive(pid, birth)? { return Err("fresh_install_host_running"); }
    Ok(())
}

/// Move both roots into unique sibling backup folders. Check every root before
/// changing any. A failed second move rolls the first back; never overwrite a
/// newly created directory during rollback. No recursive deletion is used.
fn reset_with(
    roots: &[PathBuf], suffix: &str,
    alive: &impl Fn(u32, Option<u64>) -> Result<bool, &'static str>,
    rename: &impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<(), &'static str> {
    if suffix.is_empty() || !suffix.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("fresh_install_invalid_backup_name");
    }
    let mut plan = Vec::new();
    for root in roots {
        if root.file_name().is_none_or(|name| name != APP_ID && name != LEGACY_APP_ID) { return Err("fresh_install_invalid_directory"); }
        if plan.iter().any(|(source, _, _): &(PathBuf, PathBuf, PathBuf)| source == root) { continue; }
        if !exists(root)? { continue; }
        plain_directory(root)?;
        host_stopped(root, alive)?;
        let folder = root.parent().ok_or("fresh_install_invalid_directory")?.join(format!("TaroBot-backup-{suffix}"));
        if exists(&folder)? { return Err("fresh_install_backup_exists"); }
        plan.push((root.clone(), folder.join(root.file_name().ok_or("fresh_install_invalid_directory")?), folder));
    }
    let mut folders = Vec::new();
    for (_, _, folder) in &plan {
        if folders.contains(&folder) { continue; }
        if fs::create_dir(folder).is_err() {
            for previous in folders { let _ = fs::remove_dir(previous); }
            return Err("fresh_install_backup_unavailable");
        }
        folders.push(folder);
    }
    let mut moved: Vec<(&PathBuf, &PathBuf)> = Vec::new();
    for (source, destination, _) in &plan {
        // Recheck immediately before moving in case an App/CLI was started
        // while the installer was asking the user to close applications.
        let failure = host_stopped(source, alive).err().or_else(|| rename(source, destination).err().map(|_| "fresh_install_move_failed"));
        if let Some(error) = failure {
            let mut rolled_back = true;
            for (original, backup) in moved.iter().rev() {
                if exists(original) != Ok(false) || rename(backup, original).is_err() { rolled_back = false; }
            }
            for folder in &folders { let _ = fs::remove_dir(folder); }
            return Err(if rolled_back { error } else { "fresh_install_rollback_incomplete" });
        }
        moved.push((source, destination));
    }
    // Recovery backups retain host history, not the client's installation key.
    // Otherwise restoring a fresh-start backup could resurrect remote pairing.
    // Do this only after every move commits so ordinary rollback keeps access.
    for (_, backup) in moved {
        match fs::remove_file(backup.join("tarobot-client-installation-v1")) {
            Ok(()) => {},
            Err(error) if error.kind() == io::ErrorKind::NotFound => {},
            Err(_) => return Err("fresh_install_rollback_incomplete"),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn process_alive(pid: u32, expected_birth: Option<u64>) -> Result<bool, &'static str> {
    use windows::Win32::{Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, FILETIME}, System::Threading::{OpenProcess, GetExitCodeProcess, GetProcessTimes, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(error) if error.code() == ERROR_INVALID_PARAMETER.to_hresult() => return Ok(false),
            Err(_) => return Err("fresh_install_process_unconfirmed"),
        };
        let mut code = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        let birth_matches = if let Some(expected) = expected_birth {
            let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            match GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) {
                Ok(()) => Some(((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) == expected),
                Err(_) => None,
            }
        } else { Some(true) };
        let _ = CloseHandle(handle);
        result.map_err(|_| "fresh_install_process_unconfirmed")?;
        Ok(code == 259 && birth_matches.ok_or("fresh_install_process_unconfirmed")?) // STILL_ACTIVE
    }
}

#[cfg(windows)]
pub fn confirm_stopped() -> bool {
    if storage_probe::package_family(std::process::id()) != Ok(None) { return false; }
    dirs::data_dir().map(|base| {
        [APP_ID, LEGACY_APP_ID].into_iter().all(|id| {
            let root = base.join(id);
            exists(&root) == Ok(false) || (plain_directory(&root).is_ok() && host_stopped(&root, &process_alive).is_ok())
        })
    }).unwrap_or(false)
}

#[cfg(windows)]
pub fn installer_command() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--confirm-host-stopped") {
        return Some(if args.len() == 2 && confirm_stopped() { 0 } else { 22 });
    }
    if args.get(1).is_none_or(|arg| arg != "--prepare-fresh-install") { return None; }
    Some((|| -> Result<(), &'static str> {
        if args.len() != 2 { return Err("fresh_install_invalid_arguments"); }
        if storage_probe::package_family(std::process::id()) != Ok(None) { return Err("fresh_install_redirected_directory"); }
        // Identical Known Folder APIs to Tauri app_data_dir/app_local_data_dir;
        // never trust an installer-provided path or a redirected APPDATA env.
        let bases = [dirs::data_dir(), dirs::data_local_dir()].into_iter()
            .map(|base| base.ok_or("fresh_install_directory_unavailable"))
            .collect::<Result<Vec<_>, _>>()?;
        let roots = bases.iter().flat_map(|base| [base.join(APP_ID), base.join(LEGACY_APP_ID)]).collect::<Vec<_>>();
        reset_with(&roots, &uuid::Uuid::new_v4().to_string(), &process_alive, &|from, to| fs::rename(from, to))
    })().map(|_| 0).unwrap_or_else(|code| {
        eprintln!("{code}");
        match code {
            "fresh_install_cli_service_present" => 21,
            "fresh_install_host_running" | "fresh_install_process_unconfirmed" | "fresh_install_host_state_unknown" => 22,
            "fresh_install_rollback_incomplete" => 24,
            _ => 23,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, Vec<PathBuf>) {
        let root = std::env::temp_dir().join(format!("tarobot-fresh-test-{}", uuid::Uuid::new_v4()));
        let paths = vec![root.join("roaming").join(APP_ID), root.join("local").join(APP_ID)];
        for path in &paths { fs::create_dir_all(path).unwrap(); fs::write(path.join("identity"), b"preserve").unwrap(); }
        (root, paths)
    }
    fn rename(from: &Path, to: &Path) -> io::Result<()> { fs::rename(from, to) }
    #[test]
    fn fresh_start_preserves_backups_and_does_not_touch_other_apps() {
        let (root, paths) = setup();
        fs::write(root.join("unrelated"), "keep").unwrap();
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        for path in paths {
            assert!(!path.exists());
            assert_eq!(fs::read(path.parent().unwrap().join("TaroBot-backup-test").join(APP_ID).join("identity")).unwrap(), b"preserve");
        }
        assert_eq!(fs::read(root.join("unrelated")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fresh_reset_covers_both_native_identities_without_resurrecting_old_pairing() {
        let (root, mut paths) = setup();
        let old = root.join("roaming").join(LEGACY_APP_ID); fs::create_dir_all(&old).unwrap();
        fs::write(old.join("identity"), b"legacy").unwrap();
        fs::write(old.join("tarobot-client-installation-v1"), [4; 32]).unwrap();
        paths.push(old.clone());
        reset_with(&paths, "both", &|_, _| Ok(false), &rename).unwrap();
        assert!(!old.exists());
        let backup = root.join("roaming/TaroBot-backup-both");
        assert_eq!(fs::read(backup.join(LEGACY_APP_ID).join("identity")).unwrap(), b"legacy");
        assert!(backup.join(APP_ID).join("identity").exists());
        assert!(!backup.join(LEGACY_APP_ID).join("tarobot-client-installation-v1").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cli_service_and_live_or_unknown_lock_block_before_any_move() {
        for record in [Some("{}"), Some("{\"pid\":123}"), None] {
            let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
            if let Some(value) = record { fs::write(host.join("instance.lock.json"), value).unwrap(); }
            else { fs::write(host.join("host-service.json"), "{}").unwrap(); }
            assert!(reset_with(&paths, "test", &|_, _| Ok(true), &rename).is_err());
            assert!(paths.iter().all(|p| p.join("identity").is_file()));
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn dead_owner_can_reset_and_no_backup_is_overwritten() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123}").unwrap();
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        fs::create_dir(&paths[0]).unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err("fresh_install_backup_exists"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_second_move_rolls_first_back() {
        let (root, paths) = setup();
        fs::write(paths[0].join("tarobot-client-installation-v1"), [3; 32]).unwrap();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &|from, to| {
            if from == paths[1] { Err(io::Error::from(io::ErrorKind::PermissionDenied)) } else { rename(from, to) }
        });
        assert_eq!(result, Err("fresh_install_move_failed"));
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        assert_eq!(fs::read(paths[0].join("tarobot-client-installation-v1")).unwrap(), [3; 32]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn full_removal_backup_cannot_restore_client_authorization() {
        let (root, paths) = setup();
        for path in &paths { fs::write(path.join("tarobot-client-installation-v1"), [3; 32]).unwrap(); }
        reset_with(&paths, "test", &|_, _| Ok(false), &rename).unwrap();
        for path in &paths {
            let backup = path.parent().unwrap().join("TaroBot-backup-test").join(APP_ID);
            assert!(backup.join("identity").is_file());
            assert!(!backup.join("tarobot-client-installation-v1").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_rollback_preserves_backup_instead_of_overwriting_new_data() {
        let (root, paths) = setup();
        let result = reset_with(&paths, "test", &|_, _| Ok(false), &|from, to| {
            if from == paths[1] {
                fs::create_dir(&paths[0]).unwrap(); fs::write(paths[0].join("new"), "new").unwrap();
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else { rename(from, to) }
        });
        assert_eq!(result, Err("fresh_install_rollback_incomplete"));
        assert!(paths[0].join("new").is_file());
        assert!(paths[0].parent().unwrap().join("TaroBot-backup-test").join(APP_ID).join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn second_root_is_checked_before_first_root_is_moved() {
        let (root, paths) = setup(); let host = paths[1].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("host-service-refresh.json"), "{}").unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err("fresh_install_cli_service_present"));
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unreadable_process_does_not_authorize_reset() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123}").unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Err("fresh_install_process_unconfirmed"), &rename), Err("fresh_install_process_unconfirmed"));
        assert!(paths.iter().all(|p| p.join("identity").is_file()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn process_creation_identity_is_forwarded_to_the_native_check() {
        let (root, paths) = setup(); let host = paths[0].join("host"); fs::create_dir(&host).unwrap();
        fs::write(host.join("instance.lock.json"), "{\"pid\":123,\"processBirth\":\"win32:134000000001234567\"}").unwrap();
        reset_with(&paths, "test", &|pid, birth| {
            assert_eq!(pid, 123); assert_eq!(birth, Some(134000000001234567)); Ok(false)
        }, &rename).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_install_and_duplicate_known_folders_are_safe() {
        let (root, paths) = setup();
        reset_with(&[paths[0].clone(), paths[0].clone()], "test", &|_, _| Ok(false), &rename).unwrap();
        reset_with(&[paths[0].clone()], "test", &|_, _| Ok(false), &rename).unwrap();
        assert!(paths[1].join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn a_link_to_another_directory_is_never_followed() {
        let (root, paths) = setup(); fs::remove_dir_all(&paths[0]).unwrap();
        std::os::unix::fs::symlink(&paths[1], &paths[0]).unwrap();
        assert_eq!(reset_with(&paths, "test", &|_, _| Ok(false), &rename), Err("fresh_install_redirected_directory"));
        assert!(paths[1].join("identity").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
