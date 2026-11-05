//! Windows read-only guard for the migration exporter: before the old WebView2
//! profile is opened, no old TaroBot may be able to write it. WebView2 lets
//! several Apps share one user-data folder, so the profile is not a lock.
//! Never signals, terminates or changes another process or the Host.
//!
//! 1. Single-instance mutex (primary). Every Tauri TaroBot for Windows
//!    (tauri-plugin-single-instance 2.4.4, no `semver` feature) creates
//!    `<identifier>-sim` in the session namespace during setup, before its
//!    WebView exists. If it already exists, an old App runs in this session,
//!    whatever its folder or elevation. The returned guard keeps our handle
//!    open for the whole export.
//!    An old App started later finds that mutex and looks for the first
//!    instance's `<identifier>-sic` window titled `<identifier>-siw`. The guard
//!    owns exactly such an invisible window on its own message thread: the old
//!    App forwards its arguments (acknowledged, discarded), then exits inside
//!    its first plugin's setup, before any WebView, Host or storage access.
//! 2. Process scan (secondary), after the windows exist: an old App that
//!    started before them is a running process here. Any other `tarocub-client.exe` that is not the
//!    exporter's parent Electron main or one of its descendants is a conflict
//!    when it runs as this user, and unknown (refused) when it cannot be
//!    inspected. Ancestry uses Toolhelp parent IDs confirmed by creation time,
//!    so a reused parent ID never adopts an unrelated process.
#![cfg_attr(not(windows), allow(dead_code))]

pub const IN_USE: &str = "legacy_source_in_use";
pub const OWNER_UNKNOWN: &str = "legacy_source_owner_unknown";
pub const PARENT_UNKNOWN: &str = "legacy_source_parent_unknown";
pub const GUARD_FAILED: &str = "legacy_source_guard_failed";
/// The Tauri App's and the Electron App's executable name.
pub const APP_EXECUTABLE: &str = "tarocub-client.exe";
/// Current and legacy Tauri identifiers (tauri-plugin-single-instance names
/// `<identifier>-sim`, `-sic` and `-siw`; no `semver` feature was ever used).
pub const IDENTIFIERS: [&str; 2] = ["com.tarobot.client", "com.tarocub.client"];
pub const SINGLE_INSTANCE_MUTEXES: [&str; 2] = ["com.tarobot.client-sim", "com.tarocub.client-sim"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Owner { Same, Other, Unknown }

#[derive(Clone, Debug)]
pub struct ProcessRecord {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    /// FILETIME creation time; `None` when the process could not be queried.
    pub created: Option<u64>,
    pub owner: Owner,
}

fn app(record: &ProcessRecord) -> bool { record.name.eq_ignore_ascii_case(APP_EXECUTABLE) }

/// Decides from one snapshot. `me` is the exporter's process ID.
pub fn classify(processes: &[ProcessRecord], me: u32) -> Result<(), &'static str> {
    let find = |pid: u32| processes.iter().find(|record| record.pid == pid);
    let exporter = find(me).ok_or(GUARD_FAILED)?;
    // The exporter is only ever started by Electron main.
    let main = find(exporter.parent).filter(|parent| app(parent)).ok_or(PARENT_UNKNOWN)?;
    match (main.created, exporter.created) {
        (Some(parent), Some(child)) if parent <= child => {}
        _ => return Err(PARENT_UNKNOWN),
    }
    let descends = |pid: u32| {
        let mut current = find(pid);
        for _ in 0..64 {
            let Some(record) = current else { return false };
            if record.pid == main.pid { return true; }
            let Some(parent) = find(record.parent).filter(|parent| parent.pid != record.pid) else { return false };
            match (parent.created, record.created) {
                (Some(before), Some(after)) if before <= after => current = Some(parent),
                _ => return false,
            }
        }
        false
    };
    let mut unknown = false;
    for record in processes.iter().filter(|record| app(record) && !descends(record.pid)) {
        match record.owner {
            // Another Windows user has another LocalAppData and profile.
            Owner::Other => {}
            Owner::Same => return Err(IN_USE),
            Owner::Unknown => unknown = true,
        }
    }
    if unknown { Err(OWNER_UNKNOWN) } else { Ok(()) }
}

#[cfg(windows)]
#[allow(unused_imports)] // `forwarding_windows` is also exercised directly by the Windows CI tests.
pub use system::{acquire, forwarding_windows, ForwardingWindows, SourceGuard};

