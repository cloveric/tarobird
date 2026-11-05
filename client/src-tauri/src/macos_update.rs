//! Mac updates keep the App-owned Hub paused across bundle replacement.
//! Native paths only; no executable, archive URL, or state path comes from JS.
#[path = "../shared/native_identity.rs"]
mod native_identity;
#[path = "../shared/macos_update_core.rs"]
mod update_core;
pub use update_core::{AppBackup, HostPause};
use std::path::Path;
use tauri::Manager;

impl HostPause {
    pub async fn prepare(app: &tauri::AppHandle) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "github_update_install")?
            .join("host");
        let directory = native_identity::for_app_data(&app.path().app_data_dir()
            .map_err(|_| "github_update_install")?).map_err(|_| "github_update_host")?;
        Self::prepare_at(&resources, &directory).await
    }
}
impl AppBackup {
    pub async fn create(app: &tauri::AppHandle) -> Result<Self, String> {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|_| "github_update_install")?;
        let bundle = resources
            .parent()
            .and_then(Path::parent)
            .ok_or("github_update_install")?;
        if bundle.extension().and_then(|s| s.to_str()) != Some("app") {
            return Err("github_update_install".into());
        }
        Self::at(bundle).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_new_attempt_cleans_abandoned_preparation_but_keeps_recovery_backups() {
        let root =
            std::env::temp_dir().join(format!("tarobot-update-test-{}", uuid::Uuid::new_v4()));
        let app = root.join("Original.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("old"), "previous executable").unwrap();
        let abandoned = AppBackup::at(&app).await.unwrap();
        let abandoned_directory = abandoned.directory.clone();
        // Model an exited owner without terminating the test runner. A reaped
        // real child gives us an OS-confirmed dead PID, not a guessed number.
        let mut owner = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead_pid = owner.id();
        owner.wait().unwrap();
        std::fs::write(
            abandoned.directory.join("prepared.json"),
            serde_json::to_vec(&serde_json::json!({
                "app": app.canonicalize().unwrap(), "pid": dead_pid
            }))
            .unwrap(),
        )
        .unwrap();
        std::mem::forget(abandoned);
        let live = AppBackup::at(&app).await.unwrap();
        assert!(!abandoned_directory.exists());
        let live_directory = live.directory.clone();
        let mut recovery = AppBackup::at(&app).await.unwrap();
        assert!(live_directory.exists());
        recovery.begin().unwrap();
        let recovery_directory = recovery.directory.clone();
        std::mem::forget(recovery);
        let next = AppBackup::at(&app).await.unwrap();
        assert!(recovery_directory.join("previous.app/old").is_file());
        assert!(live_directory.exists());
        drop(next);
        drop(live);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn failed_replacement_recovers_the_previous_bundle_and_preserves_data() {
        let root =
            std::env::temp_dir().join(format!("tarobot-update-test-{}", uuid::Uuid::new_v4()));
        let app = root.join("Original.app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("old"), "previous executable").unwrap();
        std::fs::write(root.join("user-data"), "retained").unwrap();
        let mut backup = AppBackup::at(&app).await.unwrap();
        std::fs::remove_dir_all(&app).unwrap();
        std::fs::create_dir(&app).unwrap();
        std::fs::write(app.join("broken"), "failed update").unwrap();
        backup.restore().unwrap();
        drop(backup);
        assert_eq!(
            std::fs::read_to_string(app.join("old")).unwrap(),
            "previous executable"
        );
        assert!(!app.join("broken").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("user-data")).unwrap(),
            "retained"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
