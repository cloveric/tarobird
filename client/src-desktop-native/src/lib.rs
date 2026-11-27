//! In-process OS APIs whose permissions belong to the signed application.
//! The separate transport helper must never impersonate the App's notification
//! or screen-capture identity. Existing native validation is shared unchanged.
#[path = "../../src-tauri/src/notifications/state.rs"]
mod state;
#[cfg(target_os = "macos")]
#[path = "../../src-tauri/src/notifications/macos.rs"]
mod macos;
#[cfg(any(target_os = "windows", test))]
#[path = "../../src-tauri/src/notifications/windows_payload.rs"]
mod windows_payload;
#[cfg(any(target_os = "windows", test))]
#[path = "../../src-tauri/src/notifications/windows_status.rs"]
mod windows_status;
#[cfg(target_os = "windows")]
#[path = "../../src-tauri/src/notifications/windows.rs"]
mod windows;
#[cfg(target_os = "windows")]
#[path = "../../src-tauri/src/notifications/windows_identity.rs"]
mod windows_identity;
#[cfg(target_os = "windows")]
#[path = "../../src-tauri/src/screenshot_windows.rs"]
mod screenshot_windows;
#[cfg(target_os = "windows")]
const MAX_PIXELS: u64 = 32_000_000;
#[cfg(target_os = "windows")]
fn selection_rect(start: (i32, i32), end: (i32, i32), width: i32, height: i32) -> Option<[i32; 4]> {
    let left = start.0.min(end.0).clamp(0, width); let top = start.1.min(end.1).clamp(0, height);
    let right = start.0.max(end.0).clamp(0, width); let bottom = start.1.max(end.1).clamp(0, height);
    (right - left >= 2 && bottom - top >= 2).then_some([left, top, right, bottom])
}
#[path = "../../src-tauri/src/saved_file_quarantine.rs"]
mod saved_file_quarantine;
#[cfg(target_os = "macos")]
#[cfg_attr(not(feature = "addon"), allow(dead_code))]
mod screen_macos;
// Built for tests on every host: everything except its `os` half is plain logic.
#[cfg(any(target_os = "windows", test))]
#[cfg_attr(any(not(target_os = "windows"), not(feature = "addon")), allow(dead_code))]
mod screen_windows;
use state::{Inbox, Notice, Operations, Submissions, Target};
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};

pub struct Notifications {
    inbox: Mutex<Inbox>, submissions: Mutex<Submissions>, operations: Operations,
    activated: AtomicBool,
}
impl Notifications {
    fn focus(&self) { self.activated.store(true, Ordering::Release); }
    fn activate(&self, target: Target) {
        if let Ok(mut inbox) = self.inbox.lock() {
            if inbox.activate(target).is_ok() { self.focus(); }
        }
    }
}
static NOTIFICATIONS: OnceLock<Arc<Notifications>> = OnceLock::new();
fn notifications() -> Result<Arc<Notifications>, String> {
    NOTIFICATIONS.get().cloned().ok_or_else(|| "native_notification_unavailable".into())
}
fn initialize() {
    let state = NOTIFICATIONS.get_or_init(|| Arc::new(Notifications {
        inbox: Mutex::new(Inbox::default()), submissions: Mutex::new(Submissions::default()),
        operations: Operations::default(), activated: AtomicBool::new(false),
    }));
    #[cfg(target_os = "macos")]
    macos::initialize(state.clone());
}
/// `confirmation`: the localized body of the Windows registration toast. Only
/// an explicit request (`request == true`) may show it; macOS ignores it.
async fn permission(request: bool, confirmation: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    { let _ = confirmation; macos::permission(request).await }
    #[cfg(target_os = "windows")]
    { tokio::task::spawn_blocking(move || windows::permission(request, confirmation)).await.map_err(|_| "native_notification_unavailable")? }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = (request, confirmation); Err("native_notification_unavailable".into()) }
}
async fn send(raw: String, document: String) -> Result<(), String> {
    if raw.len() > 8192 { return Err("invalid_notification".into()); }
    let notice: Notice = serde_json::from_str(&raw).map_err(|_| "invalid_notification")?;
    notice.validate()?;
    let state = notifications()?;
    let operation = state.operations.acquire(Some(&notice.host_id)).await?;
    let submission = state.submissions.lock().map_err(|_| "notification_state_unavailable")?.admit_document(&document, &notice.host_id)?;
    #[cfg(target_os = "macos")]
    { let _operation = operation; macos::send(notice, submission).await }
    #[cfg(target_os = "windows")]
    { tokio::task::spawn_blocking(move || { let _operation = operation; windows::send(notice, submission) }).await.map_err(|_| "native_notification_unavailable")? }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = (operation, submission); Err("native_notification_unavailable".into()) }
}
async fn clear(host: Option<String>, document: String) -> Result<(), String> {
    if host.as_ref().is_some_and(|host| !state::valid_host(host)) { return Err("invalid_notification_host".into()); }
    let state = notifications()?;
    let operation = state.operations.acquire(host.as_deref()).await?;
    state.submissions.lock().map_err(|_| "notification_state_unavailable")?.clear_document(&document, host.as_deref())?;
    state.inbox.lock().map_err(|_| "notification_state_unavailable")?.clear(host.as_deref());
    #[cfg(target_os = "macos")]
    { let _operation = operation; macos::clear(host).await }
    #[cfg(target_os = "windows")]
    { tokio::task::spawn_blocking(move || { let _operation = operation; windows::clear(host) }).await.map_err(|_| "native_notification_unavailable")? }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { let _ = operation; Ok(()) }
}

