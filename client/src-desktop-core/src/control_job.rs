//! Own exactly one transient Host-control CLI, never the canonical Host.
//! A helper crash closes this non-inheritable handle and retires the CLI.
use std::{io, mem, os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle}};
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK};

pub struct ControlJob { _handle: OwnedHandle }
impl ControlJob {
    pub fn assign(process: RawHandle) -> io::Result<Self> {
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() { return Err(io::Error::last_os_error()); }
            let handle = OwnedHandle::from_raw_handle(raw);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            // The detached canonical Host must escape this job. Without silent
            // breakaway, closing the helper would also kill the Host it started.
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            if SetInformationJobObject(handle.as_raw_handle(), JobObjectExtendedLimitInformation, (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(handle.as_raw_handle(), process) == 0 { return Err(io::Error::last_os_error()); }
            Ok(Self { _handle: handle })
        }
    }
}
