//! Trusted-window wrappers for the signed transitional desktop build.
use super::{desktop_migration as core, device_installation};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct MigrationState(pub Arc<Mutex<Inner>>, Option<std::path::PathBuf>);
#[derive(Default)]
pub struct Inner { generation: u64, session: Option<core::ExportSession>, committed: Option<String> }
impl MigrationState {
    #[cfg(feature = "native-transport-audit")]
    pub fn isolated(directory: std::path::PathBuf) -> Self { Self(Arc::default(), Some(directory)) }
    fn directory(&self, window: &tauri::WebviewWindow) -> Result<std::path::PathBuf, String> {
        self.1.clone().map(Ok).unwrap_or_else(|| window.app_handle().path().app_local_data_dir().map_err(|_| "migration_storage_failed".into()))
    }
    pub fn retire(&self) {
        let Ok(mut inner) = self.0.lock() else { return; };
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(session) = inner.session.take() { tauri::async_runtime::spawn_blocking(move || session.abort()); }
    }
    // Export-only reader waits for its own partial to be retired before exit.
    // The regular App keeps the nonblocking retirement path above.
    #[cfg(feature = "desktop-migration-exporter")]
    pub fn retire_before_exit(&self) {
        let Ok(mut inner) = self.0.lock() else { return; };
        inner.generation = inner.generation.wrapping_add(1);
        if let Some(session) = inner.session.take() { session.abort(); }
    }
    /// The export this process committed: `finished` must confirm exactly it.
    #[cfg(feature = "desktop-migration-exporter")]
    pub fn committed(&self) -> Option<String> { self.0.lock().ok()?.committed.clone() }
}
fn owner(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("migration_window_denied".into()) }
}
fn session<'a>(inner: &'a mut Inner, id: &str) -> Result<&'a mut core::ExportSession, String> {
    inner.session.as_mut().filter(|session| session.id() == id).ok_or_else(|| "migration_session_expired".into())
}
#[tauri::command]
pub async fn desktop_migration_begin(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>) -> Result<String, String> {
    owner(&window)?;
    let directory = state.directory(&window)?;
    let state = state.0.clone();
    let generation = state.lock().map_err(|_| "migration_state_failed")?.generation;
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = state.lock().map_err(|_| "migration_state_failed")?;
        if inner.generation != generation { return Err("migration_session_expired".into()); }
        if inner.session.is_some() { return Err("migration_busy".into()); }
        let marker = device_installation::identifier(&directory)?;
        let session = core::ExportSession::begin(&directory, &marker)?;
        let id = session.id().to_owned(); inner.session = Some(session); Ok(id)
    }).await.map_err(|_| "migration_storage_failed")?
}
#[tauri::command]
pub async fn desktop_migration_part(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>, export_id: String, index: usize, text: String) -> Result<(), String> {
    owner(&window)?;
    if text.len() > core::MAX_PART_BYTES { return Err("migration_part_invalid".into()); }
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session(&mut *state.lock().map_err(|_| "migration_state_failed")?, &export_id)?.write_part(index, text.as_bytes())?; Ok(())
    }).await.map_err(|_| "migration_storage_failed")?
}
#[tauri::command]
pub async fn desktop_migration_blob(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    owner(&window)?;
    let id = request.headers().get("x-tarobot-export-id").and_then(|value| value.to_str().ok()).filter(|value| core::export_id_valid(value)).ok_or("migration_session_expired")?.to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("migration_blob_invalid".into()); };
    if bytes.len() > core::MAX_BLOB_BYTES { return Err("migration_blob_invalid".into()); }
    let bytes = bytes.clone(); let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || session(&mut *state.lock().map_err(|_| "migration_state_failed")?, &id)?.write_blob(&bytes)).await.map_err(|_| "migration_storage_failed")?
}
#[tauri::command]
pub async fn desktop_migration_commit(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>, export_id: String, metadata: String) -> Result<core::Summary, String> {
    owner(&window)?;
    if metadata.len() > core::MAX_METADATA_BYTES { return Err("migration_metadata_invalid".into()); }
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = state.lock().map_err(|_| "migration_state_failed")?;
        session(&mut inner, &export_id)?;
        let session = inner.session.take().ok_or("migration_session_expired")?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "migration_clock_invalid")?.as_millis() as u64;
        let summary = session.commit(metadata.as_bytes(), now)?;
        inner.committed = Some(summary.export_id.clone());
        Ok(summary)
    }).await.map_err(|_| "migration_storage_failed")?
}
#[tauri::command]
pub async fn desktop_migration_abort(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>, export_id: String) -> Result<(), String> {
    owner(&window)?; let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = state.lock().map_err(|_| "migration_state_failed")?;
        session(&mut inner, &export_id)?;
        if let Some(session) = inner.session.take() { session.abort(); } Ok(())
    }).await.map_err(|_| "migration_storage_failed")?
}
#[tauri::command]
pub async fn desktop_migration_status(window: tauri::WebviewWindow, state: tauri::State<'_, MigrationState>) -> Result<core::Status, String> {
    owner(&window)?;
    let directory = state.directory(&window)?;
    tauri::async_runtime::spawn_blocking(move || core::status(&directory)).await.map_err(|_| "migration_storage_failed")?
}

#[tauri::command]
pub fn desktop_migration_mode(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    owner(&window)?;
    Ok(serde_json::json!({ "transition": option_env!("TAROBOT_DESKTOP_TRANSITION") == Some("1"), "appVersion": window.app_handle().package_info().version.to_string() }))
}
