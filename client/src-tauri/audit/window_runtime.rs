//! macOS-only real Dock/Finder reopen regression. No production host or secrets.
#[path = "../src/window_activation.rs"]
mod window_activation;
use std::{
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
struct Audit {
    started: AtomicBool,
    fixed: AtomicBool,
    reopens: AtomicUsize,
    receipt: Mutex<Option<mpsc::Sender<serde_json::Value>>>,
}
fn wait(mut condition: impl FnMut() -> bool, label: &str) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if condition() { return Ok(()); }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err(format!("timeout: {label}"))
}
fn reopen(state: &Audit) -> Result<(), String> {
    let before = state.reopens.load(Ordering::SeqCst);
    let bundle = std::env::var_os("TAROBOT_WINDOW_AUDIT_BUNDLE").ok_or("isolated bundle required")?;
    let status = std::process::Command::new("/usr/bin/open").arg("-a").arg(bundle)
        .status().map_err(|e| e.to_string())?;
    if !status.success() { return Err("LaunchServices open failed".into()); }
    wait(|| state.reopens.load(Ordering::SeqCst) > before, "actual OS Reopen event")
}
fn restored(window: &tauri::WebviewWindow) -> Result<(), String> {
    wait(|| window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && window.is_focused().unwrap_or(false), "visible, unminimized and focused")
}
fn document(window: &tauri::WebviewWindow, state: &Audit, stage: &str) -> Result<serde_json::Value, String> {
    let (tx, rx) = mpsc::channel();
    *state.receipt.lock().unwrap() = Some(tx);
    window.eval(&format!("window.checkWindowDocument({})", serde_json::to_string(stage).unwrap()))
        .map_err(|e| e.to_string())?;
    let value = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "WebView did not respond")?;
    if value["stage"] != stage || value["draft"] != "unsent draft stays here" {
        return Err("draft or checkpoint lost".into());
    }
    Ok(value)
}
#[cfg(target_os = "macos")]
fn exercise(app: &tauri::AppHandle, state: &Audit) -> Result<serde_json::Value, String> {
    let window = app.get_webview_window("main").ok_or("missing main")?;
    let initial = document(&window, state, "initial")?;
    let mut checks = Vec::new();
    // Reproduce the pre-fix callback omission with a real OS event first.
    window.close().map_err(|e| e.to_string())?;
    wait(|| !window.is_visible().unwrap_or(true), "main close hides")?;
    reopen(state)?;
    std::thread::sleep(Duration::from_millis(350));
    if window.is_visible().unwrap_or(true) { return Err("baseline did not reproduce".into()); }
    state.fixed.store(true, Ordering::SeqCst);
    for cycle in 0..3 {
        for operation in ["close", "minimize", "hide-application"] {
            match operation {
                "close" => {
                    window.close().map_err(|e| e.to_string())?;
                    wait(|| !window.is_visible().unwrap_or(true), "close hides main")?;
                },
                "minimize" => {
                    window.minimize().map_err(|e| e.to_string())?;
                    wait(|| window.is_minimized().unwrap_or(false), "minimized")?;
                },
                _ => { app.hide().map_err(|e| e.to_string())?; std::thread::sleep(Duration::from_millis(200)); },
            }
            reopen(state)?;
            restored(&window)?;
            let receipt = document(&window, state, &format!("{operation}-{cycle}"))?;
            if receipt["token"] != initial["token"] { return Err("document reloaded".into()); }
            checks.push(receipt);
        }
    }
    // has_visible_windows may refer to an auxiliary window, not main.
    let auxiliary = tauri::WebviewWindowBuilder::new(app, "auxiliary", tauri::WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Auxiliary acceptance window").inner_size(260.0, 160.0).incognito(true)
        .build().map_err(|e| e.to_string())?;
    window.close().map_err(|e| e.to_string())?;
    wait(|| !window.is_visible().unwrap_or(true), "main hidden with auxiliary")?;
    reopen(state)?;
    restored(&window)?;
    let receipt = document(&window, state, "auxiliary-visible")?;
    if receipt["token"] != initial["token"] { return Err("document reloaded".into()); }
    checks.push(receipt);
    auxiliary.close().map_err(|e| e.to_string())?;
    wait(|| app.get_webview_window("auxiliary").is_none(), "auxiliary actually destroyed")?;
    // Tray/notification/shortcut entry shares show(), and also restores an
    // app-level hide without relying on a Dock event.
    app.hide().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(200));
    window_activation::show(app);
    restored(&window)?;
    let receipt = document(&window, state, "shared-show")?;
    if receipt["token"] != initial["token"] { return Err("document reloaded".into()); }
    checks.push(receipt);
    for (index, check) in checks.iter().enumerate() {
        if check["clicks"] != (index + 2) { return Err("interaction count lost".into()); }
    }
    Ok(serde_json::json!({"ok": true, "baseline_hidden_reproduced": true,
        "reopen_events": state.reopens.load(Ordering::SeqCst), "pid": std::process::id(), "checks": checks}))
}
#[tauri::command]
fn audit_document(receipt: serde_json::Value, state: tauri::State<'_, Arc<Audit>>) {
    if let Some(tx) = state.receipt.lock().unwrap().take() { let _ = tx.send(receipt); }
}
#[tauri::command]
fn audit_ready(app: tauri::AppHandle, state: tauri::State<'_, Arc<Audit>>) {
    if state.started.swap(true, Ordering::SeqCst) { return; }
    let state = state.inner().clone();
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        let result = exercise(&app, &state);
        #[cfg(not(target_os = "macos"))]
        let result: Result<serde_json::Value, String> = Err("macOS acceptance only".into());
        let receipt = result.unwrap_or_else(|error| serde_json::json!({"ok": false, "error": error}));
        let path = std::env::var_os("TAROBOT_WINDOW_AUDIT_RESULT").expect("isolated receipt path");
        std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        app.exit(if receipt["ok"] == true { 0 } else { 1 });
    });
}
fn main() {
    let audit = Arc::new(Audit::default());
    let events = audit.clone();
    tauri::Builder::default().manage(audit)
        .invoke_handler(tauri::generate_handler![audit_ready, audit_document])
        .on_window_event(window_activation::on_window_event)
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("TaroBot Window Acceptance").inner_size(620.0, 360.0).incognito(true).build()?;
            Ok(())
        })
        .build(tauri::generate_context!("audit/window/tauri.conf.json")).expect("isolated window audit")
        .run(move |app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) { events.reopens.fetch_add(1, Ordering::SeqCst); }
            if events.fixed.load(Ordering::SeqCst) { window_activation::on_run_event(app, &event); }
        });
}
