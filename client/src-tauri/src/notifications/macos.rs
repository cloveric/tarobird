use super::{state::{Notice, Submission, Target}, Notifications};
use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, runtime::{Bool, ProtocolObject}, AnyThread, DefinedClass};
use objc2_foundation::{ns_string, NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::*;
use std::{cell::RefCell, ptr::NonNull, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::Duration};
use tokio::sync::oneshot;

static READY: AtomicBool = AtomicBool::new(false);
struct ClearLifetime(Arc<AtomicBool>);
impl Drop for ClearLifetime { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }
thread_local! { static DELEGATE: RefCell<Option<Retained<Delegate>>> = const { RefCell::new(None) }; }

define_class!(
    // NSObject has no subclassing requirements. The only ivar is thread-safe
    // Rust state; Apple may invoke these methods on its own serial queue.
    #[unsafe(super = NSObject)]
    #[name = "TaroCubNotificationDelegate"]
    #[ivars = Arc<Notifications>]
    struct Delegate;
    unsafe impl NSObjectProtocol for Delegate {}
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn response(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
            // Dismissal and any unknown action must not navigate. Always finish
            // the OS callback, including malformed/older notification payloads.
            if &*response.actionIdentifier() == unsafe { UNNotificationDefaultActionIdentifier } {
                if let Some(target) = target_from_content(&response.notification().request().content()) {
                    self.ivars().activate(target);
                } else { self.ivars().focus(); }
            }
            done.call(());
        }
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            // The Hub connection already suppresses notices while the chat app
            // is focused and applies per-host mute and quiet-hour preferences.
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }
    }
);

pub fn initialize(state: Arc<Notifications>) {
    // UNUserNotificationCenter throws for unbundled command-line executables.
    // Never impersonate Terminal/Finder; the production bundle owns permissions.
    let bundle = NSBundle::mainBundle();
    if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") { return; }
    DELEGATE.with(|slot| {
        if slot.borrow().is_some() { return; }
        let allocated = Delegate::alloc().set_ivars(state);
        let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // Apple's delegate property is weak; retain it for the process lifetime.
        *slot.borrow_mut() = Some(delegate);
        READY.store(true, Ordering::Release);
    });
}
fn center() -> Result<Retained<UNUserNotificationCenter>, String> {
    if !READY.load(Ordering::Acquire) { return Err("native_notification_bundle_required".into()); }
    Ok(UNUserNotificationCenter::currentNotificationCenter())
}
async fn wait<T>(receiver: oneshot::Receiver<T>, seconds: u64) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(seconds), receiver).await
        .map_err(|_| "native_notification_timeout")?.map_err(|_| "native_notification_unavailable".into())
}
fn settle<T>(sender: &Mutex<Option<oneshot::Sender<T>>>, value: T) {
    if let Ok(mut sender) = sender.lock() { if let Some(sender) = sender.take() { let _ = sender.send(value); } }
}
pub async fn permission(request: bool) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    {
        let center = center()?;
        let sender = Mutex::new(Some(sender));
        if request {
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Badge | UNAuthorizationOptions::Sound,
                &RcBlock::new(move |granted: Bool, error: *mut NSError| {
                    settle(&sender, if !error.is_null() { Err("native_notification_permission_failed".to_string()) }
                        else { Ok(if granted.as_bool() { "granted" } else { "denied" }.to_string()) });
                }),
            );
        } else {
            center.getNotificationSettingsWithCompletionHandler(&RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let permission = match status {
                    UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Provisional => "granted",
                    UNAuthorizationStatus::NotDetermined => "prompt",
                    _ => "denied",
                };
                settle(&sender, Ok(permission.to_string()));
            }));
        }
    }
    wait(receiver, if request { 60 } else { 8 }).await?
}

