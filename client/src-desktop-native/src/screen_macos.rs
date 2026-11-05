//! Remote screen: macOS system input, display identity and login-session state.
//! Runs inside the signed App's main process so Accessibility belongs to the App.
//! Event construction (`*_event`) is separate from posting so tests can build
//! and read events back without ever touching the user's session.
use std::collections::BTreeSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};

type CFTypeRef = *const c_void;
type CGEventRef = *mut c_void;
type CGEventSourceRef = *mut c_void;
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CGPoint { pub x: f64, pub y: f64 }

// Getters are used by read-back tests and the local-takeover classifier.
#[allow(dead_code)]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    fn CGEventCreate(source: CGEventSourceRef) -> CGEventRef;
    fn CGEventCreateMouseEvent(source: CGEventSourceRef, kind: u32, point: CGPoint, button: u32) -> CGEventRef;
    fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, key: u16, down: bool) -> CGEventRef;
    fn CGEventCreateScrollWheelEvent2(source: CGEventSourceRef, units: u32, count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> CGEventRef;
    fn CGEventSetType(event: CGEventRef, kind: u32);
    fn CGEventGetType(event: CGEventRef) -> u32;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventSetLocation(event: CGEventRef, point: CGPoint);
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    fn CGEventKeyboardGetUnicodeString(event: CGEventRef, max: usize, actual: *mut usize, string: *mut u16);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
}
#[link(name = "ColorSync", kind = "framework")]
unsafe extern "C" { fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFTypeRef; }
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: CFTypeRef);
    fn CFGetTypeID(value: CFTypeRef) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: CFTypeRef) -> bool;
    fn CFNumberGetTypeID() -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetValue(value: CFTypeRef, kind: i32, out: *mut c_void) -> bool;
    fn CFDictionaryGetValue(dictionary: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFTypeRef, string: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFStringGetCString(string: CFTypeRef, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    fn CFUUIDCreateString(alloc: CFTypeRef, uuid: CFTypeRef) -> CFTypeRef;
}

const UTF8: u32 = 0x0800_0100;
const PRIVATE_STATE: i32 = -1;
const HID_TAP: u32 = 0;
/// Stamped on every posted event (kCGEventSourceUserData) so a session tap can
/// tell this App's remote input from the person at the Mac.
pub const TAG: i64 = 0x7461_726f_6273; // "tarobs"
#[allow(dead_code)]
mod field { pub const CLICK_STATE: u32 = 1; pub const BUTTON_NUMBER: u32 = 3; pub const AUTOREPEAT: u32 = 8; pub const KEYCODE: u32 = 9;
  pub const USER_DATA: u32 = 42; pub const CONTINUOUS: u32 = 88; pub const POINT_DELTA1: u32 = 96; pub const POINT_DELTA2: u32 = 97; }
#[allow(dead_code)]
mod kind { pub const LEFT_DOWN: u32 = 1; pub const LEFT_UP: u32 = 2; pub const RIGHT_DOWN: u32 = 3; pub const RIGHT_UP: u32 = 4; pub const MOVED: u32 = 5;
  pub const LEFT_DRAGGED: u32 = 6; pub const RIGHT_DRAGGED: u32 = 7; pub const KEY_DOWN: u32 = 10; pub const KEY_UP: u32 = 11; pub const FLAGS_CHANGED: u32 = 12;
  pub const SCROLL: u32 = 22; pub const OTHER_DOWN: u32 = 25; pub const OTHER_UP: u32 = 26; pub const OTHER_DRAGGED: u32 = 27; }
const MAX_TEXT_UNITS: usize = 2048;
/// UniChar units per synthetic key event; longer strings are split (not inside a surrogate pair).
pub const TEXT_CHUNK: usize = 20;
const MODIFIER_KEYS: [u16; 8] = [0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e];

/// Owned CGEvent; released on drop.
pub struct Event(CGEventRef);
impl Drop for Event { fn drop(&mut self) { unsafe { CFRelease(self.0 as CFTypeRef) } } }
#[allow(dead_code)]
impl Event {
    pub fn kind(&self) -> u32 { unsafe { CGEventGetType(self.0) } }
    pub fn flags(&self) -> u64 { unsafe { CGEventGetFlags(self.0) } }
    pub fn location(&self) -> CGPoint { unsafe { CGEventGetLocation(self.0) } }
    pub fn field(&self, id: u32) -> i64 { unsafe { CGEventGetIntegerValueField(self.0, id) } }
    pub fn text(&self) -> Vec<u16> {
        let mut buffer = [0u16; TEXT_CHUNK]; let mut actual = 0usize;
        unsafe { CGEventKeyboardGetUnicodeString(self.0, buffer.len(), &mut actual, buffer.as_mut_ptr()) };
        buffer[..actual.min(TEXT_CHUNK)].to_vec()
    }
}
struct Source(CGEventSourceRef);
unsafe impl Send for Source {}
static SOURCE: Mutex<Option<Source>> = Mutex::new(None);
/// A private source keeps the remote modifiers independent of the physical keyboard.
fn source() -> Result<CGEventSourceRef, String> {
    let mut slot = SOURCE.lock().map_err(|_| "screen_input_failed")?;
    if slot.is_none() {
        let created = unsafe { CGEventSourceCreate(PRIVATE_STATE) };
        if created.is_null() { return Err("screen_input_unavailable".into()); }
        *slot = Some(Source(created));
    }
    Ok(slot.as_ref().map(|s| s.0).unwrap_or(std::ptr::null_mut()))
}
fn wrap(event: CGEventRef) -> Result<Event, String> {
    if event.is_null() { return Err("screen_input_unavailable".into()); }
    unsafe { CGEventSetIntegerValueField(event, field::USER_DATA, TAG) };
    Ok(Event(event))
}
fn finite(point: CGPoint) -> Result<CGPoint, String> {
    if point.x.is_finite() && point.y.is_finite() && point.x.abs() <= 100_000.0 && point.y.abs() <= 100_000.0 { Ok(point) } else { Err("screen_point_out_of_bounds".into()) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Button { Left, Right, Other }
impl Button {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "left" => Ok(Self::Left), "right" => Ok(Self::Right), "other" => Ok(Self::Other), _ => Err("screen_input_invalid".into()) }
    }
    fn number(self) -> u32 { match self { Self::Left => 0, Self::Right => 1, Self::Other => 2 } }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mouse { Move, Drag, Down, Up }
impl Mouse {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "move" => Ok(Self::Move), "drag" => Ok(Self::Drag), "down" => Ok(Self::Down), "up" => Ok(Self::Up), _ => Err("screen_input_invalid".into()) }
    }
}
fn mouse_kind(action: Mouse, button: Button) -> u32 {
    use Button::*;
    match (action, button) {
        (Mouse::Move, _) => kind::MOVED,
        (Mouse::Drag, Left) => kind::LEFT_DRAGGED, (Mouse::Drag, Right) => kind::RIGHT_DRAGGED, (Mouse::Drag, Other) => kind::OTHER_DRAGGED,
        (Mouse::Down, Left) => kind::LEFT_DOWN, (Mouse::Down, Right) => kind::RIGHT_DOWN, (Mouse::Down, Other) => kind::OTHER_DOWN,
        (Mouse::Up, Left) => kind::LEFT_UP, (Mouse::Up, Right) => kind::RIGHT_UP, (Mouse::Up, Other) => kind::OTHER_UP,
    }
}

