//! Windows-only CI check of src-desktop-core's ControlJob (included read-only):
//! closing the job retires the Host-control CLI, while a process that CLI
//! started (the detached canonical Host) keeps running. A control job without
//! SILENT_BREAKAWAY_OK must kill that descendant, proving the test can tell
//! the difference. Compiled on the Mac; never run there.
#![cfg(windows)]
#[path = "../../src-desktop-core/src/control_job.rs"]
mod control_job;
use std::{io::Write, os::windows::io::AsRawHandle, path::PathBuf, process::{Child, Command, Stdio}, time::{Duration, Instant}};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
        Threading::{GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE}},
};

/// Like the Host CLI: block on stdin, then start a long-lived process with
/// ordinary creation flags and keep running.
fn control_cli(dir: &PathBuf) -> (Child, PathBuf) {
    let pid = dir.join("descendant.pid");
    let script = format!(
        "$null = [Console]::In.ReadLine(); $p = Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; Set-Content -Path '{}' -Value $p.Id; Start-Sleep -Seconds 120",
        pid.display());
    let child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    (child, pid)
}
fn release(child: &mut Child, pid: &PathBuf) -> u32 {
    child.stdin.take().unwrap().write_all(b"go\r\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(value) = std::fs::read_to_string(pid).ok().and_then(|text| text.trim().parse().ok()) { return value; }
        assert!(Instant::now() < deadline, "the CLI never started its descendant");
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn alive(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return false; }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == 259 // STILL_ACTIVE
    }
}
fn kill(pid: u32) {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() { TerminateProcess(handle, 1); CloseHandle(handle); }
    }
}
fn exited(child: &mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() { return true; }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tarobot-control-job-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn closing_the_control_job_retires_the_cli_and_spares_its_detached_descendant() {
    let dir = scratch("owned");
    let (mut cli, pid) = control_cli(&dir);
    let job = control_job::ControlJob::assign(cli.as_raw_handle()).expect("assign");
    let descendant = release(&mut cli, &pid);
    drop(job); // the helper's handle closes, exactly as when the helper dies
    let cli_retired = exited(&mut cli);
    let survived = alive(descendant);
    kill(descendant); let _ = cli.kill();
    assert!(cli_retired, "the control CLI must end with its job");
    assert!(survived, "a process the CLI started (the canonical Host) must survive");
    let _ = std::fs::remove_dir_all(dir);
}

/// Control: without silent breakaway the descendant is inside the job and dies.
#[test]
fn a_job_without_silent_breakaway_would_kill_the_canonical_host() {
    let dir = scratch("control");
    let (mut cli, pid) = control_cli(&dir);
    let job: HANDLE = unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!job.is_null());
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        assert_ne!(SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32), 0);
        assert_ne!(AssignProcessToJobObject(job, cli.as_raw_handle()), 0);
        job
    };
    let descendant = release(&mut cli, &pid);
    unsafe { CloseHandle(job); }
    let cli_retired = exited(&mut cli);
    std::thread::sleep(Duration::from_millis(500));
    let survived = alive(descendant);
    kill(descendant); let _ = cli.kill();
    assert!(cli_retired);
    assert!(!survived, "control group: the scenario must be able to detect a killed Host");
    let _ = std::fs::remove_dir_all(dir);
}
