#[path = "../shared/native_identity.rs"]
mod native_identity;
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use zeroize::Zeroizing;
#[path = "desktop_host_error.rs"]
mod diagnostics;
#[path = "desktop_host_node.rs"]
mod node_runtime;
#[cfg(windows)]
#[path = "../host-launcher/src/storage_probe.rs"]
mod storage_probe;

fn local_pair_payload(mut device: Value, secret: &[u8]) -> Result<Value, String> {
    let id = device.get("deviceId").and_then(Value::as_str).ok_or("invalid_device_id")?;
    if device.get("keyRef").and_then(Value::as_str) != Some(id) { return Err("invalid_device_id".into()); }
    let seed: &[u8; 32] = secret.try_into().map_err(|_| "device_key_invalid")?;
    let key = SigningKey::from_bytes(seed);
    let mut spki = vec![0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00];
    spki.extend(key.verifying_key().as_bytes());
    if device.get("publicKey").and_then(Value::as_str) != Some(STANDARD.encode(spki).as_str()) {
        return Err("desktop_host_device_key_mismatch".into());
    }
    device.as_object_mut().ok_or("invalid_device_id")?.remove("keyRef");
    Ok(device)
}

// This domain is distinct from websocket/device-action proofs. Only this
// native path reads the fixed local runtime's nonce and signs with Keychain.
fn sign_local_pair(mut device: Value, secret: &[u8], response: Value, now: u64) -> Result<Value, String> {
    let challenge = response.get("desktopControllerChallenge").ok_or("desktop_controller_challenge_unavailable")?;
    let field = |name: &str| challenge.get(name).and_then(Value::as_str).ok_or("desktop_controller_challenge_invalid");
    let hub = field("hubPublicKey")?;
    let id = field("deviceId")?;
    let public_key = field("publicKey")?;
    let nonce = field("nonce")?;
    let expires = challenge.get("expiresAt").and_then(Value::as_u64).ok_or("desktop_controller_challenge_invalid")?;
    if response.get("running").and_then(Value::as_bool) != Some(true)
        || response.get("controlError").is_some()
        || challenge.get("v").and_then(Value::as_u64) != Some(1)
        || response.get("publicKey").and_then(Value::as_str) != Some(hub)
        || device.get("deviceId").and_then(Value::as_str) != Some(id)
        || device.get("publicKey").and_then(Value::as_str) != Some(public_key)
        || [hub, id, public_key, nonce].iter().any(|field| field.contains('\0'))
        || nonce.len() != 43 || !nonce.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || expires <= now || expires > now.saturating_add(60_000) {
        return Err("desktop_controller_challenge_invalid".into());
    }
    let seed: &[u8; 32] = secret.try_into().map_err(|_| "device_key_invalid")?;
    let proof = format!("tarocub/desktop-controller/v1\0{}\0{}\0{}\0{}\0{}", hub, id, public_key, nonce, expires);
    let signature = STANDARD.encode(SigningKey::from_bytes(seed).sign(proof.as_bytes()).to_bytes());
    device.as_object_mut().ok_or("invalid_device_id")?.insert("nativeProof".into(), json!({ "challenge": challenge, "signature": signature }));
    Ok(device)
}