pub fn mouse_event(action: Mouse, button: Button, point: CGPoint, clicks: i64, flags: u64) -> Result<Event, String> {
    let point = finite(point)?;
    if !(1..=3).contains(&clicks) { return Err("screen_input_invalid".into()); }
    let event = wrap(unsafe { CGEventCreateMouseEvent(source()?, mouse_kind(action, button), point, button.number()) })?;
    unsafe {
        CGEventSetIntegerValueField(event.0, field::BUTTON_NUMBER, button.number() as i64);
        if matches!(action, Mouse::Down | Mouse::Up) { CGEventSetIntegerValueField(event.0, field::CLICK_STATE, clicks); }
        CGEventSetFlags(event.0, flags);
    }
    Ok(event)
}
/// Pixel deltas; wheel1 > 0 scrolls up. Marked continuous like a trackpad.
pub fn scroll_event(point: CGPoint, wheel1: i32, wheel2: i32, flags: u64) -> Result<Event, String> {
    let point = finite(point)?;
    if wheel1.abs() > 2000 || wheel2.abs() > 2000 { return Err("screen_input_invalid".into()); }
    let event = wrap(unsafe { CGEventCreateScrollWheelEvent2(source()?, 0, 2, wheel1, wheel2, 0) })?;
    unsafe { CGEventSetLocation(event.0, point); CGEventSetIntegerValueField(event.0, field::CONTINUOUS, 1); CGEventSetFlags(event.0, flags); }
    Ok(event)
}
/// Modifier keys become FlagsChanged events, like hardware modifier presses.
pub fn key_event(keycode: u16, down: bool, flags: u64, modifier: bool, repeat: bool) -> Result<Event, String> {
    if keycode > 0x7f || modifier != MODIFIER_KEYS.contains(&keycode) { return Err("screen_input_invalid".into()); }
    let event = wrap(unsafe { CGEventCreateKeyboardEvent(source()?, keycode, down) })?;
    unsafe {
        if modifier { CGEventSetType(event.0, kind::FLAGS_CHANGED); }
        CGEventSetFlags(event.0, flags);
        if repeat && down && !modifier { CGEventSetIntegerValueField(event.0, field::AUTOREPEAT, 1); }
    }
    Ok(event)
}
/// Committed text as Unicode key events (down+up per chunk). No clipboard.
/// Line breaks and tabs become Return/Tab key presses, which every app accepts.
pub fn text_events(text: &str) -> Result<Vec<Event>, String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.is_empty() || units.len() > MAX_TEXT_UNITS || text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) { return Err("screen_input_invalid".into()); }
    let mut events = Vec::new();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut segment = String::new();
    let flush = |segment: &mut String, events: &mut Vec<Event>| -> Result<(), String> {
        let units: Vec<u16> = segment.encode_utf16().collect(); segment.clear();
        let mut start = 0;
        while start < units.len() {
            let mut end = (start + TEXT_CHUNK).min(units.len());
            if end < units.len() && (0xD800..0xDC00).contains(&units[end - 1]) { end -= 1; }
            for down in [true, false] {
                let event = wrap(unsafe { CGEventCreateKeyboardEvent(source()?, 0, down) })?;
                unsafe { CGEventSetFlags(event.0, 0); CGEventKeyboardSetUnicodeString(event.0, end - start, units[start..].as_ptr()); }
                events.push(event);
            }
            start = end;
        }
        Ok(())
    };
    for c in normalized.chars() {
        match c {
            '\n' | '\t' => { flush(&mut segment, &mut events)?; let key = if c == '\n' { 0x24 } else { 0x30 };
                events.push(key_event(key, true, 0, false, false)?); events.push(key_event(key, false, 0, false, false)?); }
            _ => segment.push(c),
        }
    }
    flush(&mut segment, &mut events)?;
    Ok(events)
}

