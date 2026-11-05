#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod widget_sandbox;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use zeroize::Zeroizing;
mod transport;
mod optional_shortcut;
mod notifications;
mod device_actions;
mod device_keychain;
mod device_installation;
mod desktop_migration;
mod desktop_migration_bridge;
#[cfg(target_os = "macos")]
mod macos_update;
mod github_updates;
mod github_updates_policy;
mod desktop_host;
mod saved_file;
mod saved_file_quarantine;
mod screenshot;
mod window_activation;
mod navigation;
#[cfg(any(target_os = "windows", test))]
mod fresh_install;
use window_activation::show;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity { device_id: String, key_ref: String, public_key: String }

fn entry(device_id: &str) -> Result<keyring::Entry, String> {
    if !device_id.starts_with("device_") || device_id.len() > 80 || !device_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') { return Err("invalid_device_id".into()); }
    keyring::Entry::new("com.tarobot.client.device", device_id).map_err(|_| "system_keychain_unavailable".into())
}
fn installation(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    device_installation::identifier(&app.path().app_local_data_dir().map_err(|_| "device_storage_failed")?)
}
fn device_seed(app: &tauri::AppHandle, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let marker = installation(app)?;
    let saved = Zeroizing::new(entry(id)?.get_secret().map_err(|_| "device_key_unavailable")?);
    device_installation::seed(&marker, &saved)
}
#[tauri::command]
async fn device_create(app: tauri::AppHandle) -> Result<DeviceIdentity, String> {
    device_keychain::run(move || {
        let device_id = format!("device_{}", uuid::Uuid::new_v4().simple());
        let mut seed = Zeroizing::new([0u8; 32]); getrandom::fill(seed.as_mut()).map_err(|_| "secure_random_unavailable")?;
        let key = SigningKey::from_bytes(&seed);
        let saved = device_installation::bind(&installation(&app)?, seed.as_ref())?;
        entry(&device_id)?.set_secret(saved.as_slice()).map_err(|_| "system_keychain_write_failed")?;
        // RFC 8410 Ed25519 SubjectPublicKeyInfo; only this public value enters JS.
        let mut spki = vec![0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]; spki.extend(key.verifying_key().as_bytes());
        Ok(DeviceIdentity { key_ref: device_id.clone(), device_id, public_key: STANDARD.encode(spki) })
    }).await
}
#[tauri::command]
async fn device_sign(app: tauri::AppHandle, key_ref: String, device_id: String, nonce: String, client_nonce: String) -> Result<String, String> {
    if key_ref != device_id || nonce.len() > 256 || client_nonce.len() > 256 || nonce.is_empty() || client_nonce.is_empty() || nonce.contains('\0') || client_nonce.contains('\0') { return Err("invalid_challenge".into()); }
    device_keychain::run(move || {
        let secret = device_seed(&app, &key_ref)?;
        let seed: &[u8; 32] = secret.as_slice().try_into().map_err(|_| "device_key_invalid")?;
        let key = SigningKey::from_bytes(seed); let proof = format!("tarocub/device/v1\0{}\0{}\0{}", device_id, nonce, client_nonce);
        Ok(STANDARD.encode(key.sign(proof.as_bytes()).to_bytes()))
    }).await
}
#[tauri::command]
async fn device_forget(key_ref: String) -> Result<(), String> {
    device_keychain::run(move || {
        let _ = entry(&key_ref)?; // Preserve the device ID validation.
        device_keychain::delete_credential("com.tarobot.client.device", &key_ref).map_err(|_| "device_key_delete_failed".into())
    }).await
}
#[tauri::command]
async fn device_sign_action(app: tauri::AppHandle, key_ref: String, statement: device_actions::Statement) -> Result<String, String> {
    if key_ref != statement.device_id { return Err("invalid_device_id".into()); }
    statement.proof()?;
    device_keychain::run(move || {
        let secret = device_seed(&app, &key_ref)?;
        let seed: &[u8; 32] = secret.as_slice().try_into().map_err(|_| "device_key_invalid")?;
        device_actions::sign(&SigningKey::from_bytes(seed), &statement)
    }).await
}
#[tauri::command]
fn unread_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") { tray.set_tooltip(Some(if count == 0 { "TaroBird".into() } else { format!("TaroBird · {} unread", count) })).map_err(|_| "tray_update_failed")?; }
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") { window.set_badge_count(if count == 0 { None } else { Some(count as i64) }).map_err(|_| "badge_update_failed")?; }
    Ok(())
}
#[tauri::command]
fn update_info(app: tauri::AppHandle) -> serde_json::Value {
    let config = app.config(); let updater = config.plugins.0.get("updater");
    let configured = updater.and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()).is_some_and(|key| !key.trim().is_empty())
        && updater.and_then(|v| v.get("endpoints")).and_then(|v| v.as_array()).is_some_and(|urls| !urls.is_empty() && urls.iter().all(|v| v.as_str().is_some_and(|s| s.starts_with("https://"))));
    serde_json::json!({"configured": configured, "version": app.package_info().version.to_string()})
}
#[tauri::command]
fn restart_client(app: tauri::AppHandle) { app.restart(); }
fn main() {
    #[cfg(target_os = "windows")]
    if let Some(code) = fresh_install::installer_command() { std::process::exit(code); }
    #[cfg(target_os = "windows")]
    if let Some(code) = desktop_host::installer_command() { std::process::exit(code); }
    #[cfg(target_os = "windows")]
    if let Some(code) = notifications::windows_identity::installer_command() { std::process::exit(code); }
    // Register the system notification delegate before AppKit finishes launch,
    // including activation while the WebView has not installed its listeners.
    let notifications = notifications::initialize();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = {
        let inbox = notifications.clone();
        // First plugin: a second activation must reach the original native inbox
        // even before deep-link state or WebView listeners have been initialized.
        builder.plugin(tauri_plugin_single_instance::init(move |app, args, _| {
            inbox.activation_args(&args);
            let focus = app.clone();
            let _ = app.run_on_main_thread(move || show(&focus));
        }))
    };
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri::plugin::Builder::<tauri::Wry>::new("native-shell")
        .js_init_script(include_str!("native-shell.js").replace("__TAROBOT_VERSION__", env!("CARGO_PKG_VERSION")))
        .build());
    builder
        .register_uri_scheme_protocol("widget", |_context, request| widget_sandbox::response(request.uri().path()))
        .manage(notifications)
        .manage(desktop_migration_bridge::MigrationState::default())
        .manage(github_updates::GithubUpdateState::default())
        .manage(transport::Transport::new().expect("Native TLS initialization failed"))
        // Drop payloads must never navigate the App to a file or external site.
        // Frame previews and the configured development origin remain allowed.
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("file-navigation-guard")
            .on_navigation(|webview, url| navigation::allowed(url, if cfg!(debug_assertions) {
                webview.app_handle().config().build.dev_url.as_ref()
            } else { None }))
            .build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| { if event.state() == ShortcutState::Pressed { show(app); } }).build())
        .on_window_event(|window, event| { window_activation::on_window_event(window, event); match event {
            tauri::WindowEvent::Destroyed => window.state::<transport::Transport>().reset(window.label()),
            _ => {},
        } })
        .on_page_load(|window, payload| { if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            window.state::<transport::Transport>().reset(window.label());
            if window.label() == "main" {
                window.state::<std::sync::Arc<notifications::Notifications>>().new_document();
                window.state::<desktop_migration_bridge::MigrationState>().retire();
            }
        } })
        .invoke_handler(tauri::generate_handler![desktop_host::desktop_host, device_create, device_sign, device_sign_action, device_forget, unread_count, update_info, restart_client,
            desktop_migration_bridge::desktop_migration_mode,
            desktop_migration_bridge::desktop_migration_begin, desktop_migration_bridge::desktop_migration_part, desktop_migration_bridge::desktop_migration_blob,
            desktop_migration_bridge::desktop_migration_commit, desktop_migration_bridge::desktop_migration_abort, desktop_migration_bridge::desktop_migration_status,
            github_updates::github_update_info, github_updates::github_update_login_start,
            github_updates::github_update_login_poll, github_updates::github_update_login_cancel,
            github_updates::github_update_logout, github_updates::github_update_check,
            github_updates::github_update_install, github_updates::github_update_close,
            saved_file::quarantine_saved_file, saved_file::open_saved_file, saved_file::reveal_saved_file, screenshot::capture_screenshot,
            notifications::desktop_notifications_supported, notifications::desktop_notification_permission,
            notifications::desktop_notification_context,
            notifications::desktop_notification_show, notifications::desktop_notification_peek,
            notifications::desktop_notification_ack, notifications::desktop_notification_clear, notifications::desktop_notification_settings,
            transport::net_document, transport::net_allocate, transport::net_cancel, transport::net_http_open, transport::net_http_read,
            transport::net_socket_open, transport::net_socket_send, transport::net_socket_ack, transport::net_socket_close])
        .setup(|app| {
            // Visible even if a cached or failed WebView cannot render settings.
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&format!("TaroBird {}", app.package_info().version));
            }
            notifications::attach(app.handle());
            let open = MenuItem::with_id(app, "open", "打开 TaroBird", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main").menu(&menu).tooltip("TaroBird").on_menu_event(|app, event| match event.id.as_ref() { "open" => show(app), "quit" => app.exit(0), _ => {} });
            // A flat alpha mask lets AppKit match the other menu-bar symbols,
            // including white on dark/tinted bars and the highlighted menu state.
            #[cfg(target_os = "macos")]
            { tray = tray.icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-macos.png"))?).icon_as_template(true); }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;
            optional_shortcut::register(
                || app.global_shortcut().register("CommandOrControl+Shift+T"),
                |message| optional_shortcut::warn(std::io::stderr(), message),
            );
            Ok(())
        })
        .build(tauri::generate_context!()).expect("TaroBird desktop startup failed")
        .run(|app, event| window_activation::on_run_event(app, &event));
}
