//! Opt-in real WebView + IPC acceptance harness. Never part of release builds.
#[path = "../src/transport/mod.rs"]
mod transport;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::Manager;

struct Fixture {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
    root: PathBuf,
}
impl Fixture {
    fn command(&mut self, command: &str) -> Result<String, String> {
        writeln!(self.child.stdin.as_mut().unwrap(), "{command}").map_err(|e| e.to_string())?;
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        Ok(line.trim().to_owned())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
struct Audit {
    fixture: Mutex<Fixture>,
    output: PathBuf,
}
#[tauri::command]
fn audit_progress(stage: String) {
    eprintln!("audit stage: {stage}");
}
#[tauri::command]
fn audit_approve(code: String, state: tauri::State<'_, Audit>) -> Result<(), String> {
    if code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid_test_code".into());
    }
    if state
        .fixture
        .lock()
        .unwrap()
        .command(&format!("approve:{code}"))?
        != "ok"
    {
        return Err("test_approval_failed".into());
    }
    Ok(())
}
#[tauri::command]
fn audit_report(
    mut result: serde_json::Value,
    app: tauri::AppHandle,
    state: tauri::State<'_, Audit>,
) -> Result<(), String> {
    let stats = state.fixture.lock().unwrap().command("stats")?;
    result["proxy"] = serde_json::from_str(&stats).map_err(|e| e.to_string())?;
    std::fs::write(&state.output, serde_json::to_vec_pretty(&result).unwrap())
        .map_err(|e| e.to_string())?;
    app.exit(
        if result["ok"] == true && result["proxy"]["sensitive"] == 0 {
            0
        } else {
            1
        },
    );
    Ok(())
}
fn main() {
    let output =
        PathBuf::from(std::env::var_os("TAROCUB_AUDIT_RESULT").expect("isolated output required"));
    let root = std::env::temp_dir().join(format!("native-webview-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new("node")
        .args(["--import", "tsx", "tests/helpers/native-tls-fixture.ts"])
        .arg(&root)
        .current_dir(&repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let reader = BufReader::new(child.stdout.take().unwrap());
    let mut fixture = Fixture {
        child,
        reader,
        root,
    };
    let mut line = String::new();
    fixture.reader.read_line(&mut line).unwrap();
    let mut info: serde_json::Value = serde_json::from_str(&line).expect("test peer startup");
    let production: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let policy: tauri::utils::config::BackgroundThrottlingPolicy =
        if std::env::var_os("TAROCUB_AUDIT_ALLOW_SUSPEND").is_some() {
            tauri::utils::config::BackgroundThrottlingPolicy::Suspend
        } else {
            serde_json::from_value(production["app"]["windows"][0]["backgroundThrottling"].clone())
                .unwrap()
        };
    info["backgroundPolicy"] = serde_json::to_value(&policy).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            std::fs::read(fixture.root.join("ca.der")).unwrap(),
        ))
        .unwrap();
    let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .unwrap();
    let transport =
        transport::Transport::with_network(transport::core::Network::with_verifier(verifier));
    let app = tauri::Builder::default()
        .manage(transport)
        .manage(Audit {
            fixture: Mutex::new(fixture),
            output,
        })
        .invoke_handler(tauri::generate_handler![
            audit_approve,
            audit_progress,
            audit_report,
            transport::net_document,
            transport::net_allocate,
            transport::net_cancel,
            transport::net_http_open,
            transport::net_http_read,
            transport::net_socket_open,
            transport::net_socket_send,
            transport::net_socket_ack,
            transport::net_socket_close
        ])
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                window.state::<transport::Transport>().reset(window.label());
            }
        })
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Isolated transport acceptance")
            .visible(false)
            .incognito(true)
            .background_throttling(policy)
            .initialization_script(format!("window.__TRANSPORT_FIXTURE__ = {};", info))
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!("audit/tauri.conf.json"))
        .expect("native audit startup");
    app.run(|_, _| {});
}
