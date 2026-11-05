//! Runs the unit tests of src-tauri/legacy/windows_source_guard.rs (owned by
//! Opus, called from the migration exporter) on any platform, and compiles its
//! Windows system calls for the Windows target.
#[path = "../../src-tauri/legacy/windows_source_guard.rs"]
#[allow(dead_code, unused_imports)]
mod guard;

/// Windows CI only (not run on the development Mac): the system path end to end.
#[cfg(windows)]
mod system {
    use super::guard;
    use windows::{core::PCWSTR, Win32::{Foundation::CloseHandle, System::Threading::CreateMutexW}};

    /// A test runner is not started by Electron main: refused, nothing held.
    #[test]
    fn a_process_not_started_by_electron_main_is_refused() {
        assert_eq!(guard::acquire().err(), Some(guard::PARENT_UNKNOWN));
    }

    /// A late old App does exactly this (tauri-plugin-single-instance 2.4.4):
    /// find `<id>-sic`/`<id>-siw`, send WM_COPYDATA, then exit. Bounded here so
    /// a broken message pump fails the test instead of hanging it.
    #[test]
    fn a_late_old_app_finds_the_guard_window_and_its_forward_is_acknowledged() {
        use windows::Win32::{Foundation::{LPARAM, WPARAM}, System::DataExchange::COPYDATASTRUCT,
            UI::WindowsAndMessaging::{FindWindowW, SendMessageTimeoutW, SMTO_NORMAL, WM_COPYDATA}};
        let wide = |value: String| value.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let windows = guard::forwarding_windows().expect("guard windows");
        for id in guard::IDENTIFIERS {
            let (class, title) = (wide(format!("{id}-sic")), wide(format!("{id}-siw")));
            let window = unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) }.expect("an old App would find it");
            let data = b"C:\\|C:\\TaroBot\\tarocub-client.exe|tarocub://conversation/x\0";
            let copy = COPYDATASTRUCT { dwData: 1542, cbData: data.len() as u32, lpData: data.as_ptr() as _ };
            let mut result = 0usize;
            let sent = unsafe { SendMessageTimeoutW(window, WM_COPYDATA, WPARAM(0), LPARAM(&copy as *const _ as isize), SMTO_NORMAL, 5000, Some(&mut result)) };
            assert_ne!(sent.0, 0, "forward must be answered promptly");
            assert_eq!(result, 1);
        }
        drop(windows);
        // After the export the windows are gone and an old App runs normally.
        let (class, title) = (wide("com.tarobot.client-sic".into()), wide("com.tarobot.client-siw".into()));
        assert!(unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) }.is_err());
    }

    /// An old Tauri App holds its single-instance mutex from setup onwards.
    #[test]
    fn a_running_old_tauri_app_is_detected_by_its_single_instance_mutex() {
        let name: Vec<u16> = "com.tarobot.client-sim".encode_utf16().chain(Some(0)).collect();
        let held = unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }.unwrap();
        let result = guard::acquire().err();
        unsafe { let _ = CloseHandle(held); }
        assert_eq!(result, Some(guard::IN_USE));
    }
}
