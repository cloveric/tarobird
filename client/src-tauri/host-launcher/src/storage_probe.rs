//! Read-only Windows storage probe, shared by the packaged Host and native shell.
//! No environment-derived AppData, package-name assumptions or shell execution.
#[path = "../../shared/native_identity.rs"]
mod native_identity;
pub use native_identity::probe_failure;
use std::{ffi::c_void, path::{Path, PathBuf}, os::windows::ffi::OsStrExt};
use serde_json::{json, Value};
type Handle = *mut c_void;
#[repr(C)] struct Guid { a: u32, b: u16, c: u16, d: [u8; 8] }
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn GetPackageFamilyName(process: Handle, size: *mut u32, name: *mut u16) -> i32;
    fn CreateFileW(name: *const u16, access: u32, share: u32, security: Handle, creation: u32, flags: u32, template: Handle) -> Handle;
    fn GetFinalPathNameByHandleW(handle: Handle, name: *mut u16, size: u32, flags: u32) -> u32;
}
#[link(name = "shell32")]
extern "system" { fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Handle, path: *mut *mut u16) -> i32; }
#[link(name = "ole32")]
extern "system" { fn CoTaskMemFree(memory: *mut c_void); }
struct Owned(Handle);
impl Drop for Owned { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
fn known_folder(id: Guid) -> Result<PathBuf, String> {
    let mut result = std::ptr::null_mut();
    // NO_PACKAGE_REDIRECTION | DONT_VERIFY; never CREATE.
    if unsafe { SHGetKnownFolderPath(&id, 0x14000, std::ptr::null_mut(), &mut result) } < 0 || result.is_null() {
        return Err("host_directory_probe_failed".into());
    }
    let value = unsafe {
        let mut length = 0;
        while length < 32768 && *result.add(length) != 0 { length += 1; }
        let value = if length == 32768 { Err("host_directory_probe_failed".into()) }
            else { String::from_utf16(std::slice::from_raw_parts(result, length)).map(PathBuf::from).map_err(|_| "host_directory_probe_failed".into()) };
        CoTaskMemFree(result.cast()); value
    };
    value
}
pub fn package_family(pid: u32) -> Result<Option<String>, String> {
    let handle = unsafe { OpenProcess(0x1000, 0, pid) };
    if handle.is_null() { return Err("host_directory_probe_failed".into()); }
    let handle = Owned(handle);
    let mut size = 0;
    let code = unsafe { GetPackageFamilyName(handle.0, &mut size, std::ptr::null_mut()) };
    if code == 15700 { return Ok(None); } // APPMODEL_ERROR_NO_PACKAGE
    if code != 122 || size < 2 || size > 4096 { return Err("host_directory_probe_failed".into()); }
    let mut buffer = vec![0; size as usize];
    if unsafe { GetPackageFamilyName(handle.0, &mut size, buffer.as_mut_ptr()) } != 0 || size < 2 || size as usize > buffer.len() {
        return Err("host_directory_probe_failed".into());
    }
    String::from_utf16(&buffer[..size as usize - 1]).map(Some).map_err(|_| "host_directory_probe_failed".into())
}
fn physical(path: &Path) -> Result<Option<PathBuf>, String> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) || wide.len() > 32760 { return Err("host_directory_probe_failed".into()); } wide.push(0);
    // Attributes only, share read/write/delete; OPEN_EXISTING + BACKUP_SEMANTICS.
    let raw = unsafe { CreateFileW(wide.as_ptr(), 0, 7, std::ptr::null_mut(), 3, 0x02000000, std::ptr::null_mut()) };
    if raw as isize == -1 {
        return match std::io::Error::last_os_error().raw_os_error() { Some(2 | 3) => Ok(None), _ => Err("host_directory_probe_failed".into()) };
    }
    let handle = Owned(raw); let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetFinalPathNameByHandleW(handle.0, buffer.as_mut_ptr(), buffer.len() as u32, 0) } as usize;
    if length == 0 || length >= buffer.len() { return Err("host_directory_probe_failed".into()); }
    String::from_utf16(&buffer[..length]).map(PathBuf::from).map(Some).map_err(|_| "host_directory_probe_failed".into())
}
fn nearest(path: &Path) -> Result<PathBuf, String> {
    let mut cursor = path.to_path_buf(); let mut tail = Vec::new();
    for _ in 0..256 {
        if let Some(mut found) = physical(&cursor)? { for name in tail.iter().rev() { found.push(name); } return Ok(found); }
        tail.push(cursor.file_name().ok_or("host_directory_probe_failed")?.to_os_string());
        cursor = cursor.parent().ok_or("host_directory_probe_failed")?.to_path_buf();
    }
    Err("host_directory_probe_failed".into())
}
pub fn inspect(selected: Option<&Path>, caller: u32) -> Result<Value, String> {
    if selected.is_some_and(|p| !p.is_absolute()) || caller == 0 { return Err("host_directory_probe_failed".into()); }
    let roaming = known_folder(Guid {a:0x3eb685db,b:0x65f9,c:0x4cf6,d:[0xa0,0x3a,0xe3,0xef,0x65,0x72,0x9f,0x3d]})?;
    let local = known_folder(Guid {a:0xf1b32785,b:0x6fba,c:0x4fcf,d:[0x9d,0x55,0x7b,0x8e,0x7f,0x15,0x70,0x91]})?;
    let profile = known_folder(Guid {a:0x5e6c858f,b:0x0e22,c:0x4760,d:[0x9a,0xfe,0xea,0x33,0x17,0xb6,0x71,0x73]})?;
    let default_directory = if selected.is_none() { native_identity::host_directory(&roaming)? } else { roaming.join(native_identity::APP_ID).join("host") };
    let directory = selected.unwrap_or(&default_directory);
    Ok(json!({"protocol":"TAROBOT_WINDOWS_STATE_PROBE_V1","version":1,"requestedDirectory":directory,"packageFamily":package_family(caller)?,"helperPackageFamily":package_family(std::process::id())?,
        "roaming":roaming,"local":local,"profile":profile,"directory":nearest(directory)?,
        "identity":physical(&directory.join("identity.json"))?,"database":physical(&directory.join("hub.sqlite"))?,"config":physical(&directory.join("config.json"))?}))
}