fn content(notice: &Notice) -> Result<Retained<UNMutableNotificationContent>, String> {
    let content = UNMutableNotificationContent::new();
    // Keep the validated legacy wire identifier separate from the product label.
    // A local preview's conversation heading becomes the title.
    let (title, body) = notice.display();
    content.setTitle(&NSString::from_str(&title));
    content.setBody(&NSString::from_str(&body));
    // Without an explicit sound the banner is delivered silently. The user's
    // System Settings sound choice for TaroBird still applies.
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let json = serde_json::to_string(&notice.target()).map_err(|_| "invalid_notification_target")?;
    let json = NSString::from_str(&json);
    let info = NSDictionary::from_slices(&[ns_string!("tarocub.route.v1")], &[&*json]);
    // Both key and value are immutable property-list NSString objects.
    unsafe { content.setUserInfo(&info.cast_unchecked()); }
    Ok(content)
}
fn target_from_content(content: &UNNotificationContent) -> Option<Target> {
    let json = content.userInfo().objectForKey(ns_string!("tarocub.route.v1"))?.downcast::<NSString>().ok()?;
    if json.length() > 1024 { return None; }
    Target::decode(&json.to_string())
}
fn remove_identifier(identifier: &str) {
    let identifiers = NSArray::from_retained_slice(&[NSString::from_str(identifier)]);
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.removePendingNotificationRequestsWithIdentifiers(&identifiers);
    center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
}
pub async fn send(notice: Notice, submission: Arc<Submission>) -> Result<(), String> {
    // Only explicit settings interaction may show a permission prompt.
    if permission(false).await? != "granted" { return Err("native_notification_permission_denied".into()); }
    if !submission.active() { return Err("native_notification_cancelled".into()); }
    let (sender, receiver) = oneshot::channel();
    {
        let center = center()?;
        let content = content(&notice)?;
        // A cancelled old submission must not delete a new reminder with the
        // same Hub/message ID after the host has been paired again.
        let identifier = format!("{}.{}", notice.identifier(), submission.id);
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&identifier), &content, None);
        let sender = Mutex::new(Some(sender));
        center.addNotificationRequest_withCompletionHandler(&request, Some(&RcBlock::new(move |error: *mut NSError| {
            // The completion can arrive after JS disposal or our IPC timeout.
            // Keep the cancellation fence in the OS callback itself.
            if !submission.active() { remove_identifier(&identifier); settle(&sender, Err("native_notification_cancelled".to_string())); }
            else { settle(&sender, if error.is_null() { Ok(()) } else { Err("native_notification_delivery_failed".to_string()) }); }
        })));
    }
    wait(receiver, 10).await?
}
pub async fn clear(host: Option<String>) -> Result<(), String> {
    // Unbundled development/test processes cannot have submitted a notice.
    // Local identity/host cleanup must remain usable in that environment.
    if !READY.load(Ordering::Acquire) { return Ok(()); }
    // A query callback arriving after timeout must not inspect/delete notices
    // from a later document whose native operation permit is now available.
    let lifetime = ClearLifetime(Arc::new(AtomicBool::new(true)));
    // Remove pending first, then delivered: a request can become delivered
    // between the two reads, and must not fall into the gap in the other order.
    if let Some(host) = &host {
        let (sender, receiver) = oneshot::channel();
        {
            let center = center()?; let prefix = format!("tarocub.{host}."); let sender = Mutex::new(Some(sender));
            let active = lifetime.0.clone();
            center.getPendingNotificationRequestsWithCompletionHandler(&RcBlock::new(move |items: NonNull<NSArray<UNNotificationRequest>>| {
                if !active.load(Ordering::Acquire) { settle(&sender, ()); return; }
                let ids: Vec<_> = unsafe { items.as_ref() }.iter().map(|item| item.identifier()).filter(|id| id.to_string().starts_with(&prefix)).collect();
                UNUserNotificationCenter::currentNotificationCenter().removePendingNotificationRequestsWithIdentifiers(&NSArray::from_retained_slice(&ids));
                settle(&sender, ());
            }));
        }
        wait(receiver, 8).await?;
    }
    let (sender, receiver) = oneshot::channel();
    {
        let center = center()?;
        if host.is_none() { center.removeAllPendingNotificationRequests(); center.removeAllDeliveredNotifications(); return Ok(()); }
        let prefix = format!("tarocub.{}.", host.unwrap());
        let sender = Mutex::new(Some(sender));
        let active = lifetime.0.clone();
        center.getDeliveredNotificationsWithCompletionHandler(&RcBlock::new(move |items: NonNull<NSArray<UNNotification>>| {
            if !active.load(Ordering::Acquire) { settle(&sender, ()); return; }
            let ids: Vec<_> = unsafe { items.as_ref() }.iter().map(|item| item.request().identifier())
                .filter(|id| id.to_string().starts_with(&prefix)).collect();
            UNUserNotificationCenter::currentNotificationCenter().removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&ids));
            settle(&sender, ());
        }));
    }
    wait(receiver, 8).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::NSCopying;
    #[test]
    fn actual_foundation_content_roundtrip_preserves_host_and_message() {
        let notice: Notice = serde_json::from_value(serde_json::json!({"id":"one","hostId":format!("hub_{}", "a".repeat(64)),"conversationId":"chat","messageId":"message","title":"TaroCub","body":"收到新回复","kind":"answer","at":1})).unwrap();
        let plain = content(&notice).unwrap();
        assert_eq!(target_from_content(&plain), Some(notice.target()));
        assert_eq!(plain.title().to_string(), "TaroBird");
        assert_eq!(plain.body().to_string(), "收到新回复");
        assert!(plain.sound().is_some());
        let copy = plain.copy(); assert_eq!(target_from_content(&copy), Some(notice.target()));
        let preview: Notice = serde_json::from_value(serde_json::json!({"id":"one","hostId":format!("hub_{}", "a".repeat(64)),"conversationId":"chat","messageId":"message","title":"TaroCub","body":"「发布准备」 · CC1\n回复完成：已修复侧栏。","kind":"answer","at":1})).unwrap();
        let headed = content(&preview).unwrap();
        assert_eq!(headed.title().to_string(), "「发布准备」 · CC1");
        assert_eq!(headed.body().to_string(), "回复完成：已修复侧栏。");
    }
    #[test]
    fn old_or_missing_native_user_info_does_not_navigate() {
        assert!(target_from_content(&UNMutableNotificationContent::new()).is_none());
    }
    #[tokio::test]
    async fn unbundled_cleanup_does_not_block_identity_removal_or_request_permission() {
        assert!(!READY.load(Ordering::Acquire));
        clear(None).await.unwrap();
        clear(Some(format!("hub_{}", "a".repeat(64)))).await.unwrap();
        assert_eq!(permission(false).await.unwrap_err(), "native_notification_bundle_required");
    }
}
