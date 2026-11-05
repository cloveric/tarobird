//! Path-only macOS update primitives shared by the Tauri updater and the
//! Electron update helper. Callers resolve every path natively; none come from JS.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub struct HostPause {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
}
impl HostPause {
    pub async fn prepare_at(resources: &Path, directory: &Path) -> Result<Self, String> {
        let mut child = Command::new(resources.join("node"))
            .arg(resources.join("dist/src/index.js"))
            .arg("desktop-update")
            .arg(directory)
            .current_dir(&resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Dropping the GUI's pipe cancels waiting or resumes the stopped
            // Hub. Killing this recovery child on drop would strand the Hub.
            .kill_on_drop(false)
            .spawn()
            .map_err(|_| "github_update_host")?;
        let input = child.stdin.take();
        let output = BufReader::new(child.stdout.take().ok_or("github_update_host")?);
        let mut pause = Self {
            child,
            input,
            output,
        };
        // Includes up to 30s lock admission, 300s drain and two 15s stop waits.
        pause.phase("ready", Duration::from_secs(400)).await?;
        Ok(pause)
    }
    async fn phase(&mut self, expected: &str, timeout: Duration) -> Result<(), String> {
        let mut line = String::new();
        tokio::time::timeout(timeout, self.output.read_line(&mut line))
            .await
            .map_err(|_| "github_update_host")?
            .map_err(|_| "github_update_host")?;
        if line.len() > 1024
            || serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v.get("phase").and_then(|p| p.as_str()).map(str::to_owned))
                .as_deref()
                != Some(expected)
        {
            return Err("github_update_host".into());
        }
        Ok(())
    }
    pub async fn finish(mut self) -> Result<(), String> {
        let mut input = self.input.take().ok_or("github_update_host")?;
        input
            .write_all(b"{\"command\":\"finish\"}\n")
            .await
            .map_err(|_| "github_update_host")?;
        input.shutdown().await.map_err(|_| "github_update_host")?;
        drop(input);
        self.phase("complete", Duration::from_secs(90)).await?;
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| "github_update_host")?
            .map_err(|_| "github_update_host")?;
        if !status.success() {
            return Err("github_update_host".into());
        }
        Ok(())
    }
    /// The install path holds an unverified or missing bundle. A stopped Hub
    /// stays stopped instead of starting whatever runtime that path now holds;
    /// an older Host CLI treats the unknown line like EOF (previous behavior).
    #[allow(dead_code)] // Used by the Electron update helper, not the Tauri reader.
    pub async fn retain_stopped(mut self) {
        if let Some(mut input) = self.input.take() {
            let _ = input.write_all(b"{\"command\":\"retain-stopped\"}\n").await;
            let _ = input.shutdown().await;
        }
        let _ = self.phase("complete", Duration::from_secs(30)).await;
    }
}

