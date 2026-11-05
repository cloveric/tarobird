//! `tarobot-installer-helper.exe`: the native half of the Electron NSIS
//! installer hooks. The Tauri App answered these flags from its own exe; an
//! Electron exe cannot run from the installer's plugin directory and must not
//! start Chromium to stop a Host, so a standalone helper owns them:
//!   --prepare-fresh-install / --confirm-host-stopped  (Tauri fresh_install.rs, unchanged)
//!   --stop-desktop-host                               (Tauri desktop_host installer flow)
//!   --remove-legacy-host-runtime                      (Tauri -> Electron: drop `<install>\host`)
//! Notification shortcut registration stays with `tarocub-client.exe` itself:
//! it verifies that the shortcut targets the running executable.
#![cfg_attr(not(windows), allow(dead_code))]
// Its nested storage probe also serves the Host launcher; only
// `package_family` is used here.
#[cfg(any(windows, test))]
#[allow(dead_code, unused_imports)]
#[path = "../../../src-tauri/src/fresh_install.rs"]
mod fresh_install;
#[cfg(windows)]
#[allow(dead_code)]
#[path = "../../../src-tauri/shared/native_identity.rs"]
mod native_identity;
#[cfg(windows)]
#[path = "../../../src-tauri/src/desktop_host_node.rs"]
mod node_runtime;

/// The Host runtime beside the installed executable: Electron layout
/// `resources\host\` first, so a Tauri `host\` left behind is never preferred;
/// then the Tauri layout. Never an installer-provided path.
fn host_runtime(install: &std::path::Path) -> Option<std::path::PathBuf> {
    [install.join("resources").join("host"), install.join("host")]
        .into_iter()
        .find(|dir| dir.join("node.exe").is_file() && dir.join("dist/src/index.js").is_file())
}

/// `--remove-legacy-host-runtime`. Refusals keep every file.
#[derive(Debug, PartialEq, Eq)]
enum LegacyHost { Absent, Removed, Unknown, Redirected, NewRuntimeMissing, HostRunning, RemoveFailed }
impl LegacyHost {
    fn code(&self) -> i32 {
        match self {
            Self::Absent | Self::Removed => 0,
            Self::Unknown => 30, Self::Redirected => 31, Self::NewRuntimeMissing => 32, Self::HostRunning => 33, Self::RemoveFailed => 34,
        }
    }
}
/// A symlink, junction or other reparse point.
fn redirected(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 } // FILE_ATTRIBUTE_REPARSE_POINT
    #[cfg(not(windows))]
    { metadata.file_type().is_symlink() }
}
fn plain(path: &std::path::Path, directory: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| !redirected(&metadata) && if directory { metadata.is_dir() } else { metadata.is_file() })
}
fn bundled_runtime(dir: &std::path::Path) -> bool {
    plain(dir, true) && plain(&dir.join("node.exe"), false) && plain(&dir.join("dist"), true) && plain(&dir.join("dist/src"), true) && plain(&dir.join("dist/src/index.js"), false)
}
fn contains_redirect(dir: &std::path::Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if redirected(&metadata) || metadata.is_dir() && contains_redirect(&path)? { return Ok(true); }
    }
    Ok(false)
}

/// The Tauri layout kept its Host runtime in `<install>\host`. An update to the
/// Electron layout skips the old uninstaller, and the new one removes only its
/// own files, so that folder would stay forever. Remove exactly that folder,
/// only when it is a bundled TaroBot runtime with no redirection anywhere
/// inside, beside the installed App, once the new `resources\host` runtime
/// exists and the Host is confirmed stopped (checked last).
fn remove_legacy_host(install: &std::path::Path, host_stopped: impl FnOnce() -> bool) -> LegacyHost {
    let old = install.join("host");
    let metadata = match std::fs::symlink_metadata(&old) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LegacyHost::Absent,
        Err(_) => return LegacyHost::Unknown,
    };
    if redirected(&metadata) { return LegacyHost::Redirected; }
    if !plain(&install.join("tarocub-client.exe"), false) || !metadata.is_dir() { return LegacyHost::Unknown; }
    if !plain(&install.join("resources"), true) || !bundled_runtime(&install.join("resources").join("host")) { return LegacyHost::NewRuntimeMissing; }
    if !bundled_runtime(&old) { return LegacyHost::Unknown; }
    let package = old.join("package.json");
    let named = plain(&package, false) && std::fs::metadata(&package).is_ok_and(|metadata| metadata.len() <= 1 << 20)
        && std::fs::read(&package).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| matches!(value.get("name").and_then(serde_json::Value::as_str), Some("tarobot" | "tarocub")));
    if !named { return LegacyHost::Unknown; }
    match contains_redirect(&old) { Ok(false) => {} Ok(true) => return LegacyHost::Redirected, Err(_) => return LegacyHost::Unknown }
    if !host_stopped() { return LegacyHost::HostRunning; }
    if std::fs::remove_dir_all(&old).is_ok() { LegacyHost::Removed } else { LegacyHost::RemoveFailed }
}

