#[path = "../src/widget_sandbox.rs"] mod widget_sandbox;
use tauri::Manager;
use std::sync::atomic::{AtomicBool, Ordering};
static ESCAPED: AtomicBool = AtomicBool::new(false);
static FINISHED: AtomicBool = AtomicBool::new(false);
#[tauri::command] fn audit_escape() { ESCAPED.store(true, Ordering::SeqCst); }
#[tauri::command]
fn audit_finish(app: tauri::AppHandle, mut receipt: serde_json::Value) {
    if FINISHED.swap(true, Ordering::SeqCst) { return; }
    let escaped = ESCAPED.load(Ordering::SeqCst);
    let passed = !escaped && receipt["dataImageLoaded"] == true && receipt["parentBlocked"] == true && receipt["storageBlocked"] == true && receipt["clicked"] == true && receipt["nativeBlocked"] == true && receipt["workerNoDom"] == true && receipt["workerNoTransport"] == true && receipt["cpuRetired"] == true && receipt["parentResponsive"] == true;
    receipt["escaped"] = escaped.into(); receipt["passed"] = passed.into();
    receipt["surface"] = "isolated macOS Tauri WKWebView, production sandbox protocol".into();
    let path = std::env::var("TAROBOT_WIDGET_AUDIT_OUTPUT").expect("audit output required");
    std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    app.exit(if passed { 0 } else { 1 });
}
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            { app.set_activation_policy(tauri::ActivationPolicy::Regular); app.show()?; }
            let window = app.get_webview_window("main").expect("audit window");
            window.show()?; window.unminimize()?; window.center()?; window.set_focus()?;
            let app = app.handle().clone();
            let probe = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                #[cfg(target_os = "macos")]
                let _ = probe.show();
                if let Some(window) = probe.get_webview_window("main") {
                    let _ = window.show(); let _ = window.set_focus();
                    let _ = window.eval("if(document.visibilityState==='hidden')window.__TAURI__.core.invoke('audit_finish',{receipt:{error:'native_window_hidden',visibility:document.visibilityState}})");
                }
            });
            // Bound the native process even if a broken renderer cannot run
            // the JavaScript-side timeout or send its completion receipt.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(25));
                audit_finish(app, serde_json::json!({"error":"native audit watchdog timeout"}));
            });
            Ok(())
        })
        .register_uri_scheme_protocol("widget", |_context, request| widget_sandbox::response(request.uri().path()))
        .invoke_handler(tauri::generate_handler![audit_escape, audit_finish])
        .run(tauri::generate_context!("audit/widget/tauri.conf.json"))
        .expect("widget audit runtime");
}
