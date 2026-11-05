//! Windows-only runtime checks for CI. They are compiled everywhere and run
//! only on Windows; nothing here has been executed on the development Mac.
//! Never exercises `--prepare-fresh-install`: it moves the real user's AppData.
#![cfg(windows)]
use std::{path::PathBuf, process::Command};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tarobot-windows-runtime-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A helper copied away from any install (as NSIS stages it in $PLUGINSDIR)
/// finds no Host runtime and reports "nothing to stop", like the Tauri exe.
#[test]
fn staged_helper_without_a_runtime_stops_nothing_and_refuses_unknown_commands() {
    let dir = scratch("helper");
    let helper = dir.join("tarobot-recovery.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_tarobot-installer-helper"), &helper).unwrap();
    assert_eq!(Command::new(&helper).arg("--stop-desktop-host").status().unwrap().code(), Some(0));
    assert_eq!(Command::new(&helper).arg("--register-notification-shortcut").status().unwrap().code(), Some(2));
    assert_eq!(Command::new(&helper).args(["--stop-desktop-host", "extra"]).status().unwrap().code(), Some(2));
    assert_eq!(Command::new(&helper).status().unwrap().code(), Some(2));
    // Fresh start validates its arguments before touching any directory.
    assert_eq!(Command::new(&helper).args(["--prepare-fresh-install", "C:\\elsewhere"]).status().unwrap().code(), Some(23));
    std::fs::remove_dir_all(dir).unwrap();
}

/// The static CRT lets the staged copy run with no DLL beside it. Release
/// builds are also gated by `windows-electron-installer.mjs native`; a test
/// build from the repository root (no crate .cargo/config) may be dynamic.
#[test]
fn helper_and_updater_link_the_c_runtime_statically() {
    if !cfg!(target_feature = "crt-static") {
        eprintln!("skipped: this test build was not compiled with +crt-static");
        return;
    }
    for binary in [env!("CARGO_BIN_EXE_tarobot-installer-helper"), env!("CARGO_BIN_EXE_tarobot-desktop-updater")] {
        let bytes = std::fs::read(binary).unwrap().to_ascii_lowercase();
        let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|window| window == needle);
        assert!(!contains(b"vcruntime140") && !contains(b"api-ms-win-crt-"), "{binary}");
    }
}

/// The handoff waits on its parent and starts the installer detached with the
/// Tauri updater's passive NSIS arguments.
#[test]
fn installer_handoff_starts_a_detached_process_after_its_parent() {
    use tarobot_desktop_updater::windows_handoff::{launch, parent, INSTALLER_ARGS};
    assert!(parent().is_some(), "the test runner is this process's parent");
    assert_eq!(INSTALLER_ARGS, ["/P", "/UPDATE", "/R"]);
    let dir = scratch("handoff");
    // A stand-in installer that records its arguments.
    let script = dir.join("installer.cmd");
    let record = dir.join("arguments.txt");
    std::fs::write(&script, format!("@echo %* > \"{}\"\r\n", record.display())).unwrap();
    assert!(launch(&script, None));
    for _ in 0..100 {
        if record.exists() { break; }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert_eq!(std::fs::read_to_string(&record).unwrap().trim(), "/P /UPDATE /R");
    std::fs::remove_dir_all(dir).unwrap();
}