/// Port of `desktop_host::installer_command` (Tauri): ask the bundled CLI to
/// stop the canonical Host; a damaged runtime may still pass when native
/// ownership checks confirm nothing of ours is running.
#[cfg(windows)]
fn stop_desktop_host() -> i32 {
    use std::time::{Duration, Instant};
    (|| -> Result<i32, ()> {
        let executable = std::env::current_exe().map_err(|_| ())?;
        let Some(resources) = host_runtime(executable.parent().ok_or(())?) else { return Ok(0) };
        let directory = native_identity::host_directory(&dirs::data_dir().ok_or(())?).map_err(|_| ())?;
        let mut child = node_runtime::command(&resources.join("node.exe"), &resources.join("dist/src/index.js"))
            .args(["hub", "service", "installer-stop", "--state-dir"]).arg(directory)
            .current_dir(&resources)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|_| ())?;
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            if let Some(status) = child.try_wait().map_err(|_| ())? {
                return Ok(if status.success() || fresh_install::confirm_stopped() { 0 } else { 1 });
            }
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(()); }
            std::thread::sleep(Duration::from_millis(50));
        }
    })().unwrap_or(1)
}

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    #[cfg(windows)]
    {
        if args.len() == 2 && args[1] == "--stop-desktop-host" { std::process::exit(stop_desktop_host()); }
        if args.len() == 2 && args[1] == "--remove-legacy-host-runtime" {
            // The installation is the helper's own folder; no path is accepted.
            let install = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf));
            std::process::exit(install.map_or(LegacyHost::Unknown, |install| remove_legacy_host(&install, fresh_install::confirm_stopped)).code());
        }
        if let Some(code) = fresh_install::installer_command() { std::process::exit(code); }
    }
    let _ = args;
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scratch() -> std::path::PathBuf {
        std::env::var_os("TAROBOT_UPDATER_LAB_ROOT").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir)
            .join(format!("tarobot-installer-helper-{}", uuid::Uuid::new_v4()))
    }
    fn runtime(dir: &std::path::Path, name: Option<&str>) {
        std::fs::create_dir_all(dir.join("dist/src")).unwrap();
        std::fs::write(dir.join("node.exe"), "MZ").unwrap();
        std::fs::write(dir.join("dist/src/index.js"), "// host").unwrap();
        if let Some(name) = name { std::fs::write(dir.join("package.json"), format!(r#"{{"name":"{name}","version":"1.0.98"}}"#)).unwrap(); }
    }
    /// An upgraded install: the App, the new runtime and the Tauri `host\`.
    fn upgraded(name: Option<&str>) -> std::path::PathBuf {
        let install = scratch();
        runtime(&install.join("resources/host"), Some("tarobot"));
        runtime(&install.join("host"), name);
        std::fs::write(install.join("tarocub-client.exe"), "MZ").unwrap();
        install
    }
    fn never() -> bool { panic!("the Host check runs only after every file check passed") }

    #[test]
    fn legacy_host_removed_only_when_identified_beside_the_new_runtime_and_stopped() {
        for name in ["tarobot", "tarocub"] {
            let install = upgraded(Some(name));
            assert_eq!(remove_legacy_host(&install, || true), LegacyHost::Removed);
            assert!(!install.join("host").exists());
            assert!(bundled_runtime(&install.join("resources/host")), "the new runtime stays");
            std::fs::remove_dir_all(&install).unwrap();
        }
        let install = upgraded(Some("tarobot"));
        assert_eq!(remove_legacy_host(&install, || false), LegacyHost::HostRunning);
        assert!(bundled_runtime(&install.join("host")));
        std::fs::remove_dir_all(&install).unwrap();
        let fresh = scratch();
        runtime(&fresh.join("resources/host"), Some("tarobot"));
        assert_eq!(remove_legacy_host(&fresh, never), LegacyHost::Absent);
        assert_eq!(LegacyHost::Absent.code(), 0);
        std::fs::remove_dir_all(&fresh).unwrap();
    }

    #[test]
    fn unknown_or_incomplete_folders_and_a_missing_new_runtime_are_kept() {
        for (name, damage) in [(Some("other"), ""), (None, ""), (Some("tarobot"), "dist/src/index.js"), (Some("tarobot"), "node.exe")] {
            let install = upgraded(name);
            if !damage.is_empty() { std::fs::remove_file(install.join("host").join(damage)).unwrap(); }
            assert_eq!(remove_legacy_host(&install, never), LegacyHost::Unknown, "{name:?} {damage}");
            assert!(install.join("host").is_dir());
            std::fs::remove_dir_all(&install).unwrap();
        }
        // Not beside the installed App (e.g. a helper copy elsewhere).
        let install = upgraded(Some("tarobot"));
        std::fs::remove_file(install.join("tarocub-client.exe")).unwrap();
        assert_eq!(remove_legacy_host(&install, never), LegacyHost::Unknown);
        std::fs::remove_dir_all(&install).unwrap();
        // `host` that is a file.
        let install = scratch();
        runtime(&install.join("resources/host"), Some("tarobot"));
        std::fs::write(install.join("tarocub-client.exe"), "MZ").unwrap();
        std::fs::write(install.join("host"), "x").unwrap();
        assert_eq!(remove_legacy_host(&install, never), LegacyHost::Unknown);
        std::fs::remove_dir_all(&install).unwrap();
        // The new runtime must be written before the old one goes.
        for damage in ["resources/host/node.exe", "resources/host/dist/src/index.js"] {
            let install = upgraded(Some("tarobot"));
            std::fs::remove_file(install.join(damage)).unwrap();
            assert_eq!(remove_legacy_host(&install, never), LegacyHost::NewRuntimeMissing, "{damage}");
            assert!(bundled_runtime(&install.join("host")));
            std::fs::remove_dir_all(&install).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn redirected_folders_are_never_followed_or_removed() {
        let outside = scratch();
        runtime(&outside, Some("tarobot"));
        // `host` itself is a link to a runtime elsewhere.
        let install = upgraded(Some("tarobot"));
        std::fs::remove_dir_all(install.join("host")).unwrap();
        std::os::unix::fs::symlink(&outside, install.join("host")).unwrap();
        assert_eq!(remove_legacy_host(&install, never), LegacyHost::Redirected);
        assert!(bundled_runtime(&outside));
        std::fs::remove_dir_all(&install).unwrap();
        // A link anywhere inside.
        let install = upgraded(Some("tarobot"));
        std::os::unix::fs::symlink(&outside, install.join("host/dist/elsewhere")).unwrap();
        assert_eq!(remove_legacy_host(&install, never), LegacyHost::Redirected);
        assert!(bundled_runtime(&outside) && install.join("host/node.exe").is_file());
        std::fs::remove_dir_all(&install).unwrap();
        // A redirected new runtime is not "written".
        let install = upgraded(Some("tarobot"));
        std::fs::remove_dir_all(install.join("resources/host")).unwrap();
        std::os::unix::fs::symlink(&outside, install.join("resources/host")).unwrap();
        assert_eq!(remove_legacy_host(&install, never), LegacyHost::NewRuntimeMissing);
        std::fs::remove_dir_all(&install).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn electron_runtime_is_preferred_over_a_tauri_folder_left_behind() {
        let install = scratch();
        runtime(&install.join("host"), Some("tarobot"));
        assert_eq!(host_runtime(&install), Some(install.join("host")));
        runtime(&install.join("resources/host"), Some("tarobot"));
        assert_eq!(host_runtime(&install), Some(install.join("resources").join("host")));
        std::fs::remove_dir_all(&install).unwrap();
    }

    #[test]
    fn host_runtime_is_found_only_in_the_two_install_layouts() {
        let root = std::env::temp_dir().join(format!("tarobot-installer-helper-{}", uuid::Uuid::new_v4()));
        assert!(host_runtime(&root).is_none());
        for layout in ["host", "resources/host"] {
            let dir = root.join(layout);
            std::fs::create_dir_all(dir.join("dist/src")).unwrap();
            std::fs::write(dir.join("node.exe"), "").unwrap();
            assert!(host_runtime(&root).is_none(), "entry missing");
            std::fs::write(dir.join("dist/src/index.js"), "").unwrap();
            assert_eq!(host_runtime(&root), Some(dir.clone()));
            std::fs::remove_dir_all(root.join(layout.split('/').next().unwrap())).unwrap();
        }
        std::fs::remove_dir_all(&root).ok();
    }
}
