//! Manual native capture acceptance. No Hub, credentials, persistence or upload.
#[path = "../src/screenshot.rs"]
mod screenshot;
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![screenshot::capture_screenshot])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("TaroBot Screenshot Acceptance").inner_size(860.0, 620.0)
                .incognito(true).build()?;
            Ok(())
        })
        .run(tauri::generate_context!("audit/screenshot/tauri.conf.json"))
        .expect("screenshot audit startup");
}
