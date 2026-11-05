# Automatic Lark steering: uncertain receipts

The 2026-10-04 DeepSeek review left one shared-channel follow-up: automatic
Lark steering caught every error and silently ran the same input as a queued
turn. A native engine may already have accepted it before a transport error.
That fallback could therefore execute the instruction twice.

`trySteerActiveLarkTurn` now requests explicit errors from the bridge. Only a
definite `EngineSteeringRejectedError`, a false pre-admission result, or a
capability lookup failure uses normal queue admission. Unknown native errors
are recorded as `engine.turn.steer_uncertain` and receive a Chinese/English
warning that the message was not queued again. A failed warning is recorded
separately and does not fail the inbound handler or replay the instruction.
No native exception text or user message is copied into these audit fields.

The original active-run object is checked after asynchronous binding lookup
and again by the bridge after session resolution. For a goal with attached
ordinary work, the attachment must still be the same live ordinary turn.

The App retains its explicit steering action and durable cross-device receipts;
ordinary App sends still queue. No Telegram behavior or production service was
changed. The change does not add durable Lark message deduplication across
process restarts, nor claim successful delivery when the warning cannot be sent.

Focused validation: `lark-steer`, `gateway-steering`, `lark-audit3-fixes`: 49
passed. The new cases cover each definite native rejection, an admitted call
with a lost reply, failure to deliver that warning, and replacement of the
target run during asynchronous lookup. These are deterministic routing tests,
not a live Feishu deployment receipt.