// Paths and operations are native-owned. The WebView cannot choose an
// executable, state directory, environment, shell command or remote approval.
#[tauri::command]
pub async fn desktop_host(app: tauri::AppHandle, action: String, device: Option<Value>) -> Result<Value, String> {
    if !["status", "start", "resume", "stop", "pair", "network", "tailscale"].contains(&action.as_str()) {
        return Err("invalid_desktop_host_action".into());
    }
    #[cfg(windows)]
    match storage_probe::package_family(std::process::id()) {
        Ok(None) => {},
        Ok(Some(_)) if action == "status" || action == "resume" => return Ok(json!({"available":true,"running":false,"directoryState":"redirected"})),
        Ok(Some(_)) => return Err("desktop_host_operation_failed|reason=state_redirected".into()),
        Err(_) => return Err("desktop_host_operation_failed|reason=state_probe_failed".into()),
    }
    // Only an identity actually held in this app's OS credential store can
    // become the trusted local controller. Renderer-supplied platform/name or
    // an arbitrary public key are not proof of local ownership.
    let (mut device, native_secret, legacy_key) = if action == "pair" {
        let device = device.ok_or("invalid_device_id")?;
        let id = device.get("deviceId").and_then(Value::as_str).ok_or("invalid_device_id")?.to_owned();
        if device.get("keyRef").and_then(Value::as_str) != Some(id.as_str()) { return Err("invalid_device_id".into()); }
        let owner = app.clone();
        let (payload, secret, legacy) = crate::device_keychain::run(move || {
            let saved = Zeroizing::new(crate::entry(&id)?.get_secret().map_err(|_| "device_key_unavailable")?);
            // Only the trusted local-controller proof can migrate a legacy key.
            // Remote authentication never takes this path. Bound keys from a
            // different installation are rejected, including here.
            let legacy = saved.len() == 32;
            let secret = if legacy { saved } else { crate::device_installation::seed(&crate::installation(&owner)?, &saved)? };
            Ok((local_pair_payload(device, secret.as_slice())?, secret, if legacy { Some(id) } else { None }))
        }).await?;
        (Some(payload), Some(secret), legacy)
    } else { (device, None, None) };
    let resources = app.path().resource_dir().map_err(|_| "host_resources_unavailable")?.join("host");
    let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
    let entry = resources.join("dist/src/index.js");
    if !node.is_file() || !entry.is_file() {
        if action == "status" || action == "resume" { return Ok(json!({"available": false, "running": false})); }
        return Err("desktop_host_runtime_missing".into());
    }
    let directory = native_identity::for_app_data(&app.path().app_data_dir().map_err(|_| "host_directory_unavailable")?)
        .map_err(|code| format!("desktop_host_operation_failed|reason=state_{}", code.strip_prefix("host_directory_").unwrap_or("probe_failed")))?;
    let home = app.path().home_dir().map_err(|_| "host_directory_unavailable")?;
    let mut paths: Vec<PathBuf> = vec![resources.clone(), home.join(".local/bin"), home.join(".npm-global/bin"), home.join(".kimi-code/bin")];
    #[cfg(target_os = "windows")]
    {
        if let Some(roaming) = std::env::var_os("APPDATA") { paths.push(PathBuf::from(roaming).join("npm")); }
        paths.push(home.join(".cargo/bin"));
        paths.push(home.join("scoop/shims"));
    }
    #[cfg(not(target_os = "windows"))]
    paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    if let Some(current) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&current)); }
    let path = std::env::join_paths(paths).map_err(|_| "host_path_unavailable")?;
    if let Some(secret) = native_secret.as_ref() {
        let response = run_host_command(&node, &entry, &directory, &resources, &path, "pair-challenge", device.as_ref()).await?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "system_clock_invalid")?.as_millis() as u64;
        device = Some(sign_local_pair(device.ok_or("invalid_device_id")?, secret.as_slice(), response, now)?);
    }
    let response = run_host_command(&node, &entry, &directory, &resources, &path, &action, device.as_ref()).await?;
    if let (Some(id), Some(secret)) = (legacy_key, native_secret) {
        // Commit only after the local Host has accepted its native challenge.
        crate::device_keychain::run(move || {
            let saved = crate::device_installation::bind(&crate::installation(&app)?, &secret)?;
            crate::entry(&id)?.set_secret(saved.as_slice()).map_err(|_| "system_keychain_write_failed".to_owned())
        }).await?;
    }
    Ok(response)
}