/// What this process has pressed and not yet released. Independent of the JS
/// lease tracking, so a release still happens if that state is lost.
#[derive(Default)]
struct Pressed { keys: BTreeSet<u16>, buttons: BTreeSet<Button> }
static PRESSED: Mutex<Pressed> = Mutex::new(Pressed { keys: BTreeSet::new(), buttons: BTreeSet::new() });
static POSTED: AtomicU64 = AtomicU64::new(0);
fn post(event: &Event) { unsafe { CGEventPost(HID_TAP, event.0) }; POSTED.fetch_add(1, Ordering::Relaxed); }
fn track(update: impl FnOnce(&mut Pressed)) { if let Ok(mut pressed) = PRESSED.lock() { update(&mut pressed); } }

pub fn post_mouse(action: Mouse, button: Button, point: CGPoint, clicks: i64, flags: u64) -> Result<(), String> {
    let event = mouse_event(action, button, point, clicks, flags)?;
    post(&event);
    match action { Mouse::Down => track(|p| { p.buttons.insert(button); }), Mouse::Up => track(|p| { p.buttons.remove(&button); }), _ => {} }
    Ok(())
}
pub fn post_scroll(point: CGPoint, wheel1: i32, wheel2: i32, flags: u64) -> Result<(), String> { post(&scroll_event(point, wheel1, wheel2, flags)?); Ok(()) }
pub fn post_key(keycode: u16, down: bool, flags: u64, modifier: bool, repeat: bool) -> Result<(), String> {
    post(&key_event(keycode, down, flags, modifier, repeat)?);
    track(|p| { if down { p.keys.insert(keycode); } else { p.keys.remove(&keycode); } });
    Ok(())
}
pub fn post_text(text: &str) -> Result<(), String> { for event in text_events(text)? { post(&event); } Ok(()) }
pub fn cursor() -> CGPoint {
    let event = unsafe { CGEventCreate(std::ptr::null_mut()) };
    if event.is_null() { return CGPoint { x: 0.0, y: 0.0 }; }
    let event = Event(event); event.location()
}
/// Releases every key and button this process still holds, plus a final
/// FlagsChanged with no flags. Used on lease end and after an unclean exit.
pub fn release_all() -> Result<u32, String> {
    let (keys, buttons) = { let mut p = PRESSED.lock().map_err(|_| "screen_input_failed")?; (std::mem::take(&mut p.keys), std::mem::take(&mut p.buttons)) };
    let mut posted = 0;
    for key in keys.iter().filter(|k| !MODIFIER_KEYS.contains(k)) { post(&key_event(*key, false, 0, false, false)?); posted += 1; }
    for key in keys.iter().filter(|k| MODIFIER_KEYS.contains(k)) { post(&key_event(*key, false, 0, true, false)?); posted += 1; }
    if !buttons.is_empty() { let point = cursor(); for button in buttons { post(&mouse_event(Mouse::Up, button, point, 1, 0)?); posted += 1; } }
    Ok(posted)
}
/// After a crash during control: clear modifier state and lift every button.
pub fn release_stale() -> Result<(), String> {
    for key in MODIFIER_KEYS { post(&key_event(key, false, 0, true, false)?); }
    let point = cursor();
    for button in [Button::Left, Button::Right, Button::Other] { post(&mouse_event(Mouse::Up, button, point, 1, 0)?); }
    Ok(())
}