#[cfg(windows)]
mod system {
    use super::*;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows::{core::PCWSTR, Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, FILETIME, HANDLE, HWND, LPARAM, LRESULT, WPARAM},
        Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            LibraryLoader::GetModuleHandleW,
            Threading::{CreateMutexW, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION}},
        UI::WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostThreadMessageW, RegisterClassExW,
            SetWindowLongPtrW, TranslateMessage, GWL_STYLE, MSG, WM_COPYDATA, WM_QUIT, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_OVERLAPPED, WS_POPUP, WS_VISIBLE},
    }};

    /// Keep alive until the export has finished reading the old profile.
    pub struct SourceGuard { _windows: ForwardingWindows, _mutexes: Vec<OwnedHandle> }

    /// Invisible first-instance windows of the old single-instance protocol,
    /// pumped on their own thread (the old App's `SendMessageW` has no timeout).
    pub struct ForwardingWindows { thread: Option<std::thread::JoinHandle<()>>, thread_id: u32 }
    impl Drop for ForwardingWindows {
        fn drop(&mut self) {
            unsafe { let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)); }
            if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        }
    }

    unsafe extern "system" fn forward(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // Acknowledge and discard the old App's arguments; it then exits.
        if message == WM_COPYDATA { return LRESULT(1); }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    /// Same class, title and styles as the plugin's own first-instance window.
    pub fn forwarding_windows() -> Result<ForwardingWindows, &'static str> {
        let (ready, started) = std::sync::mpsc::channel::<Result<u32, &'static str>>();
        let thread = std::thread::spawn(move || unsafe {
            let created = (|| -> Result<Vec<HWND>, &'static str> {
                let instance = GetModuleHandleW(None).map_err(|_| GUARD_FAILED)?;
                let mut windows = Vec::new();
                for id in IDENTIFIERS {
                    let class = wide(&format!("{id}-sic"));
                    let title = wide(&format!("{id}-siw"));
                    let registration = WNDCLASSEXW { cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32, lpfnWndProc: Some(forward),
                        hInstance: instance.into(), lpszClassName: PCWSTR(class.as_ptr()), ..Default::default() };
                    if RegisterClassExW(&registration) == 0 { return Err(GUARD_FAILED); }
                    let window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                        PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr()), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(instance.into()), None)
                        .map_err(|_| GUARD_FAILED)?;
                    SetWindowLongPtrW(window, GWL_STYLE, (WS_VISIBLE | WS_POPUP).0 as isize);
                    windows.push(window);
                }
                Ok(windows)
            })();
            let windows = match created {
                Ok(windows) => { let _ = ready.send(Ok(GetCurrentThreadId())); windows }
                Err(error) => { let _ = ready.send(Err(error)); return; }
            };
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            for window in windows { let _ = DestroyWindow(window); }
        });
        match started.recv() {
            Ok(Ok(thread_id)) => Ok(ForwardingWindows { thread: Some(thread), thread_id }),
            Ok(Err(error)) => { let _ = thread.join(); Err(error) }
            Err(_) => { let _ = thread.join(); Err(GUARD_FAILED) }
        }
    }

    struct Handle(HANDLE);
    impl Drop for Handle { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

    fn hold(name: &str) -> Result<OwnedHandle, &'static str> {
        let name = wide(name);
        unsafe {
            let handle = CreateMutexW(None, false, PCWSTR(name.as_ptr())).map_err(|_| GUARD_FAILED)?;
            let existed = GetLastError() == ERROR_ALREADY_EXISTS;
            let owned = OwnedHandle::from_raw_handle(handle.0 as _);
            if existed { return Err(IN_USE); }
            Ok(owned)
        }
    }

    fn token_user(process: HANDLE) -> Option<Vec<u8>> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
            let token = Handle(token);
            let mut length = 0u32;
            let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
            if length == 0 || length > 4096 { return None; }
            let mut buffer = vec![0u8; length as usize];
            GetTokenInformation(token.0, TokenUser, Some(buffer.as_mut_ptr().cast()), length, &mut length).ok()?;
            Some(buffer)
        }
    }

    fn same_user(a: &[u8], b: &[u8]) -> bool {
        unsafe {
            let (a, b) = (&*(a.as_ptr() as *const TOKEN_USER), &*(b.as_ptr() as *const TOKEN_USER));
            EqualSid(a.User.Sid, b.User.Sid).is_ok()
        }
    }

    fn inspect(pid: u32, mine: &[u8]) -> (Option<u64>, Owner) {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return (None, Owner::Unknown) };
            let process = Handle(process);
            let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let created = GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user).ok()
                .map(|_| (created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64);
            let owner = match token_user(process.0) {
                Some(user) if same_user(&user, mine) => Owner::Same,
                Some(_) => Owner::Other,
                None => Owner::Unknown,
            };
            (created, owner)
        }
    }

    fn snapshot() -> Result<Vec<(u32, u32, String)>, &'static str> {
        unsafe {
            let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|_| GUARD_FAILED)?);
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut processes = Vec::new();
            let mut next = Process32FirstW(snapshot.0, &mut entry).is_ok();
            while next {
                let end = entry.szExeFile.iter().position(|ch| *ch == 0).unwrap_or(entry.szExeFile.len());
                processes.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..end])));
                next = Process32NextW(snapshot.0, &mut entry).is_ok();
            }
            if processes.is_empty() { return Err(GUARD_FAILED); }
            Ok(processes)
        }
    }

    /// Call before any WebView or storage access; keep the guard alive until
    /// the export has finished.
    pub fn acquire() -> Result<SourceGuard, &'static str> {
        let mut mutexes = Vec::new();
        for name in SINGLE_INSTANCE_MUTEXES { mutexes.push(hold(name)?); }
        // From here an old App that starts forwards to us and exits.
        let windows = forwarding_windows()?;
        let me = unsafe { GetCurrentProcessId() };
        let mine = token_user(unsafe { GetCurrentProcess() }).ok_or(GUARD_FAILED)?;
        let listed = snapshot()?;
        let parent = listed.iter().find(|(pid, ..)| *pid == me).map(|(_, parent, _)| *parent).ok_or(GUARD_FAILED)?;
        // Query only what the decision needs: this exporter, its parent and
        // every App executable (Electron main's Chromium children included).
        let records: Vec<ProcessRecord> = listed.into_iter().map(|(pid, ppid, name)| {
            let relevant = pid == me || pid == parent || name.eq_ignore_ascii_case(APP_EXECUTABLE);
            let (created, owner) = if relevant { inspect(pid, &mine) } else { (None, Owner::Unknown) };
            ProcessRecord { pid, parent: ppid, name, created, owner }
        }).collect();
        classify(&records, me)?;
        Ok(SourceGuard { _windows: windows, _mutexes: mutexes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(pid: u32, parent: u32, name: &str, created: Option<u64>, owner: Owner) -> ProcessRecord {
        ProcessRecord { pid, parent, name: name.into(), created, owner }
    }
    /// Explorer → Electron main (100) → exporter (200) and Chromium children.
    fn tree() -> Vec<ProcessRecord> {
        vec![
            record(4, 0, "explorer.exe", Some(1), Owner::Same),
            record(100, 4, "tarocub-client.exe", Some(10), Owner::Same),
            record(101, 100, "tarocub-client.exe", Some(11), Owner::Same), // renderer
            record(102, 100, "tarocub-client.exe", Some(12), Owner::Same), // GPU / utility
            record(103, 102, "TaroCub-Client.EXE", Some(13), Owner::Same), // nested child
            record(200, 100, "tarobot-migration-exporter.exe", Some(20), Owner::Same),
            record(201, 200, "msedgewebview2.exe", None, Owner::Unknown), // exporter's own WebView2
            record(300, 4, "node.exe", None, Owner::Unknown),             // canonical Host
        ]
    }

    #[test]
    fn electron_main_and_its_chromium_children_are_ours() {
        assert_eq!(classify(&tree(), 200), Ok(()));
    }

    #[test]
    fn another_app_instance_of_this_user_is_a_conflict_wherever_it_is_installed() {
        let mut processes = tree();
        processes.push(record(400, 4, "tarocub-client.exe", Some(30), Owner::Same));
        assert_eq!(classify(&processes, 200), Err(IN_USE));
        // Its own children do not make it ours.
        processes.push(record(401, 400, "tarocub-client.exe", Some(31), Owner::Same));
        assert_eq!(classify(&processes, 200), Err(IN_USE));
    }

    #[test]
    fn other_users_are_ignored_and_uninspectable_processes_are_refused() {
        let mut processes = tree();
        processes.push(record(500, 4, "tarocub-client.exe", None, Owner::Other));
        assert_eq!(classify(&processes, 200), Ok(()));
        processes.push(record(501, 4, "tarocub-client.exe", None, Owner::Unknown));
        assert_eq!(classify(&processes, 200), Err(OWNER_UNKNOWN));
    }

    #[test]
    fn a_reused_parent_id_never_adopts_an_older_process() {
        let mut processes = tree();
        // Created before "its parent": the real parent died and its ID was reused.
        processes.push(record(600, 100, "tarocub-client.exe", Some(5), Owner::Same));
        assert_eq!(classify(&processes, 200), Err(IN_USE));
        // Unknown creation time on the chain: not ours, and this user's → conflict.
        let mut unknown = tree();
        unknown.push(record(601, 100, "tarocub-client.exe", None, Owner::Same));
        assert_eq!(classify(&unknown, 200), Err(IN_USE));
    }

    #[test]
    fn the_exporter_must_be_started_by_electron_main() {
        let mut processes = tree();
        processes.iter_mut().find(|record| record.pid == 200).unwrap().parent = 4;
        assert_eq!(classify(&processes, 200), Err(PARENT_UNKNOWN));
        let mut reused = tree();
        reused.iter_mut().find(|record| record.pid == 100).unwrap().created = Some(25);
        assert_eq!(classify(&reused, 200), Err(PARENT_UNKNOWN));
        assert_eq!(classify(&tree(), 999), Err(GUARD_FAILED));
    }
}
