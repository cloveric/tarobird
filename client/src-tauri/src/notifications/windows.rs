use super::{state::{Notice, Submission}, windows_identity, windows_payload::{self, APP_ID}};
use std::sync::Arc;
use windows::{core::HSTRING, Data::Xml::Dom::XmlDocument, Foundation::Metadata::ApiInformation,
    UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager, ToastNotifier},
    Win32::{Foundation::RPC_E_CHANGED_MODE, System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED}}};

/// WinRT objects never escape the blocking worker or outlive its apartment.
pub(super) struct Apartment(bool);
impl Apartment {
    pub fn enter() -> Result<Self, String> {
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self(true)),
            Err(error) if error.code() == RPC_E_CHANGED_MODE => Ok(Self(false)),
            Err(_) => Err("native_notification_unavailable".into()),
        }
    }
}
impl Drop for Apartment { fn drop(&mut self) { if self.0 { unsafe { RoUninitialize(); } } } }
fn notifier() -> Result<ToastNotifier, String> {
    // 15063 / UniversalApiContract v4 is the first version allowing 64-char groups.
    if !ApiInformation::IsApiContractPresentByMajor(&HSTRING::from("Windows.Foundation.UniversalApiContract"), 4)
        .map_err(|_| "native_notification_unavailable")? { return Err("native_notification_windows_version".into()); }
    windows_identity::verify_installed()?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID)).map_err(|_| "native_notification_unavailable".into())
}
fn allowed(notifier: &ToastNotifier) -> Result<bool, String> {
    Ok(notifier.Setting().map_err(|_| "native_notification_permission_failed")? == NotificationSetting::Enabled)
}
pub fn permission() -> Result<String, String> {
    let _apartment = Apartment::enter()?;
    Ok(if allowed(&notifier()?)? { "granted" } else { "denied" }.into())
}
pub fn send(notice: Notice, submission: Arc<Submission>) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let notifier = notifier()?;
    if !allowed(&notifier)? { return Err("native_notification_permission_denied".into()); }
    let xml = XmlDocument::new().map_err(|_| "native_notification_delivery_failed")?;
    xml.LoadXml(&HSTRING::from(windows_payload::toast_xml(&notice)?)).map_err(|_| "native_notification_delivery_failed")?;
    let toast = ToastNotification::CreateToastNotification(&xml).map_err(|_| "native_notification_delivery_failed")?;
    let tag = HSTRING::from(&submission.id); let group = HSTRING::from(windows_payload::host_group(&notice.host_id)?);
    toast.SetTag(&tag).and_then(|_| toast.SetGroup(&group)).map_err(|_| "native_notification_delivery_failed")?;
    if !submission.active() { return Err("native_notification_cancelled".into()); }
    notifier.Show(&toast).map_err(|_| "native_notification_delivery_failed")?;
    if !submission.active() {
        // A clear can race Show; remove only this unique submission, never its replacement.
        ToastNotificationManager::History().and_then(|history| history.RemoveGroupedTagWithId(&tag, &group, &HSTRING::from(APP_ID)))
            .map_err(|_| "native_notification_clear_failed")?;
        return Err("native_notification_cancelled".into());
    }
    Ok(())
}
pub fn clear(host: Option<String>) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    // History uses our explicit AUMID even if the shortcut was subsequently
    // removed. Do not strand delivered private notices behind an install check.
    let history = ToastNotificationManager::History().map_err(|_| "native_notification_clear_failed")?;
    match host {
        Some(host) => history.RemoveGroupWithId(&HSTRING::from(windows_payload::host_group(&host)?), &HSTRING::from(APP_ID)),
        None => history.ClearWithId(&HSTRING::from(APP_ID)),
    }.map_err(|_| "native_notification_clear_failed".into())
}
