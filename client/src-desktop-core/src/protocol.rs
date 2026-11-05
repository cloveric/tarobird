//! Bounded JSONL framing. stdout carries only protocol lines; nothing else in
//! this process may print to it.
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::mpsc;

/// An 8 MiB base64 request body plus headers, path and CA material.
pub const MAX_REQUEST_LINE: usize = 12 * 1024 * 1024;
/// Responses are bounded by in-flight requests, events by socket credits:
/// 256 + 64 sockets x (8 messages + open/error/close) < 2048.
pub const OUTPUT_CAPACITY: usize = 2048;
pub const MAX_INFLIGHT: usize = 256;
/// Largest response line. Real maxima: an HTTP read (349,528 base64 chars),
/// Host output (64 KiB input JSON) or response head (hyper's ~408 KiB buffer,
/// at most doubled by JSON escaping of visible-ASCII values).
pub const MAX_RESPONSE_LINE: usize = 1024 * 1024;
/// Largest event line: a 1 MiB text frame escapes to at most 6 bytes per byte.
pub const MAX_EVENT_LINE: usize = 6 * 1024 * 1024 + 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub enum Line { Data(Vec<u8>), TooLarge, Eof }

/// Reads one `\n`-terminated line without ever buffering more than the limit.
/// An oversized line is consumed to its end and reported once.
pub async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R, limit: usize) -> std::io::Result<Line> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if oversized { Line::TooLarge } else if line.is_empty() { Line::Eof } else { Line::Data(line) });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk = &available[..newline.unwrap_or(available.len())];
        if !oversized {
            if line.len() + chunk.len() > limit { oversized = true; line = Vec::new(); }
            else { line.extend_from_slice(chunk); }
        }
        let consumed = newline.map_or(available.len(), |end| end + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(if oversized { Line::TooLarge } else { Line::Data(line) });
        }
    }
}

pub struct Request { pub id: Value, pub command: String, pub args: Value }

fn id_valid(id: &Value) -> bool {
    match id {
        Value::Number(number) => number.as_u64().is_some_and(|value| value <= MAX_SAFE_INTEGER),
        Value::String(text) => !text.is_empty() && text.len() <= 64
            && text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        _ => false,
    }
}

/// On failure returns the id to answer with (`null` if it was unusable).
pub fn parse(line: &[u8]) -> Result<Request, (Value, &'static str)> {
    let value: Value = serde_json::from_slice(line).map_err(|_| (Value::Null, "invalid_request"))?;
    let Value::Object(mut object) = value else { return Err((Value::Null, "invalid_request")) };
    let id = object.remove("id").unwrap_or(Value::Null);
    if !id_valid(&id) { return Err((Value::Null, "invalid_request")); }
    let command = match object.remove("command") {
        Some(Value::String(command)) if !command.is_empty() && command.len() <= 64 => command,
        _ => return Err((id, "invalid_request")),
    };
    let args = match object.remove("args") {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(args @ Value::Object(_)) => args,
        Some(_) => return Err((id, "invalid_request")),
    };
    if !object.is_empty() { return Err((id, "invalid_request")); }
    Ok(Request { id, command, args })
}

fn line(value: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&value).expect("protocol values serialize");
    bytes.push(b'\n');
    bytes
}
/// A result that would exceed the line limit becomes `response_too_large`.
pub fn success(id: &Value, result: Value) -> Vec<u8> {
    let bytes = line(json!({ "id": id, "result": result }));
    if bytes.len() > MAX_RESPONSE_LINE { failure(id, "response_too_large") } else { bytes }
}
pub fn failure(id: &Value, code: &str) -> Vec<u8> {
    line(json!({ "id": id, "error": { "code": code, "message": code } }))
}
/// `None` when the event would exceed its line limit (treated as a lost view).
pub fn event(document: &str, channel: &str, payload: Value) -> Option<Vec<u8>> {
    let bytes = line(json!({ "event": "transport", "document": document, "channel": channel, "payload": payload }));
    (bytes.len() <= MAX_EVENT_LINE).then_some(bytes)
}