/// True when a seen event was not produced by this App (local person at the Mac).
pub fn foreign(event_kind: u32, user_data: i64) -> bool {
    matches!(event_kind, kind::LEFT_DOWN | kind::LEFT_UP | kind::RIGHT_DOWN | kind::RIGHT_UP | kind::MOVED | kind::LEFT_DRAGGED
        | kind::RIGHT_DRAGGED | kind::KEY_DOWN | kind::KEY_UP | kind::FLAGS_CHANGED | kind::SCROLL | kind::OTHER_DOWN | kind::OTHER_UP | kind::OTHER_DRAGGED)
        && user_data != TAG
}

// ---------------- local input monitor (keyboard + mouse takeover) ----------------
// An active, pass-through session event tap (Accessibility, the same grant as
// posting) that only COUNTS input events not stamped with TAG. It never reads,
// keeps or reports key codes or characters. Runs only while a control lease is
// live; a disabled/lost tap is reported so the lease is revoked, not trusted.
type CFMachPortRef = *mut c_void;
type TapCallback = extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;
#[allow(dead_code)]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: TapCallback, info: *mut c_void) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}
/// Input Monitoring (listen-event) access. Whether an active pass-through tap
/// also needs it in addition to Accessibility is NOT verified; a tap that is
/// created but silently blind to keyboard events would be worse than none, so
/// the monitor requires it. `request` prompts once and is for explicit user
/// gestures only.
pub fn listen_access(request: bool) -> bool { unsafe { CGPreflightListenEventAccess() || request && CGRequestListenEventAccess() } }
#[allow(dead_code)]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopCommonModes: CFTypeRef;
    static kCFRunLoopDefaultMode: CFTypeRef;
    fn CFRunLoopRunInMode(mode: CFTypeRef, seconds: f64, return_after_source_handled: bool) -> i32;
    fn CFMachPortCreateRunLoopSource(alloc: CFTypeRef, port: CFMachPortRef, order: isize) -> CFTypeRef;
    fn CFMachPortInvalidate(port: CFMachPortRef);
    fn CFRunLoopGetCurrent() -> CFTypeRef;
    fn CFRunLoopAddSource(run_loop: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
    fn CFRunLoopRun();
    fn CFRunLoopStop(run_loop: CFTypeRef);
}
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
const MONITORED: [u32; 14] = [kind::LEFT_DOWN, kind::LEFT_UP, kind::RIGHT_DOWN, kind::RIGHT_UP, kind::MOVED, kind::LEFT_DRAGGED, kind::RIGHT_DRAGGED,
    kind::KEY_DOWN, kind::KEY_UP, kind::FLAGS_CHANGED, kind::SCROLL, kind::OTHER_DOWN, kind::OTHER_UP, kind::OTHER_DRAGGED];
