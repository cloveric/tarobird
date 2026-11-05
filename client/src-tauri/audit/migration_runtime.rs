//! Real WKWebView + production export IPC. No Host or production vault access.
#[path = "../src/desktop_migration.rs"] mod desktop_migration;
#[path = "../src/desktop_migration_bridge.rs"] mod desktop_migration_bridge;
#[path = "../src/device_installation.rs"] mod device_installation;
use std::path::PathBuf;
use tauri::Manager;
struct Lab(PathBuf);
#[tauri::command]
fn audit_mode() -> bool { std::env::var("TAROBOT_MIGRATION_AUDIT_PERSIST").as_deref() == Ok("1") }
#[tauri::command]
fn audit_result(app: tauri::AppHandle, lab: tauri::State<'_, Lab>, value: serde_json::Value) -> Result<(), String> {
    let passed = value.get("passed").and_then(serde_json::Value::as_bool) == Some(true);
    std::fs::write(lab.0.join("tauri-export.json"), serde_json::to_vec_pretty(&value).map_err(|_| "audit_json")?).map_err(|_| "audit_receipt")?;
    app.exit(if passed { 0 } else { 1 }); Ok(())
}
fn main() {
    let root = std::fs::canonicalize(std::env::var_os("TAROBOT_MIGRATION_AUDIT_ROOT").expect("explicit lab required")).expect("existing lab");
    assert!(root.components().any(|part| part.as_os_str().to_string_lossy().ends_with(".noindex")), "physical noindex root required");
    assert!(!root.join("tauri-export.json").exists(), "fresh lab required");
    let state = root.join("native-state"); std::fs::create_dir(&state).expect("fresh native state");
    tauri::Builder::default()
        .manage(Lab(root)).manage(desktop_migration_bridge::MigrationState::isolated(state))
        .invoke_handler(tauri::generate_handler![audit_result, audit_mode,
            desktop_migration_bridge::desktop_migration_mode, desktop_migration_bridge::desktop_migration_begin,
            desktop_migration_bridge::desktop_migration_part, desktop_migration_bridge::desktop_migration_blob,
            desktop_migration_bridge::desktop_migration_commit, desktop_migration_bridge::desktop_migration_abort,
            desktop_migration_bridge::desktop_migration_status])
        .setup(|app| {
            let persistent = audit_mode();
            assert!(!persistent || app.config().identifier.starts_with("com.tarobot.migration.acceptance."), "persistent acceptance requires a unique test identity");
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("TaroBot Migration Acceptance").incognito(!persistent).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(60)); handle.exit(2); });
            Ok(())
        })
        .run(tauri::generate_context!("audit/migration/tauri.conf.json")).expect("migration acceptance");
}