/// Upstream's temporary backup is not a durable rollback on rename failure.
/// Keep our own same-volume backup until the install and bundle checks finish.
pub struct AppBackup {
    pub(crate) app: PathBuf,
    pub(crate) directory: PathBuf,
    saved: PathBuf,
    cleanup: bool,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedBackup {
    app: PathBuf,
    pid: u32,
}
fn clean_abandoned_preparations(bundle: &Path) {
    let Some(parent) = bundle.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|s| s.strip_prefix(".tarobot-update-"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let marker = entry.path().join("prepared.json");
        if !std::fs::symlink_metadata(&marker).is_ok_and(|m| m.is_file() && m.len() <= 4096) {
            continue;
        }
        let Some(prepared) = std::fs::read(&marker)
            .ok()
            .and_then(|b| serde_json::from_slice::<PreparedBackup>(&b).ok())
        else {
            continue;
        };
        if prepared.app != bundle || prepared.pid == 0 {
            continue;
        }
        // Preserve live/reused PIDs and any uncertain result. Unmarked folders
        // may be legacy or recovery backups and must never be swept.
        let dead = std::process::Command::new("/bin/ps")
            .args(["-p", &prepared.pid.to_string(), "-o", "pid="])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.code() == Some(1));
        if dead {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
impl AppBackup {
    pub async fn at(bundle: &Path) -> Result<Self, String> {
        use std::os::unix::fs::DirBuilderExt;
        let bundle = bundle.canonicalize().map_err(|_| "github_update_install")?;
        clean_abandoned_preparations(&bundle);
        let directory = bundle
            .parent()
            .ok_or("github_update_install")?
            .join(format!(".tarobot-update-{}", uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "github_update_permissions")?;
        let saved = directory.join("previous.app");
        let backup = Self {
            app: bundle.to_owned(),
            directory,
            saved,
            cleanup: true,
        };
        std::fs::write(
            backup.directory.join("prepared.json"),
            serde_json::to_vec(&PreparedBackup {
                app: backup.app.clone(),
                pid: std::process::id(),
            })
            .map_err(|_| "github_update_install")?,
        )
        .map_err(|_| "github_update_install")?;
        let status = Command::new("/usr/bin/ditto")
            .arg(&backup.app)
            .arg(&backup.saved)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status()
            .await
            .map_err(|_| "github_update_install")?;
        if !status.success() {
            return Err("github_update_install".into());
        }
        Ok(backup)
    }
    pub fn validate(&self, version: &str, identifier: &str) -> Result<(), String> {
        validate_bundle(&self.app, version, identifier)
    }
    pub fn restore(&mut self) -> Result<(), String> {
        let saved = self.saved.clone();
        self.restore_from(&saved)
    }
    /// Puts `source` (inside this backup directory) back at the install path.
    /// An exchange never leaves the install path empty; the failed bundle
    /// takes `source`'s place and is removed with the backup directory.
    pub fn restore_from(&mut self, source: &Path) -> Result<(), String> {
        if !source.starts_with(&self.directory) {
            return Err("github_update_recovery".into());
        }
        if self.app.exists() {
            match exchange(source, &self.app) {
                Ok(()) => {
                    self.cleanup = true;
                    return Ok(());
                }
                Err(error) if exchange_unsupported(&error) => {
                    std::fs::rename(&self.app, self.directory.join("failed.app"))
                        .map_err(|_| "github_update_recovery")?;
                }
                Err(_) => return Err("github_update_recovery".into()),
            }
        }
        std::fs::rename(source, &self.app).map_err(|_| "github_update_recovery")?;
        self.cleanup = true;
        Ok(())
    }
    pub fn begin(&mut self) -> Result<(), String> {
        // Make the recovery boundary durable before any bundle replacement.
        // A crash afterwards must not make this backup eligible for cleanup.
        std::fs::remove_file(self.directory.join("prepared.json"))
            .map_err(|_| "github_update_install")?;
        std::fs::File::open(&self.directory)
            .and_then(|f| f.sync_all())
            .map_err(|_| "github_update_install")?;
        self.cleanup = false;
        Ok(())
    }
    pub fn commit(&mut self) {
        self.cleanup = true;
    }
}
impl Drop for AppBackup {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

/// Exchanges two paths on one volume in a single step (`renamex_np` with
/// `RENAME_SWAP`): neither path is ever missing, even if this process dies.
pub fn exchange(a: &Path, b: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    extern "C" {
        fn renamex_np(from: *const std::os::raw::c_char, to: *const std::os::raw::c_char, flags: std::os::raw::c_uint) -> std::os::raw::c_int;
    }
    const RENAME_SWAP: std::os::raw::c_uint = 0x0000_0002;
    let path = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput));
    let (a, b) = (path(a)?, path(b)?);
    if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
/// Only recovery (`restore_from`) on a volume without exchange support keeps
/// the previous two-step rename; replacement fails closed instead. Any other
/// error left both paths unchanged.
pub fn exchange_unsupported(error: &std::io::Error) -> bool {
    const ENOTSUP: i32 = 45;
    const ENOSYS: i32 = 78;
    matches!(error.raw_os_error(), Some(ENOTSUP | ENOSYS))
}

/// Reads back the bundle that is (or is about to be) at the install path.
pub fn validate_bundle(app: &Path, version: &str, identifier: &str) -> Result<(), String> {
    let plist = app.join("Contents/Info.plist");
    for (key, expected) in [
        ("CFBundleShortVersionString", version),
        ("CFBundleIdentifier", identifier),
    ] {
        let output = std::process::Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", &format!("Print :{key}")])
            .arg(&plist)
            .output()
            .map_err(|_| "github_update_install")?;
        if !output.status.success()
            || String::from_utf8_lossy(&output.stdout).trim() != expected
        {
            return Err("github_update_install".into());
        }
    }
    let status = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "github_update_install")?;
    if !status.success() {
        return Err("github_update_signature".into());
    }
    Ok(())
}
