//! Restore the existing desktop window without reloading its document or host.
use tauri::Manager;

pub fn show(app: &tauri::AppHandle) {
    let handle = app.clone();
    // Notifications and shortcuts can arrive off the UI thread. Keep the
    // application/window restoration in one ordered main-thread operation.
    if let Err(error) = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Err(error) = handle.show() {
            eprintln!("TaroBot application restore failed: {error}");
        }
        if let Some(window) = handle.get_webview_window("main") {
            for (operation, result) in [
                ("show", window.show()),
                ("unminimize", window.unminimize()),
                ("focus", window.set_focus()),
            ] {
                if let Err(error) = result {
                    eprintln!("TaroBot window {operation} failed: {error}");
                }
            }
        } else {
            eprintln!("TaroBot window restore failed: main window unavailable");
        }
    }) {
        eprintln!("TaroBot window activation dispatch failed: {error}");
    }
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" { return; }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // Closing the main window keeps its draft, connections and host alive.
        // Auxiliary windows retain their ordinary close/destroy lifecycle.
        api.prevent_close();
        if let Err(error) = window.hide() {
            eprintln!("TaroBot window hide failed: {error}");
        }
    }
}

pub fn on_run_event(_app: &tauri::AppHandle, _event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if matches!(_event, tauri::RunEvent::Reopen { .. }) {
        // Dock/Finder activation reaches this event even when another auxiliary
        // window is visible. Always restore main, not just has_visible_windows=false.
        show(_app);
    }
}
