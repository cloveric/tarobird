//! Port of the Tauri `desktop_host` command (`src-tauri/src/desktop_host.rs`).
//! Paths, executable, entrypoint and environment come from startup
//! arguments; a request supplies only the action and the device payload.
use crate::identity::{spki, Identity};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::io::AsyncWriteExt;

#[path = "../../src-tauri/shared/native_identity.rs"]
pub mod native_identity;
#[path = "../../src-tauri/src/desktop_host_error.rs"]
mod diagnostics;
#[path = "../../src-tauri/src/desktop_host_node.rs"]
mod node_runtime;
// Only `package_family` is used here; the launcher uses the rest.
#[cfg(windows)]
#[allow(dead_code, unused_imports)]
#[path = "../../src-tauri/host-launcher/src/storage_probe.rs"]
mod storage_probe;

pub const ACTIONS: [&str; 7] = ["status", "start", "resume", "stop", "pair", "network", "tailscale"];

// Identical to the private functions of src-tauri/src/desktop_host.rs; the
// golden signature below pins byte compatibility with the Node verifier.
fn local_pair_payload(mut device: Value, secret: &[u8]) -> Result<Value, String> {
    let id = device.get("deviceId").and_then(Value::as_str).ok_or("invalid_device_id")?;
    if device.get("keyRef").and_then(Value::as_str) != Some(id) { return Err("invalid_device_id".into()); }
    let seed: &[u8; 32] = secret.try_into().map_err(|_| "device_key_invalid")?;
    if device.get("publicKey").and_then(Value::as_str) != Some(spki(&SigningKey::from_bytes(seed)).as_str()) {
        return Err("desktop_host_device_key_mismatch".into());
    }
    device.as_object_mut().ok_or("invalid_device_id")?.remove("keyRef");
    Ok(device)
}

// This domain is distinct from websocket/device-action proofs. Only this
// native path reads the fixed local runtime's nonce and signs with the vault.
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

pub struct DesktopHost {
    identity: Identity,
    /// Bundled runtime root: `node`/`node.exe` and `dist/src/index.js`.
    resources: PathBuf,
    /// App data root; the Host directory is resolved with native identity rules.
    app_data: PathBuf,
}
impl DesktopHost {
    pub fn new(identity: Identity, resources: PathBuf, app_data: PathBuf) -> Arc<Self> {
        Arc::new(Self { identity, resources, app_data })
    }

    pub async fn run(&self, action: &str, device: Option<Value>) -> Result<Value, String> {
        if !ACTIONS.contains(&action) {
            return Err("invalid_desktop_host_action".into());
        }
        #[cfg(windows)]
        match storage_probe::package_family(std::process::id()) {
            Ok(None) => {},
            Ok(Some(_)) if action == "status" || action == "resume" => return Ok(json!({"available":true,"running":false,"directoryState":"redirected"})),
            Ok(Some(_)) => return Err("desktop_host_operation_failed|reason=state_redirected".into()),
            Err(_) => return Err("desktop_host_operation_failed|reason=state_probe_failed".into()),
        }
        // Only an identity actually held in this app's credential store can
        // become the trusted local controller.
        let (mut device, native_secret, legacy_key) = if action == "pair" {
            let device = device.ok_or("invalid_device_id")?;
            let id = device.get("deviceId").and_then(Value::as_str).ok_or("invalid_device_id")?.to_owned();
            if device.get("keyRef").and_then(Value::as_str) != Some(id.as_str()) { return Err("invalid_device_id".into()); }
            let identity = self.identity.clone();
            let (payload, secret, legacy) = crate::identity::device_keychain::run(move || {
                // Only the trusted local-controller proof can migrate a legacy key.
                // Remote authentication never takes this path.
                let secret = identity.pair_secret(&id)?;
                let legacy = if secret.legacy { Some(id) } else { None };
                Ok((local_pair_payload(device, secret.seed.as_slice())?, secret.seed, legacy))
            }).await?;
            (Some(payload), Some(secret), legacy)
        } else { (device, None, None) };
        let resources = self.resources.clone();
        let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
        let entry = resources.join("dist/src/index.js");
        if !node.is_file() || !entry.is_file() {
            if action == "status" || action == "resume" { return Ok(json!({"available": false, "running": false})); }
            return Err("desktop_host_runtime_missing".into());
        }
        let directory = native_identity::for_app_data(&self.app_data)
            .map_err(|code| format!("desktop_host_operation_failed|reason=state_{}", code.strip_prefix("host_directory_").unwrap_or("probe_failed")))?;
        let path = host_path(&resources)?;
        if let Some(secret) = native_secret.as_ref() {
            let response = run_host_command(&node, &entry, &directory, &resources, &path, "pair-challenge", device.as_ref()).await?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "system_clock_invalid")?.as_millis() as u64;
            device = Some(sign_local_pair(device.ok_or("invalid_device_id")?, secret.as_slice(), response, now)?);
        }
        let response = run_host_command(&node, &entry, &directory, &resources, &path, action, device.as_ref()).await?;
        if let (Some(id), Some(secret)) = (legacy_key, native_secret) {
            // Commit only after the local Host has accepted its native challenge.
            let identity = self.identity.clone();
            crate::identity::device_keychain::run(move || identity.bind_legacy(&id, &secret)).await?;
        }
        Ok(response)
    }
}

