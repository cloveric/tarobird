//! Isolated real macOS updater acceptance. Only an external-volume copy of the
//! App and synthetic host state are touched. No Keychain, accounts or GUI data.
#[cfg(target_os = "macos")]
#[path = "../src/macos_update.rs"]
mod macos_update;

#[cfg(target_os = "macos")]
fn main() {
    use tauri_plugin_updater::UpdaterExt;
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("isolated lab path"));
    let root = root.canonicalize().expect("existing laboratory");
    assert!(root.starts_with("/Volumes/") && root.join("disposable-updater-lab").is_file());
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("audit.json")).unwrap()).unwrap();
    let endpoint = reqwest::Url::parse(settings["endpoint"].as_str().unwrap()).unwrap();
    assert_eq!(endpoint.scheme(), "http");
    assert_eq!(endpoint.host_str(), Some("127.0.0.1"));
    let public_key = settings["publicKey"].as_str().unwrap().to_string();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(public_key).build())
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = async {
                    let bundle = root.join("TaroBot.app");
                    let update = handle.updater_builder().executable_path(bundle.join("Contents/MacOS/tarocub-client"))
                        .endpoints(vec![endpoint]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?
                        .check().await.map_err(|e| e.to_string())?.ok_or("missing update")?;
                    let downloaded = update.download(|_, _| {}, || {}).await;
                    if settings["rejectSignature"] == true {
                        if !matches!(downloaded, Err(tauri_plugin_updater::Error::Minisign(_))) { return Err("tampered download was not rejected by signature verification".into()); }
                        return Ok::<_, String>(serde_json::json!({"signatureRejected":true}));
                    }
                    let bytes = downloaded.map_err(|e| e.to_string())?;
                    let mut backup = macos_update::AppBackup::at(&bundle).await?;
                    let pause = macos_update::HostPause::prepare_at(&bundle.join("Contents/Resources/host"), &root.join("state")).await?;
                    backup.begin()?;
                    if let Err(error) = update.install(bytes).map_err(|e| e.to_string()).and_then(|_| backup.validate(&update.version, "com.tarobot.client")) {
                        backup.restore()?; pause.finish().await?; return Err(error);
                    }
                    pause.finish().await?; backup.commit();
                    Ok(serde_json::json!({"nativeInstaller":true,"signedVersion":update.version,"hostResumed":true}))
                }.await;
                let value = match &result { Ok(value) => serde_json::json!({"passed":true,"result":value}), Err(error) => serde_json::json!({"passed":false,"error":error}) };
                std::fs::write(root.join("native-receipt.json"), serde_json::to_vec_pretty(&value).unwrap()).unwrap();
                handle.exit(if result.is_ok() {0} else {1});
            });
            Ok(())
        }).run(tauri::generate_context!("audit/macos_update/tauri.conf.json")).expect("isolated update acceptance");
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("This acceptance runs on native macOS only");
}
