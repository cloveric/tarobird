use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Weak};
use std::time::Instant;
use std::collections::HashMap;
use tokio::sync::{OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub host_id: String,
    pub conversation_id: String,
    pub message_id: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn valid_host(value: &str) -> bool {
    value.len() == 68 && value.starts_with("hub_")
        && value[4..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Target {
    pub fn validate(&self) -> Result<(), String> {
        if valid_host(&self.host_id) && valid_id(&self.conversation_id) && valid_id(&self.message_id) {
            Ok(())
        } else { Err("invalid_notification_target".into()) }
    }
    pub fn decode(value: &str) -> Option<Self> {
        if value.len() > 1024 { return None; }
        let target: Self = serde_json::from_str(value).ok()?;
        target.validate().ok()?;
        Some(target)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notice {
    pub id: String,
    pub host_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub title: String,
    pub body: String,
    pub kind: String,
    pub at: i64,
}
impl Notice {
    pub fn target(&self) -> Target {
        Target { host_id: self.host_id.clone(), conversation_id: self.conversation_id.clone(), message_id: self.message_id.clone() }
    }
    pub fn validate(&self) -> Result<(), String> {
        self.target().validate()?;
        if valid_id(&self.id) && self.title == "TaroCub" && self.body.encode_utf16().count() <= 200
            && ["answer", "action", "error"].contains(&self.kind.as_str()) && self.at >= 0 {
            Ok(())
        } else { Err("invalid_notification".into()) }
    }
    pub fn identifier(&self) -> String { format!("tarocub.{}.{}", self.host_id, self.id) }
    /// Native title and body. A local preview carries a 「conversation · Bot」 (or
    /// “…”) heading line; anything else keeps the product label as its title.
    pub fn display(&self) -> (String, String) {
        let mut lines = self.body.split('\n');
        if let (Some(heading), Some(detail), None) = (lines.next(), lines.next(), lines.next()) {
            let quoted = (heading.starts_with('「') && heading.contains('」')) || (heading.starts_with('“') && heading.contains('”'));
            if quoted && heading.chars().count() <= 80 && !detail.trim().is_empty() && !heading.chars().any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
                return (heading.to_string(), detail.to_string());
            }
        }
        ("TaroBird".to_string(), self.body.clone())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    #[serde(rename = "ageMs", serialize_with = "serialize_age")]
    activated_at: Instant,
    pub target: Target,
}
fn serialize_age<S: serde::Serializer>(at: &Instant, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_f64(at.elapsed().as_secs_f64() * 1000.0)
}

/// Only the most recent unconsumed user intent is retained. A late receipt for
/// an older click must never consume a newer one. No message body is retained.
#[derive(Default)]
pub struct Inbox { pending: Option<Action> }
impl Inbox {
    pub fn activate(&mut self, target: Target) -> Result<(), String> {
        target.validate()?;
        self.pending = Some(Action { id: uuid::Uuid::new_v4().to_string(), activated_at: Instant::now(), target });
        Ok(())
    }
    pub fn peek(&self) -> Option<Action> { self.pending.clone() }
    pub fn ack(&mut self, id: &str) {
        if self.pending.as_ref().is_some_and(|value| value.id == id) { self.pending = None; }
    }
    pub fn clear(&mut self, host: Option<&str>) {
        if host.is_none() || self.pending.as_ref().is_some_and(|value| Some(value.target.host_id.as_str()) == host) { self.pending = None; }
    }
}

pub struct Submission {
    pub id: String,
    host_id: String,
    cancelled: AtomicBool,
}
impl Submission { pub fn active(&self) -> bool { !self.cancelled.load(Ordering::Acquire) } }
pub struct Submissions { pending: Vec<Weak<Submission>>, document_id: String }
impl Default for Submissions {
    fn default() -> Self { Self { pending: Vec::new(), document_id: uuid::Uuid::new_v4().to_string() } }
}
impl Submissions {
    pub fn document_id(&self) -> String { self.document_id.clone() }
    pub fn new_document(&mut self) {
        self.clear(None);
        self.document_id = uuid::Uuid::new_v4().to_string();
    }
    pub fn admit_document(&mut self, document: &str, host_id: &str) -> Result<Arc<Submission>, String> {
        if document != self.document_id { return Err("native_notification_cancelled".into()); }
        self.admit(host_id)
    }
    pub fn clear_document(&mut self, document: &str, host: Option<&str>) -> Result<(), String> {
        if document != self.document_id { return Err("native_notification_cancelled".into()); }
        self.clear(host); Ok(())
    }
    fn admit(&mut self, host_id: &str) -> Result<Arc<Submission>, String> {
        self.pending.retain(|item| item.strong_count() > 0);
        if self.pending.len() >= 128 { return Err("native_notification_busy".into()); }
        let item = Arc::new(Submission { id: uuid::Uuid::new_v4().to_string(), host_id: host_id.into(), cancelled: AtomicBool::new(false) });
        self.pending.push(Arc::downgrade(&item)); Ok(item)
    }
    pub fn clear(&mut self, host: Option<&str>) {
        self.pending.retain(|weak| {
            let Some(item) = weak.upgrade() else { return false; };
            if host.is_none() || Some(item.host_id.as_str()) == host { item.cancelled.store(true, Ordering::Release); }
            true
        });
    }
}

/// Shared across WebView documents. Keep this permit through the actual OS
/// operation, including a blocking worker which has not started running yet.
#[derive(Default)]
pub struct Operations {
    global: Arc<tokio::sync::RwLock<()>>,
    hosts: std::sync::Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}
pub enum Operation {
    Host { _global: OwnedRwLockReadGuard<()>, _host: OwnedMutexGuard<()> },
    All { _global: OwnedRwLockWriteGuard<()> },
}
impl Operations {
    pub async fn acquire(&self, host: Option<&str>) -> Result<Operation, String> {
        let Some(host) = host else { return Ok(Operation::All { _global: self.global.clone().write_owned().await }); };
        let global = self.global.clone().read_owned().await;
        let lane = {
            let mut hosts = self.hosts.lock().map_err(|_| "notification_state_unavailable")?;
            hosts.retain(|_, weak| weak.strong_count() > 0);
            if let Some(lane) = hosts.get(host).and_then(Weak::upgrade) { lane }
            else {
                if hosts.len() >= 128 { return Err("native_notification_busy".into()); }
                let lane = Arc::new(tokio::sync::Mutex::new(())); hosts.insert(host.into(), Arc::downgrade(&lane)); lane
            }
        };
        Ok(Operation::Host { _global: global, _host: lane.lock_owned().await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(host: char, message: &str) -> Target {
        Target { host_id: format!("hub_{}", host.to_string().repeat(64)), conversation_id: "conversation".into(), message_id: message.into() }
    }
    #[test]
    fn notification_targets_survive_serialization_without_body() {
        let expected = target('a', "message_2");
        let json = serde_json::to_string(&expected).unwrap();
        assert_eq!(Target::decode(&json), Some(expected));
        assert!(!json.contains("body"));
    }
    #[test]
    fn rejects_unscoped_malformed_and_extra_targets() {
        assert!(Target::decode(r#"{"conversationId":"a","messageId":"b"}"#).is_none());
        for bad in ["", "../secret", "a?host=other", &"a".repeat(129)] {
            let mut item = target('a', "message"); item.conversation_id = bad.into();
            assert!(item.validate().is_err());
        }
        let mut extra = serde_json::to_value(target('a', "message")).unwrap(); extra["url"] = "https://example.com".into();
        assert!(Target::decode(&extra.to_string()).is_none());
        assert!(!valid_host(&format!("hub_{}", "g".repeat(64))));
    }
    #[test]
    fn late_ack_preserves_newest_click_and_duplicate_ack_is_safe() {
        let mut inbox = Inbox::default(); inbox.activate(target('a', "first")).unwrap();
        let first = inbox.peek().unwrap(); assert_eq!(inbox.peek(), Some(first.clone()));
        inbox.activate(target('b', "second")).unwrap(); inbox.ack(&first.id);
        let second = inbox.peek().unwrap(); assert_eq!(second.target, target('b', "second"));
        inbox.ack(&second.id); inbox.ack(&second.id); assert!(inbox.peek().is_none());
    }
    #[test]
    fn host_cleanup_is_scoped_and_invalid_callback_preserves_pending() {
        let mut inbox = Inbox::default(); inbox.activate(target('a', "first")).unwrap();
        let first = inbox.peek(); inbox.clear(Some(&target('b', "").host_id)); assert_eq!(inbox.peek(), first);
        let mut bad = target('a', "second"); bad.host_id.clear(); assert!(inbox.activate(bad).is_err());
        assert_eq!(inbox.peek(), first); inbox.clear(None); assert!(inbox.peek().is_none());
    }
    #[test]
    fn notification_identity_is_independent_across_hosts_and_messages() {
        let mut notice: Notice = serde_json::from_value(serde_json::json!({"id":"one","hostId":target('a', "").host_id,"conversationId":"chat","messageId":"message","title":"TaroCub","body":"new reply","kind":"answer","at":1})).unwrap();
        notice.validate().unwrap(); let first = notice.identifier();
        notice.id = "two".into(); assert_ne!(notice.identifier(), first);
        notice.id = "one".into(); notice.host_id = target('b', "").host_id; assert_ne!(notice.identifier(), first);
        notice.body = "😀".repeat(101); assert!(notice.validate().is_err());
    }
    #[test]
    fn preview_heading_becomes_the_native_title_and_other_bodies_keep_the_product_label() {
        let mut notice: Notice = serde_json::from_value(serde_json::json!({"id":"one","hostId":target('a', "").host_id,"conversationId":"chat","messageId":"message","title":"TaroCub","body":"「发布准备」 · CC1\n回复完成：已修复侧栏。","kind":"answer","at":1})).unwrap();
        assert_eq!(notice.display(), ("「发布准备」 · CC1".to_string(), "回复完成：已修复侧栏。".to_string()));
        notice.body = "“Release” · CC1\nReply complete: done.".into();
        assert_eq!(notice.display().0, "“Release” · CC1");
        for body in ["Bot 已完成回复，点按查看。", "first\nsecond", "「工作」\n ", "「工作」\n一\n二", "「工作\u{202e}」\n内容"] {
            notice.body = body.into();
            let (title, shown) = notice.display();
            assert_eq!((title.as_str(), shown.as_str()), ("TaroBird", body));
        }
    }
    #[test]
    fn clearing_a_host_cancels_only_its_inflight_submissions_and_does_not_cancel_a_later_one() {
        let mut sends = Submissions::default();
        let a = sends.admit("a").unwrap(); let b = sends.admit("b").unwrap();
        sends.clear(Some("a")); assert!(!a.active()); assert!(b.active());
        let new_a = sends.admit("a").unwrap(); assert!(new_a.active()); assert_ne!(a.id, new_a.id);
        sends.clear(None); assert!(!b.active()); assert!(!new_a.active());
    }
    #[test]
    fn reload_cancels_admitted_work_and_rejects_old_requests_first_polled_after_reload() {
        let mut sends = Submissions::default(); let old = sends.document_id();
        let admitted = sends.admit_document(&old, "a").unwrap();
        sends.new_document();
        assert!(!admitted.active());
        assert!(sends.admit_document(&old, "a").is_err());
        assert!(sends.admit_document(&old, "b").is_err());
        assert!(sends.clear_document(&old, None).is_err());
        let current = sends.document_id(); assert_ne!(current, old);
        assert!(sends.admit_document(&current, "a").unwrap().active());
    }
    #[tokio::test]
    async fn old_clear_keeps_new_document_sends_behind_its_actual_os_operation() {
        let operations = Operations::default(); let mut sends = Submissions::default();
        let old = sends.document_id();
        let held_clear = operations.acquire(Some("a")).await.unwrap();
        sends.clear_document(&old, Some("a")).unwrap(); sends.new_document();
        // Simulates a Windows blocking clear accepted before reload but not yet executed.
        assert!(tokio::time::timeout(std::time::Duration::from_millis(5), operations.acquire(Some("a"))).await.is_err());
        let other = operations.acquire(Some("b")).await.unwrap(); drop(other);
        drop(held_clear);
        let _new_send = operations.acquire(Some("a")).await.unwrap();
        assert!(sends.admit_document(&sends.document_id(), "a").unwrap().active());
        assert!(sends.clear_document(&old, Some("a")).is_err());
    }
    #[tokio::test]
    async fn global_clear_waits_for_hosts_and_blocks_later_sends_until_released() {
        let operations = Operations::default();
        let a = operations.acquire(Some("a")).await.unwrap(); let b = operations.acquire(Some("b")).await.unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(5), operations.acquire(None)).await.is_err());
        drop(a); drop(b);
        let all = operations.acquire(None).await.unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(5), operations.acquire(Some("b"))).await.is_err());
        drop(all); assert!(operations.acquire(Some("b")).await.is_ok());
    }
    #[test]
    fn slow_native_submissions_are_bounded_and_completed_slots_are_reclaimed() {
        let mut sends = Submissions::default();
        let items: Vec<_> = (0..128).map(|_| sends.admit("a").unwrap()).collect();
        assert!(sends.admit("a").is_err()); drop(items); assert!(sends.admit("a").is_ok());
    }
    #[test]
    fn protocol_fixture_deserializes_and_monotonic_click_age_is_serialized() {
        let notice: Notice = serde_json::from_str(include_str!("../../fixtures/desktop-notification.json")).unwrap();
        notice.validate().unwrap();
        let mut inbox = Inbox::default(); inbox.activate(notice.target()).unwrap();
        let action = serde_json::to_value(inbox.peek().unwrap()).unwrap();
        assert!(action["ageMs"].as_f64().unwrap() >= 0.0);
        assert!(action.get("activatedAt").is_none());
        assert_eq!(action["target"]["messageId"], "message");
    }
}