/// Same search path as Tauri: bundled runtime first, then user CLI locations,
/// then the inherited PATH.
fn host_path(resources: &Path) -> Result<std::ffi::OsString, String> {
    let home = std::env::home_dir().ok_or("host_directory_unavailable")?;
    let mut paths: Vec<PathBuf> = vec![resources.to_path_buf(), home.join(".local/bin"), home.join(".npm-global/bin"), home.join(".kimi-code/bin")];
    #[cfg(target_os = "windows")]
    {
        if let Some(roaming) = std::env::var_os("APPDATA") { paths.push(PathBuf::from(roaming).join("npm")); }
        paths.push(home.join(".cargo/bin"));
        paths.push(home.join("scoop/shims"));
    }
    #[cfg(not(target_os = "windows"))]
    paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    if let Some(current) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&current)); }
    std::env::join_paths(paths).map_err(|_| "host_path_unavailable".into())
}

async fn run_host_command(node: &Path, entry: &Path, directory: &Path, resources: &Path, path: &std::ffi::OsStr, action: &str, device: Option<&Value>) -> Result<Value, String> {
    let mut command = tokio::process::Command::from(node_runtime::command(node, entry));
    command.arg("desktop-host").arg(action).arg(directory)
        .current_dir(resources).env("PATH", path)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| diagnostics::io_error("desktop_host_launch_failed", &error))?;
    // stdin gates the control operation. Assign ownership before releasing it;
    // the Host subsequently launched by Node remains detached from this job.
    #[cfg(windows)]
    let _control_job = crate::control_job::ControlJob::assign(child.raw_handle().ok_or("desktop_host_process_missing")?)
        .map_err(|error| diagnostics::io_error("desktop_host_ownership_failed", &error))?;
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
    use crate::identity::{device_installation, memory::MemoryVault, Vault};

    fn identity_json(seed: &[u8; 32]) -> Value {
        json!({"deviceId":"device_local","keyRef":"device_local","publicKey":spki(&SigningKey::from_bytes(seed)),"name":"My computer","platform":"macos"})
    }

    // Ported verbatim from src-tauri/src/desktop_host.rs (same golden signature).
    #[test]
    fn native_controller_proof_matches_node_and_rejects_substituted_challenges() {
        let seed = [7u8; 32];
        let device = local_pair_payload(identity_json(&seed), &seed).unwrap();
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
        let payload = local_pair_payload(identity_json(&seed), &seed).unwrap();
        assert!(payload.get("keyRef").is_none());
        assert_eq!(payload["deviceId"], "device_local");
        assert_eq!(local_pair_payload(identity_json(&seed), &[8u8; 32]).unwrap_err(), "desktop_host_device_key_mismatch");
        let mut spoofed = identity_json(&seed); spoofed["keyRef"] = json!("device_remote");
        assert_eq!(local_pair_payload(spoofed, &seed).unwrap_err(), "invalid_device_id");
        let mut missing = identity_json(&seed); missing.as_object_mut().unwrap().remove("keyRef");
        assert_eq!(local_pair_payload(missing, &seed).unwrap_err(), "invalid_device_id");
        assert_eq!(local_pair_payload(identity_json(&seed), &[7u8; 31]).unwrap_err(), "device_key_invalid");
    }

    // ---- Fake runtime: the real `node` executes a lab-only entrypoint. ----
    struct Lab { root: PathBuf, resources: PathBuf, app_data: PathBuf, state: PathBuf }
    impl Lab {
        fn new(fake_host: &str) -> Self {
            let root = std::env::temp_dir().join(format!("desktop-host-{}", uuid::Uuid::new_v4().simple()));
            let resources = root.join("resources/host");
            std::fs::create_dir_all(resources.join("dist/src")).unwrap();
            let node = std::env::var_os("TAROBOT_TEST_NODE").map(PathBuf::from).unwrap_or_else(|| {
                let out = std::process::Command::new("/bin/sh").args(["-c", "command -v node"]).output().unwrap();
                PathBuf::from(String::from_utf8(out.stdout).unwrap().trim())
            });
            assert!(node.is_file(), "a Node executable is required for the desktop_host lab (set TAROBOT_TEST_NODE)");
            #[cfg(unix)] std::os::unix::fs::symlink(&node, resources.join("node")).unwrap();
            std::fs::write(resources.join("dist/src/index.js"), fake_host).unwrap();
            let app_data = root.join("data/com.tarobot.client");
            let state = root.join("state");
            Self { root, resources, app_data, state }
        }
        fn host(&self, vault: Arc<MemoryVault>) -> Arc<DesktopHost> {
            DesktopHost::new(Identity::new(vault, self.state.clone()), self.resources.clone(), self.app_data.clone())
        }
    }
    impl Drop for Lab { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

    /// Echoes what the native side passed; implements the pair challenge and
    /// verifies the native proof with Node's own Ed25519 implementation.
    const FAKE_HOST: &str = r#"
const crypto = require('node:crypto');
const [command, action, directory] = process.argv.slice(2);
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const device = JSON.parse(input);
  const base = { running: true, publicKey: 'HUBKEY', command, action, directory, cwd: process.cwd(),
    path: process.env.PATH, nodeOptions: process.env.NODE_OPTIONS ?? null, nodePath: process.env.NODE_PATH ?? null, device };
  if (action === 'fail') { process.stderr.write('TAROBOT_STARTUP_V1|phase=desktop_command|error=HOST_DIRECTORY_CONFLICT|kind=Error\nprivate /Users/secret\n'); process.exit(78); }
  if (action === 'pair-challenge') {
    const nonce = crypto.randomBytes(32).toString('base64url');
    console.log(JSON.stringify({ ...base, desktopControllerChallenge: { v: 1, hubPublicKey: 'HUBKEY', deviceId: device.deviceId, publicKey: device.publicKey, nonce, expiresAt: Date.now() + 30000 } }));
    return;
  }
  if (action === 'pair') {
    const c = device.nativeProof.challenge;
    const proof = ['tarocub/desktop-controller/v1', c.hubPublicKey, c.deviceId, c.publicKey, c.nonce, c.expiresAt].join('\0');
    const key = crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' });
    const verified = crypto.verify(null, Buffer.from(proof), key, Buffer.from(device.nativeProof.signature, 'base64'));
    if (!verified) { process.stderr.write('desktop_controller_proof_invalid'); process.exit(1); }
  }
  console.log(JSON.stringify(base));
});
"#;

    fn seed_device(lab: &Lab, vault: &MemoryVault, seed: [u8; 32], legacy: bool) -> Value {
        let saved = if legacy { seed.to_vec() } else {
            device_installation::bind(&device_installation::identifier(&lab.state).unwrap(), &seed).unwrap().to_vec()
        };
        vault.set("device_local", &saved).unwrap();
        identity_json(&seed)
    }

    #[tokio::test]
    async fn status_uses_the_fixed_runtime_directory_path_and_clean_node_environment() {
        let lab = Lab::new(FAKE_HOST);
        let host = lab.host(Arc::new(MemoryVault::default()));
        let result = host.run("status", None).await.unwrap();
        assert_eq!(result["command"], "desktop-host");
        assert_eq!(result["action"], "status");
        // No legacy or current Host yet: a new install uses the new identity.
        assert_eq!(PathBuf::from(result["directory"].as_str().unwrap()), lab.root.join("data/com.tarobot.client/host"));
        assert_eq!(std::fs::canonicalize(result["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&lab.resources).unwrap());
        let path = result["path"].as_str().unwrap();
        assert!(path.starts_with(lab.resources.to_str().unwrap()), "bundled runtime must lead PATH: {path}");
        assert!(path.contains("/.local/bin") && path.contains("/opt/homebrew/bin"));
        assert_eq!(result["device"], Value::Null);
        assert_eq!((result["nodeOptions"].clone(), result["nodePath"].clone()), (Value::Null, Value::Null));
        assert_eq!(host.run("shell", None).await.unwrap_err(), "invalid_desktop_host_action");
        assert_eq!(host.run("fail", None).await.unwrap_err(), "invalid_desktop_host_action");
    }

    #[tokio::test]
    async fn existing_legacy_host_is_kept_and_a_conflict_fails_closed_before_launch() {
        let lab = Lab::new(FAKE_HOST);
        let legacy = lab.root.join("data/com.tarocub.client/host");
        std::fs::create_dir_all(&legacy).unwrap();
        let host = lab.host(Arc::new(MemoryVault::default()));
        let result = host.run("resume", None).await.unwrap();
        assert_eq!(PathBuf::from(result["directory"].as_str().unwrap()), legacy);
        std::fs::create_dir_all(lab.app_data.join("host")).unwrap();
        assert_eq!(host.run("start", None).await.unwrap_err(), "desktop_host_operation_failed|reason=state_conflict");
    }

    #[tokio::test]
    async fn missing_runtime_reports_unavailable_for_status_and_fails_for_control() {
        let lab = Lab::new(FAKE_HOST);
        std::fs::remove_file(lab.resources.join("dist/src/index.js")).unwrap();
        let host = lab.host(Arc::new(MemoryVault::default()));
        assert_eq!(host.run("status", None).await.unwrap(), json!({"available": false, "running": false}));
        assert_eq!(host.run("resume", None).await.unwrap(), json!({"available": false, "running": false}));
        assert_eq!(host.run("start", None).await.unwrap_err(), "desktop_host_runtime_missing");
    }

    #[tokio::test]
    async fn pair_signs_the_local_challenge_with_the_vault_key_and_migrates_legacy_only_after_acceptance() {
        for legacy in [false, true] {
            let lab = Lab::new(FAKE_HOST);
            let vault = Arc::new(MemoryVault::default());
            let device = seed_device(&lab, &vault, [5u8; 32], legacy);
            let host = lab.host(vault.clone());
            let result = host.run("pair", Some(device)).await.unwrap();
            assert_eq!(result["action"], "pair");
            assert!(result["device"].get("keyRef").is_none());
            assert_eq!(result["device"]["nativeProof"]["challenge"]["deviceId"], "device_local");
            assert_eq!(vault.0.lock().unwrap()["device_local"].len(), 68, "legacy={legacy}: key must be installation-bound afterwards");
        }
    }

    #[tokio::test]
    async fn pair_rejects_foreign_or_mismatched_keys_and_keeps_legacy_keys_on_failure() {
        let lab = Lab::new(&FAKE_HOST.replace("if (action === 'pair') {", "if (action === 'pair') { process.stderr.write('desktop_controller_proof_invalid'); process.exit(1);"));
        let vault = Arc::new(MemoryVault::default());
        let device = seed_device(&lab, &vault, [5u8; 32], true);
        let host = lab.host(vault.clone());
        assert_eq!(host.run("pair", Some(device.clone())).await.unwrap_err(), "desktop_host_operation_failed|exit=1|reason=controller_proof_rejected");
        assert_eq!(vault.0.lock().unwrap()["device_local"].len(), 32, "a rejected proof must not migrate the legacy key");
        let mut spoofed = device.clone(); spoofed["keyRef"] = json!("device_other");
        assert_eq!(host.run("pair", Some(spoofed)).await.unwrap_err(), "invalid_device_id");
        let mut other_key = device.clone(); other_key["publicKey"] = json!(spki(&SigningKey::from_bytes(&[6u8; 32])));
        assert_eq!(host.run("pair", Some(other_key)).await.unwrap_err(), "desktop_host_device_key_mismatch");
        assert_eq!(host.run("pair", None).await.unwrap_err(), "invalid_device_id");
        let mut unknown = device; unknown["deviceId"] = json!("device_unknown"); unknown["keyRef"] = json!("device_unknown");
        assert_eq!(host.run("pair", Some(unknown)).await.unwrap_err(), "device_key_unavailable");
    }

    #[tokio::test]
    async fn host_failures_export_only_classified_codes() {
        let lab = Lab::new(&FAKE_HOST.replace("action === 'fail'", "action === 'stop'"));
        let host = lab.host(Arc::new(MemoryVault::default()));
        let error = host.run("stop", None).await.unwrap_err();
        assert_eq!(error, "desktop_host_operation_failed|exit=78|reason=state_conflict|error=HOST_DIRECTORY_CONFLICT|phase=desktop_command|kind=Error");
        assert!(!error.contains("secret"));
        let lab = Lab::new("process.stdout.write('not json')");
        assert_eq!(lab.host(Arc::new(MemoryVault::default())).run("status", None).await.unwrap_err(), "desktop_host_invalid_response");
    }
}
