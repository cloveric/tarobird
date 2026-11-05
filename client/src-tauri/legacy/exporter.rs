//! One-time read-only WKWebView/WebView2 reader inside the Electron bundle.
//! No Host, vault, networking, notifications, protocol or updater plugins.
#[allow(dead_code)] #[path = "../src/desktop_migration.rs"] mod desktop_migration;
#[allow(dead_code)] #[path = "../src/desktop_migration_bridge.rs"] mod desktop_migration_bridge;
#[allow(dead_code)] #[path = "../src/device_installation.rs"] mod device_installation;
#[cfg(windows)] #[path = "windows_source_guard.rs"] mod windows_source_guard;
#[cfg(target_os = "macos")] #[allow(dead_code)] #[path = "../shared/macos_launch_guard.rs"] mod macos_launch_guard;
use std::{fs::{File, OpenOptions}, io::{Read, Write}, sync::atomic::{AtomicBool, Ordering}};
use fs2::FileExt;
use tauri::Manager;
#[cfg(target_os = "macos")]
tauri::embed_plist::embed_info_plist!(concat!(env!("OUT_DIR"), "/migration-reader.plist"));

struct ExportLock {
    _file: File, finished: AtomicBool, directory: std::path::PathBuf,
    // Held until exit: no old Tauri App may start writing the profile meanwhile.
    #[cfg(windows)] _source: windows_source_guard::SourceGuard,
}
/// Parent-visible codes are short lowercase identifiers only. A reader error
/// such as `migration_value_too_large:<store or size>` keeps its reason and
/// drops the detail, so a resource limit is reported as itself rather than as
/// a generic failure that a retry would only repeat.
fn code(value: &str) -> String {
    let reason = value.split(':').next().unwrap_or_default();
    if !reason.is_empty() && reason.len() < 128 && reason.bytes().all(|c| c.is_ascii_lowercase() || c == b'_') { reason.into() } else { "migration_export_failed".into() }
}
/// Ends without a confirmed export: abort an in-flight session and take any
/// export this process committed out of the importable set.
fn abandon(app: &tauri::AppHandle) {
    let state = app.state::<desktop_migration_bridge::MigrationState>();
    state.retire_before_exit();
    if let Some(id) = state.committed() { let _ = desktop_migration::reject_export(&app.state::<ExportLock>().directory, &id); }
}
fn output(value: serde_json::Value) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}").and_then(|_| out.flush()).map_err(|_| "migration_parent_closed".into())
}
#[tauri::command]
fn migration_export_progress(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("migration_window_denied".into()); }
    output(serde_json::json!({"type":"progress"}))
}
#[tauri::command]
fn migration_export_finished(window: tauri::WebviewWindow, export_id: Option<String>, error: Option<String>) -> Result<(), String> {
    if window.label() != "main" { return Err("migration_window_denied".into()); }
    let app = window.app_handle();
    #[cfg(feature = "native-transport-audit")]
    {
        let root = std::path::PathBuf::from(std::env::var_os("TAROBOT_MIGRATION_AUDIT_ROOT").unwrap());
        #[cfg(target_os = "macos")]
        let bundle = objc2_foundation::NSBundle::mainBundle().bundleIdentifier().map(|id| id.to_string());
        #[cfg(not(target_os = "macos"))]
        let bundle: Option<String> = None;
        let debug = serde_json::json!({"url":window.url().ok().map(|url| url.to_string()), "configId":app.config().identifier, "bundleId":bundle, "appData":app.path().app_local_data_dir().ok()});
        let _ = std::fs::write(root.join("reader-context.json"), debug.to_string());
    }
    if app.state::<ExportLock>().finished.swap(true, Ordering::SeqCst) { return Err("migration_already_finished".into()); }
    let state = app.state::<desktop_migration_bridge::MigrationState>();
    state.retire_before_exit();
    // Only the export this process committed can be reported complete.
    let committed = state.committed();
    let success = error.is_none() && export_id.as_deref().is_some_and(desktop_migration::export_id_valid) && export_id == committed;
    if !success {
        if let Some(id) = committed { let _ = desktop_migration::reject_export(&app.state::<ExportLock>().directory, &id); }
    }
    let result = if success { output(serde_json::json!({"type":"complete", "exportId":export_id})) }
      else { output(serde_json::json!({"type":"failed", "error":code(error.as_deref().unwrap_or(if export_id.is_some() { "migration_commit_mismatch" } else { "migration_export_failed" }))})) };
    app.exit(if success && result.is_ok() {0} else {1}); result
}
fn start<E>(_: E) -> String { "migration_reader_start_failed".into() }
/// Sent once by Electron main right after spawning; later stdin bytes and EOF
/// keep their lifeline meaning. Unsigned and Windows builds ignore it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const START: &[u8] = br#"{"type":"start"}"#;
fn prepare(app: &mut tauri::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if objc2_foundation::NSBundle::mainBundle().bundleIdentifier().map(|id| id.to_string()).as_deref() != Some(&app.config().identifier) {
            return Err("migration_reader_identity_invalid".into());
        }
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    #[cfg(not(feature = "native-transport-audit"))]
    let directory = app.path().app_local_data_dir().map_err(start)?;
    #[cfg(feature = "native-transport-audit")]
    let directory = {
        let root = std::fs::canonicalize(std::env::var_os("TAROBOT_MIGRATION_AUDIT_ROOT").ok_or("migration_reader_start_failed")?).map_err(start)?;
        if !root.components().any(|p| p.as_os_str().to_string_lossy().ends_with(".noindex")) { return Err("migration_reader_start_failed".into()); }
        root.join("native-state")
    };
    std::fs::create_dir_all(directory.join("desktop-migration")).map_err(start)?;
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(directory.join("desktop-migration/.export.lock")).map_err(start)?;
    lock.try_lock_exclusive().map_err(|_| "migration_export_busy")?;
    // Before any WebView or storage access: no old App may be writing the profile.
    #[cfg(windows)]
    let source = windows_source_guard::acquire().map_err(str::to_owned)?;
    // Holding the lock (and with no old writer), every other partial is stale.
    desktop_migration::clean_stale_partials(&directory)?;
    app.manage(ExportLock { _file: lock, finished: AtomicBool::new(false), directory: directory.clone(), #[cfg(windows)] _source: source });
    #[cfg(feature = "native-transport-audit")]
    app.manage(desktop_migration_bridge::MigrationState::isolated(directory));
    #[cfg(not(feature = "native-transport-audit"))]
    { let _ = &directory; app.manage(desktop_migration_bridge::MigrationState::default()); }
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        // No input payload is accepted. EOF is the parent's lifeline.
        let mut byte = [0u8; 1];
        loop { match std::io::stdin().read(&mut byte) { Ok(0) | Err(_) => break, _ => {} } }
        if !handle.state::<ExportLock>().finished.swap(true, Ordering::SeqCst) {
            abandon(&handle);
            handle.exit(3);
        }
    });
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("TaroBot · 正在迁移桌面数据").inner_size(440.0, 200.0).resizable(false).build().map_err(|_| "migration_reader_window_failed")?;
    output(serde_json::json!({"type":"progress"}))
}
fn main() {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["--export-only"] { std::process::exit(2); }
    // Only the main executable of this App may start a certificate-signed
    // reader, and it must prove it still holds our stdin: an App that only
    // inherited pipes created by another process never writes this line.
    #[cfg(target_os = "macos")]
    {
        let verified = match macos_launch_guard::verify("Contents/MacOS/tarobot-migration-exporter") {
            Ok(macos_launch_guard::Launch::Verified { launcher, .. }) => macos_launch_guard::started_by(&launcher, START),
            Ok(macos_launch_guard::Launch::Unsigned) => true,
            Err(_) => false,
        };
        if !verified {
            let _ = output(serde_json::json!({"type":"failed","error":"migration_reader_launch_unverified"}));
            std::process::exit(1);
        }
    }
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![migration_export_progress, migration_export_finished,
            desktop_migration_bridge::desktop_migration_mode, desktop_migration_bridge::desktop_migration_begin,
            desktop_migration_bridge::desktop_migration_part, desktop_migration_bridge::desktop_migration_blob,
            desktop_migration_bridge::desktop_migration_commit, desktop_migration_bridge::desktop_migration_abort,
            desktop_migration_bridge::desktop_migration_status])
        // Tauri panics on a setup error; report a code to Electron and exit instead.
        .setup(|app| {
            if let Err(error) = prepare(app) {
                let _ = output(serde_json::json!({"type":"failed","error":code(&error)}));
                std::process::exit(1);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle();
                if !app.state::<ExportLock>().finished.swap(true, Ordering::SeqCst) {
                    abandon(app);
                    let _ = output(serde_json::json!({"type":"failed","error":"migration_cancelled"}));
                    app.exit(3);
                }
            }
        })
        .run(tauri::generate_context!("legacy/tauri.conf.json"));
    if result.is_err() { let _ = output(serde_json::json!({"type":"failed","error":"migration_reader_start_failed"})); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    #[test]
    fn limit_reasons_reach_the_parent_without_their_detail() {
        assert_eq!(super::code("migration_value_too_large:tarocub-host-1/messages"), "migration_value_too_large");
        assert_eq!(super::code("migration_value_too_large:73400320"), "migration_value_too_large");
        assert_eq!(super::code("migration_too_large"), "migration_too_large");
        assert_eq!(super::code("migration_blob_too_large"), "migration_blob_too_large");
        for opaque in ["", "TypeError: x", "Error", "migration value", "migration_ü"] { assert_eq!(super::code(opaque), "migration_export_failed", "{opaque}"); }
    }
}
