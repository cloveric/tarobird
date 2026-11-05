//! Disposable native geometry acceptance; no production Host or user state.
use std::io::Write;
#[tauri::command]
async fn audit_record(state: serde_json::Value) -> Result<(), String> {
    let path = std::env::var_os("TAROBOT_SIDE_WINDOW_AUDIT_RESULT").ok_or("receipt path required")?;
    let mut output = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(output, "{}", state).map_err(|e| e.to_string())
}
#[tauri::command]
async fn audit_normal(window: tauri::WebviewWindow) -> Result<(), String> { window.unmaximize().map_err(|e| e.to_string()) }
#[tauri::command]
async fn audit_maximize(window: tauri::WebviewWindow) -> Result<(), String> { window.maximize().map_err(|e| e.to_string()) }
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![audit_record, audit_normal, audit_maximize])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("TaroBot Side Window Acceptance").inner_size(1000.0, 700.0).incognito(true).build()?;
            Ok(())
        })
        .run(tauri::generate_context!("audit/side-window/tauri.conf.json"))
        .expect("isolated side window acceptance");
}
