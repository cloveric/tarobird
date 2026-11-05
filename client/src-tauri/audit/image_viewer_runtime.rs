//! Isolated macOS/WebView image viewer acceptance. No Hub, credentials or user state.
use std::io::Write;
#[tauri::command]
fn audit_record(state: serde_json::Value) -> Result<(), String> {
    let path = std::env::var_os("TAROBOT_IMAGE_AUDIT_RESULT").ok_or("receipt path required")?;
    let mut output = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(output, "{}", state).map_err(|e| e.to_string())
}
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![audit_record])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("TaroBot Image Viewer Acceptance").inner_size(1000.0, 800.0).incognito(true).build()?;
            Ok(())
        })
        .run(tauri::generate_context!("audit/image-viewer/tauri.conf.json"))
        .expect("isolated image viewer acceptance");
}
