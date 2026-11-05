#[path = "build/desktop_runtime.rs"]
mod desktop_runtime;

fn main() {
    if std::env::var_os("CARGO_FEATURE_DESKTOP_MIGRATION_EXPORTER").is_some() {
        println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
        let patch: serde_json::Value = std::env::var("TAURI_CONFIG").ok().and_then(|value| serde_json::from_str(&value).ok()).unwrap_or_default();
        let identifier = patch.get("identifier").and_then(|value| value.as_str()).unwrap_or("com.tarobot.client");
        assert!(identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'), "invalid migration reader identity");
        let version = std::env::var("CARGO_PKG_VERSION").unwrap();
        // A secondary executable is not NSBundle.mainBundle's declared main
        // executable. Embed its own identity so default WKWebsiteDataStore uses
        // the old App's domain. No nested App or LaunchServices registration.
        let plist = format!(r#"<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleName</key><string>TaroBot Migration</string><key>CFBundleExecutable</key><string>tarobot-migration-exporter</string><key>CFBundleVersion</key><string>{version}</string><key>LSUIElement</key><true/><key>NSQuitAlwaysKeepsWindows</key><false/></dict></plist>"#);
        std::fs::write(std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("migration-reader.plist"), plist).unwrap();
    }
    // Cargo watches directory contents recursively: replacing just an addon
    // must rerun validation even if its receipt and Node binary stayed intact.
    if std::env::var_os("CARGO_FEATURE_DESKTOP_MIGRATION_EXPORTER").is_none() {
        println!("cargo:rerun-if-changed=host");
        let target = std::env::var("TARGET").unwrap_or_default();
        desktop_runtime::validate(std::path::Path::new("host"), &target)
            .unwrap_or_else(|error| panic!("Invalid bundled desktop host: {error}. Run scripts/prepare-desktop-host.mjs for the build target before packaging."));
    }
    tauri_build::build()
}