/// CGEventMask of the input events the monitor sees.
pub fn monitor_mask() -> u64 { MONITORED.iter().fold(0u64, |mask, kind| mask | (1u64 << kind)) }
/// One monitor generation. The tap callback only touches the state it was
/// created with, so an orphaned old monitor can never write into a new one.
#[derive(Default)]
pub struct MonitorState {
    cancelled: std::sync::atomic::AtomicBool, alive: std::sync::atomic::AtomicBool, failed: std::sync::atomic::AtomicBool,
    exited: std::sync::atomic::AtomicBool, foreign: AtomicU64, interrupted: AtomicU64, tap: std::sync::atomic::AtomicUsize,
}
static CURRENT: Mutex<Option<std::sync::Arc<MonitorState>>> = Mutex::new(None);
/// Poll result for the current generation.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct MonitorPoll { pub alive: bool, pub failed: bool, pub foreign: u64, pub interrupted: u64 }

/// What the tap callback does with one event (pure; unit-tested).
#[derive(Debug, PartialEq, Eq)]
pub enum TapVerdict { Ignore, Foreign, Interrupted }
pub fn tap_verdict(event_kind: u32, user_data: i64) -> TapVerdict {
    if event_kind == TAP_DISABLED_BY_TIMEOUT || event_kind == TAP_DISABLED_BY_USER_INPUT { TapVerdict::Interrupted }
    else if foreign(event_kind, user_data) { TapVerdict::Foreign } else { TapVerdict::Ignore }
}
extern "C" fn tap_callback(_proxy: *mut c_void, event_kind: u32, event: CGEventRef, info: *mut c_void) -> CGEventRef {
    if info.is_null() { return event; }
    // SAFETY: `info` is the Arc'd state kept alive by the monitor thread for the tap's whole life.
    let state = unsafe { &*(info as *const MonitorState) };
    let user_data = if event.is_null() || event_kind >= TAP_DISABLED_BY_TIMEOUT { 0 } else { unsafe { CGEventGetIntegerValueField(event, field::USER_DATA) } };
    match tap_verdict(event_kind, user_data) {
        TapVerdict::Foreign => { state.foreign.fetch_add(1, Ordering::Relaxed); }
        TapVerdict::Interrupted => {
            // Input during the gap was not observed: report it, then re-arm.
            state.interrupted.fetch_add(1, Ordering::Relaxed);
            let tap = state.tap.load(Ordering::Acquire);
            if tap != 0 && !state.cancelled.load(Ordering::Acquire) { unsafe { CGEventTapEnable(tap as CFMachPortRef, true) }; }
        }
        TapVerdict::Ignore => {}
    }
    event
}
/// The real monitor body: creates the tap on this thread and runs the run loop
/// in bounded slices until cancelled. A creation that completes after a stop
/// frees itself without ever becoming alive.
fn tap_runner(state: std::sync::Arc<MonitorState>) {
    unsafe {
        let tap = CGEventTapCreate(1, 0, 0, monitor_mask(), tap_callback, std::sync::Arc::as_ptr(&state) as *mut c_void);
        if tap.is_null() { state.failed.store(true, Ordering::Release); return; }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() || state.cancelled.load(Ordering::Acquire) {
            CFMachPortInvalidate(tap); if !source.is_null() { CFRelease(source); } CFRelease(tap as CFTypeRef);
            if source.is_null() { state.failed.store(true, Ordering::Release); }
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        state.tap.store(tap as usize, Ordering::Release);
        state.alive.store(true, Ordering::Release);
        while !state.cancelled.load(Ordering::Acquire) { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, false); }
        state.alive.store(false, Ordering::Release);
        state.tap.store(0, Ordering::Release);
        CGEventTapEnable(tap, false); CFMachPortInvalidate(tap); CFRelease(source); CFRelease(tap as CFTypeRef);
    }
}
/// Starts a new monitor generation without blocking: readiness (`alive`) or
/// failure arrives through `monitor_poll`. Any previous generation is cancelled.
pub fn monitor_start() -> Result<(), String> {
    if !listen_access(false) { return Err("screen_takeover_unavailable".into()); }
    monitor_start_with(tap_runner)
}
pub fn monitor_start_with(runner: fn(std::sync::Arc<MonitorState>)) -> Result<(), String> {
    let mut current = CURRENT.lock().map_err(|_| "screen_monitor_unavailable")?;
    if let Some(old) = current.take() { old.cancelled.store(true, Ordering::Release); }
    let state = std::sync::Arc::new(MonitorState::default());
    let thread_state = state.clone();
    std::thread::Builder::new().name("tarobot-screen-monitor".into())
        .spawn(move || { runner(thread_state.clone()); thread_state.exited.store(true, Ordering::Release); })
        .map_err(|_| "screen_monitor_unavailable")?;
    *current = Some(state);
    Ok(())
}
/// Current generation only; counters reset on read.
pub fn monitor_poll() -> MonitorPoll {
    let Some(state) = CURRENT.lock().ok().and_then(|c| c.clone()) else { return MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 } };
    MonitorPoll { alive: state.alive.load(Ordering::Acquire), failed: state.failed.load(Ordering::Acquire),
        foreign: state.foreign.swap(0, Ordering::Relaxed), interrupted: state.interrupted.swap(0, Ordering::Relaxed) }
}
/// Cancels the current generation. Never joins: the thread exits within one
/// run-loop slice (≤100 ms) and releases the tap itself.
pub fn monitor_stop() { if let Some(state) = CURRENT.lock().ok().and_then(|mut c| c.take()) { state.cancelled.store(true, Ordering::Release); } }