/// Single ordered writer queue shared by responses and events.
#[derive(Clone)]
pub struct Output(mpsc::Sender<Vec<u8>>);
impl Output {
    pub fn new() -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (sender, receiver) = mpsc::channel(OUTPUT_CAPACITY);
        (Self(sender), receiver)
    }
    /// Responses wait for room: the bounded in-flight count limits them.
    pub async fn send(&self, bytes: Vec<u8>) -> bool { self.0.send(bytes).await.is_ok() }
    /// Events never block a transport task; a full or closed writer is a lost view.
    pub fn try_send(&self, bytes: Vec<u8>) -> bool { self.0.try_send(bytes).is_ok() }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn lines(input: &[u8], limit: usize) -> Vec<String> {
        let mut reader = tokio::io::BufReader::with_capacity(4, input);
        let mut out = Vec::new();
        loop {
            match read_line(&mut reader, limit).await.unwrap() {
                Line::Data(data) => out.push(String::from_utf8(data).unwrap()),
                Line::TooLarge => out.push("<too large>".into()),
                Line::Eof => return out,
            }
        }
    }

    #[tokio::test]
    async fn framing_is_bounded_and_recovers_after_an_oversized_line() {
        assert_eq!(lines(b"abc\ndefgh\n\nxy", 5).await, ["abc", "defgh", "", "xy"]);
        assert_eq!(lines(b"abcdefgh\nok\n", 5).await, ["<too large>", "ok"]);
        assert_eq!(lines(b"abcdefgh", 5).await, ["<too large>"]);
        assert!(lines(b"", 5).await.is_empty());
    }

    #[test]
    fn requests_accept_only_the_documented_envelope() {
        let ok = parse(br#"{"id":7,"command":"net_document"}"#).ok().unwrap();
        assert_eq!((ok.id, ok.command.as_str(), ok.args), (json!(7), "net_document", json!({})));
        assert!(parse(br#"{"id":"req-1","command":"x","args":{"a":1}}"#).is_ok());
        for (raw, id) in [
            (&br#"[1]"#[..], Value::Null),
            (br#"{"command":"x"}"#, Value::Null),
            (br#"{"id":-1,"command":"x"}"#, Value::Null),
            (br#"{"id":1.5,"command":"x"}"#, Value::Null),
            (br#"{"id":9007199254740992,"command":"x"}"#, Value::Null),
            (br#"{"id":"a b","command":"x"}"#, Value::Null),
            (br#"{"id":1,"command":""}"#, json!(1)),
            (br#"{"id":1,"command":"x","args":[]}"#, json!(1)),
            (br#"{"id":1,"command":"x","extra":true}"#, json!(1)),
            (b"not json", Value::Null),
        ] {
            assert_eq!(parse(raw).err().unwrap(), (id, "invalid_request"), "{}", String::from_utf8_lossy(raw));
        }
    }

    #[test]
    fn responses_and_events_are_single_json_lines() {
        assert_eq!(success(&json!(1), json!(null)), b"{\"id\":1,\"result\":null}\n");
        assert_eq!(failure(&json!("a"), "native_request_cancelled"),
            b"{\"error\":{\"code\":\"native_request_cancelled\",\"message\":\"native_request_cancelled\"},\"id\":\"a\"}\n");
        let event: Value = serde_json::from_slice(&event("lease", "c1", json!({"kind":"open"})).unwrap()).unwrap();
        assert_eq!(event, json!({"event":"transport","document":"lease","channel":"c1","payload":{"kind":"open"}}));
    }

    #[test]
    fn line_limits_hold_for_worst_case_payloads() {
        // Largest real read: 256 KiB of binary as base64.
        let read = success(&json!(1), json!({ "data": "A".repeat(349_528) }));
        assert!(read.len() < MAX_RESPONSE_LINE);
        assert_eq!(success(&json!(1), json!("a".repeat(MAX_RESPONSE_LINE))),
            failure(&json!(1), "response_too_large"));
        // A maximal 1 MiB frame of control characters (6x escape) still fits.
        let uuid = "00000000-0000-0000-0000-000000000000";
        let worst = "\u{1}".repeat(1024 * 1024);
        let line = event(uuid, &"c".repeat(64), json!({"kind":"message","data":worst,"sequence":u64::MAX})).unwrap();
        assert!(line.len() <= MAX_EVENT_LINE && line.len() > 6 * 1024 * 1024);
        assert!(event(uuid, "c", json!({"kind":"message","data":"\u{1}".repeat(1024 * 1024 + 200)})).is_none());
    }
}