async fn run_host_command(node: &Path, entry: &Path, directory: &Path, resources: &Path, path: &std::ffi::OsStr, action: &str, device: Option<&Value>) -> Result<Value, String> {
    let mut command = tokio::process::Command::from(node_runtime::command(node, entry));
    command.arg("desktop-host").arg(action).arg(directory)
        .current_dir(&resources).env("PATH", path)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| diagnostics::io_error("desktop_host_launch_failed", &error))?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(device.unwrap_or(&Value::Null).to_string().as_bytes()).await.map_err(|error| diagnostics::io_error("desktop_host_input_failed", &error))?;
        input.shutdown().await.map_err(|error| diagnostics::io_error("desktop_host_input_failed", &error))?;
    }
    let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output()).await
        .map_err(|_| "desktop_host_timeout")?.map_err(|error| diagnostics::io_error("desktop_host_launch_failed", &error))?;
    if !output.status.success() { return Err(diagnostics::operation_error(output.status.code(), &output.stderr)); }
    if output.stdout.len() > 65536 { return Err("desktop_host_invalid_response".into()); }
    serde_json::from_slice(&output.stdout).map_err(|_| "desktop_host_invalid_response".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(seed: &[u8; 32]) -> Value {
        let mut spki = vec![0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00];
        spki.extend(SigningKey::from_bytes(seed).verifying_key().as_bytes());
        json!({"deviceId":"device_local","keyRef":"device_local","publicKey":STANDARD.encode(spki),"name":"My computer","platform":"macos"})
    }

    #[test]
    fn native_controller_proof_matches_node_and_rejects_substituted_challenges() {
        let seed = [7u8; 32];
        let device = local_pair_payload(identity(&seed), &seed).unwrap();
        let response = json!({ "running": true, "publicKey": device["publicKey"], "desktopControllerChallenge": {
            "v": 1, "hubPublicKey": device["publicKey"], "deviceId": "device_local", "publicKey": device["publicKey"],
            "nonce": "A".repeat(43), "expiresAt": 100030000u64
        }});
        let payload = sign_local_pair(device.clone(), &seed, response.clone(), 100000000).unwrap();
        assert_eq!(payload["nativeProof"]["signature"], "k0hEa2spFDSsQXsvx5GTQcV0PV3B812l7OjV85newbDIO+I9z/3YVWWdyvGVfWV8RGQL5ZamstRMFGnjk+fNBg==");
        for field in ["hubPublicKey", "deviceId", "publicKey", "nonce"] {
            let mut changed = response.clone(); changed["desktopControllerChallenge"][field] = json!("other");
            assert!(sign_local_pair(device.clone(), &seed, changed, 100000000).is_err());
        }
        assert!(sign_local_pair(device.clone(), &seed, response.clone(), 100030000).is_err());
        assert!(sign_local_pair(device.clone(), &seed, response.clone(), 90000000).is_err());
        let mut failed = response.clone(); failed["controlError"] = json!("denied");
        assert!(sign_local_pair(device, &seed, failed, 100000000).is_err());
    }

    #[test]
    fn local_controller_requires_the_exact_native_identity() {
        let seed = [7u8; 32];
        let payload = local_pair_payload(identity(&seed), &seed).unwrap();
        assert!(payload.get("keyRef").is_none());
        assert_eq!(payload["deviceId"], "device_local");
        assert_eq!(local_pair_payload(identity(&seed), &[8u8; 32]).unwrap_err(), "desktop_host_device_key_mismatch");
        let mut spoofed = identity(&seed); spoofed["keyRef"] = json!("device_remote");
        assert_eq!(local_pair_payload(spoofed, &seed).unwrap_err(), "invalid_device_id");
        let mut missing = identity(&seed); missing.as_object_mut().unwrap().remove("keyRef");
        assert_eq!(local_pair_payload(missing, &seed).unwrap_err(), "invalid_device_id");
        assert_eq!(local_pair_payload(identity(&seed), &[7u8; 31]).unwrap_err(), "device_key_invalid");
    }
}

/// Installer-only entry, before WebView/single-instance initialization. Paths
/// come from this executable and the OS account; no JS/installer path argument.
/// Stop only an App-owned runtime; frozen CLI services keep running independently.
#[cfg(target_os = "windows")]
pub fn installer_command() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != "--stop-desktop-host") { return None; }
    Some((|| -> Result<i32, ()> {
        if args.len() != 2 { return Err(()); }
        let executable = std::env::current_exe().map_err(|_| ())?;
        let resources = executable.parent().ok_or(())?.join("host");
        if !resources.join("node.exe").is_file() { return Ok(0); }
        let directory = native_identity::host_directory(&dirs::data_dir().ok_or(())?).map_err(|_| ())?;
        let mut child = node_runtime::command(&resources.join("node.exe"), &resources.join("dist/src/index.js"))
            .args(["hub", "service", "installer-stop", "--state-dir"]).arg(directory)
            .current_dir(&resources)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|_| ())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        loop {
            if let Some(status) = child.try_wait().map_err(|_| ())? {
                // A damaged Node/module graph must not prevent uninstalling an
                // already stopped App. Native ownership checks still fail
                // closed for a running host, installed CLI or unreadable state.
                return Ok(if status.success() || crate::fresh_install::confirm_stopped() { 0 } else { 1 });
            }
            if std::time::Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(()); }
            std::thread::sleep(Duration::from_millis(50));
        }
    })().unwrap_or(1))
}