/// Windows login item managed exactly as by tauri-plugin-autostart 2.7.0:
/// auto-launch 0.6.0 with the product name, this executable and no arguments
/// (`HKCU\...\CurrentVersion\Run\TaroBot` plus its StartupApproved flag).
/// The Electron executable keeps the Tauri name and install folder, so an
/// entry enabled before the upgrade is the same entry and stays controllable.
#[cfg(target_os = "windows")]
fn login_item() -> Result<auto_launch::AutoLaunch, String> {
    let executable = std::env::current_exe().map_err(|_| "autostart_unavailable")?;
    let mut builder = auto_launch::AutoLaunchBuilder::new();
    builder.set_app_name("TaroBot").set_app_path(&executable.display().to_string()).set_args(&[] as &[&str]);
    builder.build().map_err(|_| "autostart_unavailable".into())
}

#[cfg(feature = "addon")]
mod bindings {
    use super::*;
    use napi_derive::napi;
    fn error(value: String) -> napi::Error { napi::Error::from_reason(value) }
    #[napi]
    pub fn initialize_notifications() { initialize(); }
    #[napi]
    pub fn notification_context() -> napi::Result<String> {
        Ok(notifications().map_err(error)?.submissions.lock().map_err(|_| error("notification_state_unavailable".into()))?.document_id())
    }
    #[napi]
    pub fn retire_notifications() -> napi::Result<()> {
        notifications().map_err(error)?.submissions.lock().map_err(|_| error("notification_state_unavailable".into()))?.new_document(); Ok(())
    }
    #[napi]
    pub async fn notification_permission(request: bool, confirmation: Option<String>) -> napi::Result<String> { permission(request, confirmation).await.map_err(error) }
    /// Windows only: bounded, path-free status JSON for support.
    #[napi]
    pub fn notification_diagnostics() -> napi::Result<String> {
        #[cfg(target_os = "windows")]
        { Ok(windows::diagnostics()) }
        #[cfg(not(target_os = "windows"))]
        { Err(error("native_notification_unavailable".into())) }
    }
    /// Windows only: where an explicit "create shortcut" click may create the link.
    #[napi]
    pub fn notification_shortcut_path() -> napi::Result<String> {
        #[cfg(target_os = "windows")]
        { windows_identity::shortcut_path().map(|path| path.to_string_lossy().into_owned()).map_err(error) }
        #[cfg(not(target_os = "windows"))]
        { Err(error("native_notification_unavailable".into())) }
    }
    /// Windows only: verify and register the link created at that path.
    #[napi]
    pub async fn notification_adopt_shortcut() -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        { tokio::task::spawn_blocking(windows_identity::adopt_created_shortcut).await.map_err(|_| error("native_notification_unavailable".into()))?.map_err(error) }
        #[cfg(not(target_os = "windows"))]
        { Err(error("native_notification_unavailable".into())) }
    }
    #[napi]
    pub async fn notification_show(raw: String, document: String) -> napi::Result<()> { send(raw, document).await.map_err(error) }
    #[napi]
    pub async fn notification_clear(host: Option<String>, document: String) -> napi::Result<()> { clear(host, document).await.map_err(error) }
    #[napi]
    pub fn notification_peek() -> napi::Result<String> {
        let state = notifications().map_err(error)?;
        let value = state.inbox.lock().map_err(|_| error("notification_state_unavailable".into()))?.peek();
        serde_json::to_string(&value).map_err(|_| error("notification_state_unavailable".into()))
    }
    #[napi]
    pub fn notification_ack(id: String) -> napi::Result<()> {
        if id.len() > 128 { return Err(error("invalid_notification_target".into())); }
        notifications().map_err(error)?.inbox.lock().map_err(|_| error("notification_state_unavailable".into()))?.ack(&id); Ok(())
    }
    #[napi]
    pub fn notification_activity() -> bool { NOTIFICATIONS.get().is_some_and(|state| state.activated.swap(false, Ordering::AcqRel)) }
    #[napi]
    pub fn notification_activation_args(args: Vec<String>) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        if let Some(target) = windows_payload::activation_args(&args) { notifications().map_err(error)?.activate(target); }
        // The registration confirmation only brings the window forward.
        else if windows_payload::ready_activation(&args) { notifications().map_err(error)?.focus(); }
        let _ = args; Ok(())
    }
    #[napi]
    pub fn notification_installer_command() -> Option<i32> {
        #[cfg(target_os = "windows")]
        { windows_identity::installer_command() }
        #[cfg(not(target_os = "windows"))]
        { None }
    }
    #[napi]
    pub fn mark_saved_file(file: String) -> napi::Result<()> {
        let path = std::path::Path::new(&file);
        if file.len() > 32768 || !path.is_absolute() { return Err(error("saved_file_unavailable".into())); }
        saved_file_quarantine::mark(path).map_err(error)
    }
    #[napi]
    pub fn autostart_enabled() -> napi::Result<bool> {
        #[cfg(target_os = "windows")]
        { login_item().map_err(error)?.is_enabled().map_err(|_| error("autostart_unavailable".into())) }
        #[cfg(not(target_os = "windows"))]
        { Err(error("autostart_unavailable".into())) }
    }
    #[napi]
    pub fn set_autostart(enabled: bool) -> napi::Result<()> {
        #[cfg(target_os = "windows")]
        {
            let item = login_item().map_err(error)?;
            if enabled { item.enable() } else { item.disable() }.map_err(|_| error("autostart_unavailable".into()))
        }
        #[cfg(not(target_os = "windows"))]
        { let _ = enabled; Err(error("autostart_unavailable".into())) }
    }

    // Remote screen (#99, #48). macOS and Windows; every other platform reports unavailable.
    #[napi(object)]
    pub struct ScreenPoint { pub x: f64, pub y: f64 }
    #[napi(object)]
    pub struct ScreenRect { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }
    /// The platform this addon controls as a remote-screen target. Windows is
    /// named only by the real backend: an older addon whose screen functions
    /// are stubs has no such function, and must not be taken for a target.
    #[napi]
    pub fn screen_target_platform() -> Option<String> {
        #[cfg(target_os = "macos")] { Some("macos".into()) }
        #[cfg(target_os = "windows")] { Some("windows".into()) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { None }
    }
    /// Windows: the physical bounds of every monitor, as Windows lists them.
    #[napi]
    pub fn screen_monitors() -> napi::Result<Vec<ScreenRect>> {
        #[cfg(target_os = "windows")] { Ok(screen_windows::monitors().map_err(error)?.into_iter().map(|r| ScreenRect { x: r.x, y: r.y, width: r.width, height: r.height }).collect()) }
        #[cfg(not(target_os = "windows"))] { Ok(Vec::new()) }
    }
    /// Windows: the physical button ("left" | "right" | "other") that Windows
    /// takes for `button` by meaning, as the left/right swap setting is now.
    /// The caller records the answer before pressing it with `screenMouse`.
    #[napi]
    pub fn screen_physical_button(button: String) -> napi::Result<String> {
        #[cfg(target_os = "windows")] { Ok(screen_windows::physical_button_now(screen_windows::Button::parse(&button).map_err(error)?).name().into()) }
        #[cfg(not(target_os = "windows"))] { let _ = button; Err(error("screen_unavailable".into())) }
    }
    /// Windows: how many keys and buttons this process pressed and could not release yet.
    #[napi]
    pub fn screen_release_pending() -> u32 {
        #[cfg(target_os = "windows")] { screen_windows::held() }
        #[cfg(not(target_os = "windows"))] { 0 }
    }
    #[napi(object)]
    pub struct ScreenSession { pub available: bool, pub on_console: bool, pub locked: bool, pub user: Option<i64>, pub audit: Option<i64>, pub unique: Option<String>, pub login_done: bool }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn screen_unavailable<T>() -> napi::Result<T> { Err(error("screen_unavailable".into())) }
    fn flags(value: f64) -> napi::Result<u64> {
        if value.is_finite() && value >= 0.0 && value <= u32::MAX as f64 && value.fract() == 0.0 { Ok(value as u64) } else { Err(error("screen_input_invalid".into())) }
    }
    #[napi]
    pub fn screen_display_uuid(display: u32) -> Option<String> {
        #[cfg(target_os = "macos")] { screen_macos::display_uuid(display) }
        #[cfg(not(target_os = "macos"))] { let _ = display; None }
    }
    #[napi]
    pub fn screen_session() -> ScreenSession {
        #[cfg(target_os = "macos")] { let s = screen_macos::session_state(); ScreenSession { available: s.available, on_console: s.on_console, locked: s.locked, user: s.user, audit: s.audit, unique: s.unique, login_done: s.login_done } }
        #[cfg(target_os = "windows")] { let s = screen_windows::session_state(); ScreenSession { available: s.available, on_console: s.on_console, locked: s.locked, user: None, audit: None, unique: s.unique, login_done: s.available } }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { ScreenSession { available: false, on_console: false, locked: false, user: None, audit: None, unique: None, login_done: false } }
    }
    #[napi]
    pub fn screen_mouse(action: String, button: String, x: f64, y: f64, clicks: i64, modifiers: f64) -> napi::Result<()> {
        #[cfg(target_os = "macos")] { let modifiers = flags(modifiers)?;
          screen_macos::post_mouse(screen_macos::Mouse::parse(&action).map_err(error)?, screen_macos::Button::parse(&button).map_err(error)?, screen_macos::CGPoint { x, y }, clicks, modifiers).map_err(error) }
        // Windows: `x`/`y` are physical pixels and `button` is a physical button (see `screen_physical_button`).
        // Modifier state is the system's own; `modifiers` is only validated.
        #[cfg(target_os = "windows")] { flags(modifiers)?;
          screen_windows::post_mouse(screen_windows::Mouse::parse(&action).map_err(error)?, screen_windows::Button::parse(&button).map_err(error)?, x, y, clicks).map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { let _ = (action, button, x, y, clicks, flags(modifiers)); screen_unavailable() }
    }
    #[napi]
    pub fn screen_scroll(x: f64, y: f64, wheel1: i32, wheel2: i32, modifiers: f64) -> napi::Result<()> {
        #[cfg(target_os = "macos")] { screen_macos::post_scroll(screen_macos::CGPoint { x, y }, wheel1, wheel2, flags(modifiers)?).map_err(error) }
        // Windows: `wheel1` is the vertical and `wheel2` the horizontal amount in WHEEL_DELTA units.
        #[cfg(target_os = "windows")] { flags(modifiers)?; screen_windows::post_scroll(x, y, wheel1, wheel2).map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { let _ = (x, y, wheel1, wheel2, flags(modifiers)); screen_unavailable() }
    }
    #[napi]
    pub fn screen_key(keycode: u32, down: bool, modifiers: f64, modifier: bool, repeat: bool) -> napi::Result<()> {
        let keycode = u16::try_from(keycode).map_err(|_| error("screen_input_invalid".into()))?;
        #[cfg(target_os = "macos")] { screen_macos::post_key(keycode, down, flags(modifiers)?, modifier, repeat).map_err(error) }
        // Windows: `keycode` is a scan code, `| 0x100` for an extended key. A repeat is another down.
        #[cfg(target_os = "windows")] { flags(modifiers)?; let _ = repeat; screen_windows::post_key(keycode, down, modifier).map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { let _ = (keycode, down, flags(modifiers), modifier, repeat); screen_unavailable() }
    }
    #[napi]
    pub fn screen_text(text: String) -> napi::Result<()> {
        #[cfg(target_os = "macos")] { screen_macos::post_text(&text).map_err(error) }
        #[cfg(target_os = "windows")] { screen_windows::post_text(&text).map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { let _ = text; screen_unavailable() }
    }
    #[napi]
    pub fn screen_cursor() -> napi::Result<ScreenPoint> {
        #[cfg(target_os = "macos")] { let p = screen_macos::cursor(); Ok(ScreenPoint { x: p.x, y: p.y }) }
        #[cfg(target_os = "windows")] { let (x, y) = screen_windows::cursor().map_err(error)?; Ok(ScreenPoint { x: x as f64, y: y as f64 }) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { screen_unavailable() }
    }
    #[napi]
    pub fn screen_release_all() -> napi::Result<u32> {
        #[cfg(target_os = "macos")] { screen_macos::release_all().map_err(error) }
        #[cfg(target_os = "windows")] { screen_windows::release_all().map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { screen_unavailable() }
    }
    #[napi(object)]
    pub struct ScreenMonitor { pub alive: bool, pub failed: bool, pub foreign: u32, pub interrupted: u32 }
    /// Local-takeover monitor; started only while a control lease is live.
    /// Returns at once; readiness or failure is reported by `screenMonitorPoll`.
    #[napi]
    pub fn screen_monitor_start() -> napi::Result<()> {
        #[cfg(target_os = "macos")] { screen_macos::monitor_start().map_err(error) }
        #[cfg(target_os = "windows")] { screen_windows::monitor_start().map_err(error) }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { screen_unavailable() }
    }
    /// Input Monitoring access for the takeover monitor; `request` only on an explicit user gesture.
    /// Windows asks no permission for its hooks, so there is nothing to grant or request.
    #[napi]
    pub fn screen_monitor_access(request: bool) -> bool {
        #[cfg(target_os = "macos")] { screen_macos::listen_access(request) }
        #[cfg(target_os = "windows")] { let _ = request; true }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { let _ = request; false }
    }
    #[napi]
    pub fn screen_monitor_poll() -> ScreenMonitor {
        #[cfg(target_os = "macos")] { let p = screen_macos::monitor_poll(); ScreenMonitor { alive: p.alive, failed: p.failed, foreign: p.foreign.min(u32::MAX as u64) as u32, interrupted: p.interrupted.min(u32::MAX as u64) as u32 } }
        #[cfg(target_os = "windows")] { let p = screen_windows::monitor_poll(); ScreenMonitor { alive: p.alive, failed: p.failed, foreign: p.foreign.min(u32::MAX as u64) as u32, interrupted: p.interrupted.min(u32::MAX as u64) as u32 } }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))] { ScreenMonitor { alive: false, failed: false, foreign: 0, interrupted: 0 } }
    }
    #[napi]
    pub fn screen_monitor_stop() {
        #[cfg(target_os = "macos")] { screen_macos::monitor_stop() }
        #[cfg(target_os = "windows")] { screen_windows::monitor_stop() }
    }
    #[napi]
    pub fn screen_release_stale() -> napi::Result<()> {
        #[cfg(target_os = "macos")] { screen_macos::release_stale().map_err(error) }
        // Windows never lifts input it has no record of; see `screen_release_candidates`.
        #[cfg(not(target_os = "macos"))] { Err(error("screen_unavailable".into())) }
    }
    /// Windows, after the App died during control: lifts those of `keys` (scan
    /// code descriptors) and `buttons` (physical) that are still down. Both come from the
    /// record the dead process wrote before pressing; nothing else is examined.
    /// Returns how many releases Windows took; fails if it did not take them all.
    #[napi]
    pub fn screen_release_candidates(keys: Vec<u32>, buttons: Vec<String>) -> napi::Result<u32> {
        #[cfg(target_os = "windows")]
        {
            let keys = keys.into_iter().map(u16::try_from).collect::<Result<Vec<u16>, _>>().map_err(|_| error("screen_input_invalid".into()))?;
            let buttons = buttons.iter().map(|button| screen_windows::Button::parse(button)).collect::<Result<Vec<_>, _>>().map_err(error)?;
            screen_windows::release_candidates(&keys, &buttons).map_err(error)
        }
        #[cfg(not(target_os = "windows"))] { let _ = (keys, buttons); Err(error("screen_unavailable".into())) }
    }
    #[napi]
    pub fn screen_capture_access(request: bool) -> bool {
        #[cfg(target_os = "macos")]
        {
            #[link(name = "CoreGraphics", kind = "framework")]
            unsafe extern "C" { fn CGPreflightScreenCaptureAccess() -> bool; fn CGRequestScreenCaptureAccess() -> bool; }
            unsafe { CGPreflightScreenCaptureAccess() || request && CGRequestScreenCaptureAccess() }
        }
        #[cfg(not(target_os = "macos"))]
        { let _ = request; true }
    }
    #[napi]
    pub async fn capture_windows(english: bool, locale: Option<String>) -> napi::Result<Option<String>> {
        #[cfg(target_os = "windows")]
        {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let bytes = tokio::task::spawn_blocking(move || screenshot_windows::capture(english, locale.as_deref())).await
                .map_err(|_| error("screenshot_failed".into()))?.map_err(error)?;
            if bytes.as_ref().is_some_and(|data| data.len() > 32 * 1024 * 1024) { return Err(error("screenshot_too_large".into())); }
            Ok(bytes.map(|data| STANDARD.encode(data)))
        }
        #[cfg(not(target_os = "windows"))]
        { let _ = (english, locale); Err(error("screenshot_unavailable".into())) }
    }
}
