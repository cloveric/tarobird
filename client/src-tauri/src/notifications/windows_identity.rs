//! Protocol-only toasts need an installed Start Menu shortcut with our AUMID
//! and a stub CLSID. No COM server or LocalServer32 entry is registered.
use super::{windows::Apartment, windows_payload::APP_ID};
use std::{ffi::OsString, io::Read, os::windows::ffi::OsStringExt, path::{Path, PathBuf}};
use windows::{core::{BSTR, GUID, HSTRING, Interface}, Win32::{
    Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID},
    System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ, STGM_READWRITE,
        StructuredStorage::{InitPropVariantFromCLSID, PropVariantToGUID, PROPVARIANT}},
    UI::Shell::{IShellLinkW, ShellLink, PropertiesSystem::IPropertyStore},
}};

const STUB_CLSID: GUID = GUID::from_u128(0x5e8c5c51_d485_4c46_b76a_02547bcd6776);
const RECEIPT: &str = "tarocub-notification-shortcut.json";
fn receipt_path() -> Result<PathBuf, String> {
    Ok(std::env::current_exe().map_err(|_| "native_notification_install_required")?.with_file_name(RECEIPT))
}
fn shortcut(path: &Path, write: bool) -> Result<(IPersistFile, IPropertyStore), String> {
    if !path.is_absolute() || !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("lnk")) {
        return Err("native_notification_install_required".into());
    }
    // Load only an existing link, then verify ownership before any mutation.
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.map_err(|_| "native_notification_install_required")?;
    let persist: IPersistFile = link.cast().map_err(|_| "native_notification_install_required")?;
    unsafe { persist.Load(&HSTRING::from(path.as_os_str()), if write { STGM_READWRITE } else { STGM_READ }) }.map_err(|_| "native_notification_install_required")?;
    let mut target = vec![0u16; 32768];
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), 0) }.map_err(|_| "native_notification_install_required")?;
    let end = target.iter().position(|ch| *ch == 0).ok_or("native_notification_install_required")?;
    let target = std::fs::canonicalize(PathBuf::from(OsString::from_wide(&target[..end]))).map_err(|_| "native_notification_install_required")?;
    let exe = std::fs::canonicalize(std::env::current_exe().map_err(|_| "native_notification_install_required")?).map_err(|_| "native_notification_install_required")?;
    if target != exe { return Err("native_notification_install_required".into()); }
    let properties = link.cast().map_err(|_| "native_notification_install_required")?;
    Ok((persist, properties))
}
fn verify_shortcut(path: &Path) -> Result<(), String> {
    let (_persist, properties) = shortcut(path, false)?;
    let id = unsafe { properties.GetValue(&PKEY_AppUserModel_ID) }.map_err(|_| "native_notification_install_required")?;
    let id = BSTR::try_from(&id).map_err(|_| "native_notification_install_required")?;
    let clsid = unsafe { properties.GetValue(&PKEY_AppUserModel_ToastActivatorCLSID) }.map_err(|_| "native_notification_install_required")?;
    let clsid = unsafe { PropVariantToGUID(&clsid) }.map_err(|_| "native_notification_install_required")?;
    if id.to_string() != APP_ID || clsid != STUB_CLSID { return Err("native_notification_install_required".into()); }
    Ok(())
}
pub fn verify_installed() -> Result<(), String> {
    let file = std::fs::File::open(receipt_path()?).map_err(|_| "native_notification_install_required")?;
    let mut data = Vec::new(); file.take(32769).read_to_end(&mut data).map_err(|_| "native_notification_install_required")?;
    if data.len() > 32768 { return Err("native_notification_install_required".into()); }
    let path: PathBuf = serde_json::from_slice(&data).map_err(|_| "native_notification_install_required")?;
    verify_shortcut(&path)
}
fn register(path: &Path) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let (persist, properties) = shortcut(path, true)?;
    let id = PROPVARIANT::from(APP_ID);
    let clsid = unsafe { InitPropVariantFromCLSID(&STUB_CLSID) }.map_err(|_| "native_notification_registration_failed")?;
    unsafe {
        properties.SetValue(&PKEY_AppUserModel_ID, &id)
            .and_then(|_| properties.SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &clsid))
            .and_then(|_| properties.Commit())
            .and_then(|_| persist.Save(&HSTRING::from(path.as_os_str()), true))
    }.map_err(|_| "native_notification_registration_failed")?;
    drop(properties); drop(persist);
    verify_shortcut(path)?;
    let data = serde_json::to_vec(path).map_err(|_| "native_notification_registration_failed")?;
    std::fs::write(receipt_path()?, data).map_err(|_| "native_notification_registration_failed")?;
    verify_installed()
}
/// Run before Tauri/single-instance initialization: an installer registration
/// must exit with a result instead of being forwarded to an already running UI.
pub fn installer_command() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "--clear-notification-history") {
        return Some(if args.len() == 2 && super::windows::clear(None).is_ok() { 0 } else { 1 });
    }
    if args.get(1).is_none_or(|arg| arg != "--register-notification-shortcut") { return None; }
    Some(if args.len() == 3 && register(Path::new(&args[2])).is_ok() { 0 } else { 1 })
}