fn cf_string(value: CFTypeRef) -> Option<String> {
    if value.is_null() { return None; }
    let mut buffer = [0 as c_char; 128];
    unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) }
        .then(|| unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned())
}
/// Stable CoreGraphics display UUID (survives reconnects), or None.
pub fn display_uuid(display: u32) -> Option<String> {
    let uuid = unsafe { CGDisplayCreateUUIDFromDisplayID(display) };
    if uuid.is_null() { return None; }
    let string = unsafe { CFUUIDCreateString(std::ptr::null(), uuid) };
    let result = cf_string(string);
    unsafe { if !string.is_null() { CFRelease(string) } CFRelease(uuid) };
    result.filter(|s| s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session { pub available: bool, pub on_console: bool, pub locked: bool, pub user: Option<i64>, pub audit: Option<i64>, pub unique: Option<String>, pub login_done: bool }
/// The GUI login session this process belongs to. Only bounded flags/ids are
/// returned; the session dictionary itself never leaves this function.
pub fn session_state() -> Session {
    let dictionary = unsafe { CGSessionCopyCurrentDictionary() };
    if dictionary.is_null() { return Session { available: false, on_console: false, locked: false, user: None, audit: None, unique: None, login_done: false }; }
    let get = |name: &str| {
        let key = CString::new(name).ok()?;
        let key = unsafe { CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8) };
        if key.is_null() { return None; }
        let value = unsafe { CFDictionaryGetValue(dictionary, key) };
        unsafe { CFRelease(key) };
        (!value.is_null()).then_some(value)
    };
    let boolean = |name: &str| get(name).is_some_and(|v| unsafe { CFGetTypeID(v) == CFBooleanGetTypeID() && CFBooleanGetValue(v) });
    let number = |name: &str| get(name).and_then(|v| {
        let mut out = 0i64;
        (unsafe { CFGetTypeID(v) == CFNumberGetTypeID() && CFNumberGetValue(v, 4, &mut out as *mut i64 as *mut c_void) }).then_some(out)
    });
    let state = Session { available: true, on_console: boolean("kCGSSessionOnConsoleKey"), locked: boolean("CGSSessionScreenIsLocked"),
        user: number("kCGSSessionUserIDKey"), audit: number("kCGSSessionAuditIDKey"),
        unique: get("CGSSessionUniqueSessionUUID").and_then(|v| (unsafe { CFGetTypeID(v) == CFStringGetTypeID() }).then(|| cf_string(v)).flatten())
            .filter(|s| s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')),
        login_done: boolean("kCGSessionLoginDoneKey") };
    unsafe { CFRelease(dictionary) };
    state
}

#[cfg(test)]
mod tests {
    //! Construction and read-back only. Nothing here posts an event.
    use super::*;
    const P: CGPoint = CGPoint { x: -1919.5, y: 879.0 };

    #[test]
    fn mouse_events_carry_type_button_click_state_flags_and_tag() {
        let down = mouse_event(Mouse::Down, Button::Left, P, 2, 0x100008).unwrap();
        assert_eq!((down.kind(), down.field(field::CLICK_STATE), down.field(field::USER_DATA)), (kind::LEFT_DOWN, 2, TAG));
        assert_eq!(down.location(), P);
        assert_eq!(down.flags() & 0x100008, 0x100008);
        assert_eq!(mouse_event(Mouse::Drag, Button::Right, P, 1, 0).unwrap().kind(), kind::RIGHT_DRAGGED);
        let other = mouse_event(Mouse::Up, Button::Other, P, 1, 0).unwrap();
        assert_eq!((other.kind(), other.field(field::BUTTON_NUMBER)), (kind::OTHER_UP, 2));
        assert_eq!(mouse_event(Mouse::Move, Button::Left, P, 1, 0).unwrap().kind(), kind::MOVED);
        assert!(mouse_event(Mouse::Down, Button::Left, P, 4, 0).is_err());
        assert!(mouse_event(Mouse::Move, Button::Left, CGPoint { x: f64::NAN, y: 0.0 }, 1, 0).is_err());
    }
    #[test]
    fn scroll_events_are_continuous_pixel_deltas_at_the_point() {
        let event = scroll_event(P, -120, 3, 0).unwrap();
        assert_eq!((event.kind(), event.field(field::CONTINUOUS), event.field(field::POINT_DELTA1), event.field(field::POINT_DELTA2)), (kind::SCROLL, 1, -120, 3));
        assert_eq!(event.location(), P);
        assert!(scroll_event(P, 2001, 0, 0).is_err());
    }
    #[test]
    fn keys_set_keycode_flags_autorepeat_and_modifiers_are_flags_changed() {
        let key = key_event(0x01, true, 0x100008, false, true).unwrap();
        assert_eq!((key.kind(), key.field(field::KEYCODE), key.field(field::AUTOREPEAT)), (kind::KEY_DOWN, 0x01, 1));
        assert_eq!(key.flags() & 0x100008, 0x100008);
        assert_eq!(key_event(0x01, false, 0, false, false).unwrap().kind(), kind::KEY_UP);
        let command = key_event(0x37, true, 0x100008, true, false).unwrap();
        assert_eq!((command.kind(), command.field(field::KEYCODE)), (kind::FLAGS_CHANGED, 0x37));
        assert!(key_event(0x37, true, 0, false, false).is_err(), "Command must be posted as a modifier");
        assert!(key_event(0x01, true, 0, true, false).is_err());
        assert!(key_event(0x80, true, 0, false, false).is_err());
    }
    #[test]
    fn text_is_chunked_without_splitting_surrogate_pairs() {
        let text = format!("{}😀中文", "a".repeat(19));
        let events = text_events(&text).unwrap();
        let mut down: Vec<u16> = Vec::new();
        for pair in events.chunks(2) { assert_eq!(pair[0].kind(), kind::KEY_DOWN); assert_eq!(pair[1].kind(), kind::KEY_UP); assert_eq!(pair[0].text(), pair[1].text()); down.extend(pair[0].text()); }
        assert_eq!(String::from_utf16(&down).unwrap(), text);
        assert_eq!(events[0].text().len(), 19, "the emoji's high surrogate moves to the next chunk");
        assert!(text_events("").is_err() && text_events("\u{7}").is_err() && text_events(&"x".repeat(2049)).is_err());
        let lines = text_events("a\r\nb\tc").unwrap();
        let summary: Vec<(u32, i64, Vec<u16>)> = lines.iter().map(|e| (e.kind(), e.field(field::KEYCODE), e.text())).collect();
        assert_eq!(summary.iter().map(|s| (s.0, s.1)).collect::<Vec<_>>(), vec![(kind::KEY_DOWN, 0), (kind::KEY_UP, 0), (kind::KEY_DOWN, 0x24), (kind::KEY_UP, 0x24),
            (kind::KEY_DOWN, 0), (kind::KEY_UP, 0), (kind::KEY_DOWN, 0x30), (kind::KEY_UP, 0x30), (kind::KEY_DOWN, 0), (kind::KEY_UP, 0)]);
        assert_eq!(String::from_utf16(&summary[4].2).unwrap(), "b");
    }
    #[test]
    fn only_untagged_input_events_count_as_local_takeover() {
        assert!(foreign(kind::KEY_DOWN, 0) && foreign(kind::MOVED, 7) && foreign(kind::SCROLL, 0));
        assert!(!foreign(kind::KEY_DOWN, TAG) && !foreign(kind::LEFT_DOWN, TAG));
        assert!(!foreign(29, 0), "non-input events (e.g. gestures/tablet proximity) do not count");
    }
    #[test]
    fn monitor_sees_every_input_kind_and_only_counts_untagged_events() {
        let mask = monitor_mask();
        for kind in MONITORED { assert_ne!(mask & (1 << kind), 0); }
        assert_eq!(mask & (1 << 29), 0, "gestures are not monitored");
        assert_eq!(tap_verdict(kind::KEY_DOWN, 0), TapVerdict::Foreign);
        assert_eq!(tap_verdict(kind::KEY_DOWN, TAG), TapVerdict::Ignore);
        assert_eq!(tap_verdict(kind::MOVED, TAG), TapVerdict::Ignore);
        assert_eq!(tap_verdict(TAP_DISABLED_BY_TIMEOUT, 0), TapVerdict::Interrupted);
        assert_eq!(tap_verdict(TAP_DISABLED_BY_USER_INPUT, 0), TapVerdict::Interrupted);
    }
    // Scheduling tests use fake runners; no event tap is ever created here.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn fake_alive(state: std::sync::Arc<MonitorState>) {
        state.alive.store(true, Ordering::Release);
        while !state.cancelled.load(Ordering::Acquire) { state.foreign.fetch_add(1, Ordering::Relaxed); std::thread::sleep(std::time::Duration::from_millis(5)); }
        state.alive.store(false, Ordering::Release);
    }
    fn fake_late(state: std::sync::Arc<MonitorState>) {
        std::thread::sleep(std::time::Duration::from_millis(60)); // creation completes after a stop
        if state.cancelled.load(Ordering::Acquire) { return; }
        state.alive.store(true, Ordering::Release);
        while !state.cancelled.load(Ordering::Acquire) { std::thread::sleep(std::time::Duration::from_millis(5)); }
    }
    fn fake_fail(state: std::sync::Arc<MonitorState>) { state.failed.store(true, Ordering::Release); }
    fn wait(check: impl Fn() -> bool) -> bool { for _ in 0..200 { if check() { return true; } std::thread::sleep(std::time::Duration::from_millis(5)); } false }
    #[test]
    fn monitor_start_does_not_block_and_reports_readiness_or_failure_by_poll() {
        let _guard = SERIAL.lock().unwrap();
        monitor_stop();
        assert_eq!(monitor_poll(), MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 });
        let started = std::time::Instant::now();
        monitor_start_with(fake_late).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(30), "start returns before the tap exists");
        assert!(!monitor_poll().alive);
        assert!(wait(|| monitor_poll().alive));
        monitor_start_with(fake_fail).unwrap();
        assert!(wait(|| monitor_poll().failed));
        monitor_stop();
    }
    #[test]
    fn stop_is_bounded_and_a_late_creation_after_stop_never_becomes_alive() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_late).unwrap();
        let state = CURRENT.lock().unwrap().clone().unwrap();
        let stopped = std::time::Instant::now();
        monitor_stop();
        assert!(stopped.elapsed() < std::time::Duration::from_millis(5), "stop never joins on the caller");
        assert!(wait(|| state.exited.load(Ordering::Acquire)));
        assert!(!state.alive.load(Ordering::Acquire));
        assert_eq!(monitor_poll(), MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 });
    }
    #[test]
    fn an_old_generation_cannot_write_into_a_new_one() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_alive).unwrap();
        assert!(wait(|| monitor_poll().alive));
        let old = CURRENT.lock().unwrap().clone().unwrap();
        monitor_start_with(fake_late).unwrap();
        assert!(old.cancelled.load(Ordering::Acquire));
        old.foreign.fetch_add(100, Ordering::Relaxed); // orphan keeps counting
        let poll = monitor_poll();
        assert_eq!(poll.foreign, 0, "new generation is unaffected by the old one");
        assert!(wait(|| old.exited.load(Ordering::Acquire)));
        monitor_stop();
    }
    #[test]
    fn display_and_session_reads_are_bounded() {
        if let Some(uuid) = display_uuid(unsafe { CGMainDisplayIDForTest() }) { assert_eq!(uuid.len(), 36); }
        let state = session_state();
        if state.available { assert!(state.user.is_some()); assert!(state.unique.as_ref().is_none_or(|u| u.len() == 36)); }
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" { #[link_name = "CGMainDisplayID"] fn CGMainDisplayIDForTest() -> u32; }
}
