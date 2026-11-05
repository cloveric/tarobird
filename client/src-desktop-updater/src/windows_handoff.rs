//! Windows: start the verified NSIS installer only after Electron main has
//! exited, as the Tauri updater did by exiting right after launching it.
//! Arguments match tauri-plugin-updater's passive NSIS update: `/P /UPDATE /R`.
use std::{os::windows::process::CommandExt, path::Path, process::Stdio, time::Duration};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    },
};

const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
pub const INSTALLER_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// Handle to the Electron main process, opened at startup so a reused PID
/// can never be mistaken for it later.
pub struct Parent(HANDLE);
unsafe impl Send for Parent {}
impl Drop for Parent {
    fn drop(&mut self) {
        unsafe { let _ = CloseHandle(self.0); }
    }
}

fn parent_pid() -> Option<u32> {
    let own = std::process::id();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        let mut next = Process32FirstW(snapshot, &mut entry).is_ok();
        while next {
            if entry.th32ProcessID == own {
                found = Some(entry.th32ParentProcessID);
                break;
            }
            next = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

pub fn parent() -> Option<Parent> {
    let pid = parent_pid()?;
    unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).ok().map(Parent) }
}

/// Waits (bounded) for Electron to exit, then starts the installer outside
/// any job of ours. Its Restart Manager check handles a slow shutdown.
pub fn launch(installer: &Path, parent: Option<Parent>) -> bool {
    if let Some(parent) = parent.as_ref() {
        unsafe { let _ = WaitForSingleObject(parent.0, Duration::from_secs(30).as_millis() as u32); }
    }
    let start = |flags: u32| {
        std::process::Command::new(installer)
            .args(INSTALLER_ARGS)
            .creation_flags(flags)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    start(base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| start(base)).is_ok()
}
