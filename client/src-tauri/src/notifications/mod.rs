mod state;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "windows", test))]
mod windows_payload;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub mod windows_identity;
use state::{Action, Inbox, Notice, Operations, Submissions, Target};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

const ACTION_EVENT: &str = "tarocub-notification-action";
pub struct Notifications {
    inbox: Mutex<Inbox>,
    submissions: Mutex<Submissions>,
    operations: Operations,
    app: OnceLock<tauri::AppHandle>,
}
impl Notifications {
    pub fn new_document(&self) {
        if let Ok(mut submissions) = self.submissions.lock() { submissions.new_document(); }
    }
    fn focus(&self) {
        if let Some(app) = self.app.get() {
            let focus = app.clone();
            let _ = app.run_on_main_thread(move || super::show(&focus));
        }
    }
    fn activate(&self, target: Target) {
        let Ok(mut inbox) = self.inbox.lock() else { return; };
        if inbox.activate(target).is_err() { return; }
        drop(inbox);
        if let Some(app) = self.app.get() {
            self.focus();
            let _ = app.emit_to("main", ACTION_EVENT, ());
        }
    }
}
pub fn initialize() -> Arc<Notifications> {
    let state = Arc::new(Notifications { inbox: Mutex::new(Inbox::default()), submissions: Mutex::new(Submissions::default()), operations: Operations::default(), app: OnceLock::new() });
    #[cfg(target_os = "macos")]
    macos::initialize(state.clone());
    #[cfg(target_os = "windows")]
    state.activation_args(&std::env::args().collect::<Vec<_>>());
    state
}
#[cfg(target_os = "windows")]
impl Notifications {
    pub fn activation_args(&self, args: &[String]) {
        if let Some(target) = windows_payload::activation_args(args) { self.activate(target); }
    }
}
pub fn attach(app: &tauri::AppHandle) {
    let state = app.state::<Arc<Notifications>>();
    let _ = state.app.set(app.clone());
    if state.inbox.lock().ok().is_some_and(|inbox| inbox.peek().is_some()) { super::show(app); }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("notification_window_denied".into()) }
}
#[tauri::command]
pub fn desktop_notifications_supported() -> bool { cfg!(any(target_os = "macos", target_os = "windows")) }
#[tauri::command]
pub fn desktop_notification_context(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Notifications>>) -> Result<String, String> {
    main_window(&window)?;
    Ok(state.submissions.lock().map_err(|_| "notification_state_unavailable")?.document_id())
}

#[tauri::command]
pub async fn desktop_notification_permission(window: tauri::WebviewWindow, request: bool) -> Result<String, String> {
    main_window(&window)?;
    #[cfg(target_os = "macos")]
    return macos::permission(request).await;
    #[cfg(target_os = "windows")]
    { let _ = request; return tauri::async_runtime::spawn_blocking(windows::permission).await.map_err(|_| "native_notification_unavailable")?; }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = request; Err("native_notification_unavailable".into()) }
}
#[tauri::command]
pub async fn desktop_notification_show(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Notifications>>, notice: Notice, document_id: String) -> Result<(), String> {
    main_window(&window)?; notice.validate()?;
    let operation = state.operations.acquire(Some(&notice.host_id)).await?;
    let submission = state.submissions.lock().map_err(|_| "notification_state_unavailable")?.admit_document(&document_id, &notice.host_id)?;
    #[cfg(target_os = "macos")]
    { let _operation = operation; return macos::send(notice, submission).await; }
    #[cfg(target_os = "windows")]
    return tauri::async_runtime::spawn_blocking(move || { let _operation = operation; windows::send(notice, submission) }).await.map_err(|_| "native_notification_unavailable")?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (submission, operation); Err("native_notification_unavailable".into()) }
}
/// Fixed system destinations only; no caller-supplied URL or argument.
/// Windows documents `ms-settings:notifications` (Notifications & actions).
/// macOS has no documented per-app notification URL: open the System Settings
/// app itself, and the UI tells the user to choose Notifications → TaroBot.
#[tauri::command]
pub async fn desktop_notification_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || open_system_settings(&window)).await.map_err(|_| "notification_settings_unavailable")?
}
fn open_system_settings(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;
        return window.opener().open_url("ms-settings:notifications", None::<&str>).map_err(|_| "notification_settings_unavailable".into());
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open").args(["-b", "com.apple.systempreferences"]).status().map_err(|_| "notification_settings_unavailable")?;
        return if status.success() { Ok(()) } else { Err("notification_settings_unavailable".into()) };
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Err("notification_settings_unavailable".into())
}
#[tauri::command]
pub fn desktop_notification_peek(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Notifications>>) -> Result<Option<Action>, String> {
    main_window(&window)?;
    Ok(state.inbox.lock().map_err(|_| "notification_state_unavailable")?.peek())
}
#[tauri::command]
pub fn desktop_notification_ack(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Notifications>>, id: String) -> Result<(), String> {
    main_window(&window)?;
    state.inbox.lock().map_err(|_| "notification_state_unavailable")?.ack(&id); Ok(())
}
#[tauri::command]
pub async fn desktop_notification_clear(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Notifications>>, host_id: Option<String>, document_id: String) -> Result<(), String> {
    main_window(&window)?;
    if host_id.as_ref().is_some_and(|host| !state::valid_host(host)) { return Err("invalid_notification_host".into()); }
    let operation = state.operations.acquire(host_id.as_deref()).await?;
    {
        let mut submissions = state.submissions.lock().map_err(|_| "notification_state_unavailable")?;
        submissions.clear_document(&document_id, host_id.as_deref())?;
        state.inbox.lock().map_err(|_| "notification_state_unavailable")?.clear(host_id.as_deref());
    }
    #[cfg(target_os = "macos")]
    { let _operation = operation; return macos::clear(host_id).await; }
    #[cfg(target_os = "windows")]
    return tauri::async_runtime::spawn_blocking(move || { let _operation = operation; windows::clear(host_id) }).await.map_err(|_| "native_notification_unavailable")?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _operation = operation; Ok(()) }
}
