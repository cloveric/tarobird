//! User-initiated capture only. Pixels enter the draft, never the clipboard or Hub.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
#[path = "screenshot_windows.rs"]
mod windows;

const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(super) const MAX_PIXELS: u64 = 32_000_000;
static CAPTURING: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "windows", test))]
fn selection_rect(start: (i32, i32), end: (i32, i32), width: i32, height: i32) -> Option<[i32; 4]> {
    let left = start.0.min(end.0).clamp(0, width);
    let top = start.1.min(end.1).clamp(0, height);
    let right = start.0.max(end.0).clamp(0, width);
    let bottom = start.1.max(end.1).clamp(0, height);
    (right - left >= 2 && bottom - top >= 2).then_some([left, top, right, bottom])
}

struct CaptureGuard;
impl CaptureGuard {
    fn acquire() -> Result<Self, String> {
        CAPTURING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| "screenshot_busy".into())
    }
}
impl Drop for CaptureGuard {
    fn drop(&mut self) { CAPTURING.store(false, Ordering::Release); }
}
struct RestoreWindow(tauri::WebviewWindow);
impl Drop for RestoreWindow {
    fn drop(&mut self) {
        let _ = self.0.show();
        let _ = self.0.set_focus();
    }
}

fn encode_png(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_BYTES { return Err("screenshot_too_large".into()); }
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("screenshot_failed".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("screenshot_too_large".into());
    }
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn capture_screenshot(window: tauri::WebviewWindow, english: bool) -> Result<Option<String>, String> {
    if window.label() != "main" || !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) {
        return Err("screenshot_window_unavailable".into());
    }
    let guard = CaptureGuard::acquire()?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window.run_on_main_thread(move || {
            let allowed = unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() };
            let _ = tx.send(allowed);
        }).map_err(|_| "screenshot_failed")?;
        if !rx.await.map_err(|_| "screenshot_failed")? { return Err("screenshot_permission_denied".into()); }
    }
    window.hide().map_err(|_| "screenshot_failed")?;
    // Keep both guards inside the worker: dropping an IPC future must not reveal
    // our window in the screenshot or allow a second capture to race the first.
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let _restore = RestoreWindow(window);
        std::thread::sleep(std::time::Duration::from_millis(250));
        capture(english)?.map(encode_png).transpose()
    }).await.map_err(|_| "screenshot_failed".to_string())?
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn capture(_english: bool) -> Result<Option<Vec<u8>>, String> {
    use std::{io::Read, os::unix::fs::DirBuilderExt, process::{Command, Stdio}, time::{Duration, Instant}};
    struct Temp(std::path::PathBuf);
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    let path = std::env::temp_dir().join(format!("tarobot-capture-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new().mode(0o700).create(&path).map_err(|_| "screenshot_failed")?;
    let temp = Temp(path);
    let output = temp.0.join("capture.png");
    let mut child = Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-o", "-t", "png"]).arg(&output)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|_| "screenshot_failed")?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < Duration::from_secs(120) => std::thread::sleep(Duration::from_millis(40)),
            result => {
                let _ = child.kill(); let _ = child.wait();
                return if result.is_err() { Err("screenshot_failed".into()) } else { Ok(None) };
            }
        }
    };
    if !output.exists() && (status.success() || status.code() == Some(1)) { return Ok(None); }
    if !status.success() { return Err("screenshot_failed".into()); }
    let mut bytes = Vec::new();
    std::fs::File::open(output).and_then(|file| file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| "screenshot_failed")?;
    Ok(Some(bytes))
}

#[cfg(target_os = "windows")]
fn capture(english: bool) -> Result<Option<Vec<u8>>, String> { windows::capture(english) }
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn capture(_: bool) -> Result<Option<Vec<u8>>, String> { Err("screenshot_unavailable".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reverse_drag_and_monitor_edges() {
        assert_eq!(selection_rect((200, 150), (20, 10), 300, 200), Some([20, 10, 200, 150]));
        assert_eq!(selection_rect((-5, -20), (500, 600), 300, 200), Some([0, 0, 300, 200]));
        assert_eq!(selection_rect((10, 10), (10, 20), 300, 200), None);
        assert_eq!(selection_rect((10, 10), (11, 11), 300, 200), None);
    }
    #[test]
    fn bounds_before_crossing_ipc() {
        assert_eq!(encode_png(vec![0; 24]).unwrap_err(), "screenshot_failed");
        let mut header = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        header.extend(8000u32.to_be_bytes()); header.extend(8000u32.to_be_bytes());
        assert_eq!(encode_png(header).unwrap_err(), "screenshot_too_large");
        assert_eq!(encode_png(vec![0; MAX_BYTES + 1]).unwrap_err(), "screenshot_too_large");
    }
    #[test]
    fn capture_is_exclusive_and_released() {
        let guard = CaptureGuard::acquire().unwrap();
        assert!(CaptureGuard::acquire().is_err());
        drop(guard);
        assert!(CaptureGuard::acquire().is_ok());
    }
}
