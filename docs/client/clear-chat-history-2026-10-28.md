# Clear App chat history while retaining the native session

Requested after a conversation grew beyond 2,000 App messages. The new action is
in **Conversation settings → History → Clear chat history**. It previews a count,
asks for confirmation, then clears only the current user's visible history for
that conversation across their paired devices. Other members retain their own
history. No live user history was cleared during development.

## Scope and retained data

- Existing per-user `message_deletions` and ordinary deletion events are reused.
  Canonical message bodies, native model session/binding, Bot configuration,
  deliveries, event journal and shared attachments are not deleted or reset.
- New messages after the preview's boundary, typed drafts and saved files remain.
  A draft quote of a cleared message is removed, as with existing single delete.
  App search, conversation files and reply/forward sources respect the same
  existing personal deletion rules. There is no App undo.
- Clearing does not run `/reset` or `/compact`, cancel a task, or call a model.
  Every page is checked before writing: pending/streaming messages, queued inputs,
  active foreground/background runs, answer follow-ups, and enabled question or
  approval cards pause the operation. A `complete` message status alone does not
  mean an asynchronous question has been answered.
- Earlier completed pages remain cleared if a later page is refused or fails.
  The UI explains this and offers a retry of the same original boundary after
  the outstanding task/card is handled. Later messages are outside that boundary.
  If a crashed Bot leaves an enabled card behind, it remains protected. Once the
  user has confirmed it is obsolete, existing single-message deletion can hide
  that card before resuming. The bulk action does not guess that a card expired.

## API, CLI and compatibility

Capability `messages.clear.v1` gates the control. Old Hosts show an update hint;
offline or synchronizing devices explain why the control is unavailable. No DB
schema change or new event kind is needed. Older paired clients understand the
ordinary personal deletion events.

`GET /api/conversations/:id/messages/clear` returns `{throughId?, count}` without
loading message bodies. `POST` with `{throughId}` processes at most 100 visible
records, oldest first, in one authenticated membership-checked transaction. The
opaque ID is resolved inside that transaction; no persistent SQLite rowid is used
as a cutoff. The response includes `clearedIds`, `remaining`, and the committed
conversation `seq`, including an empty retry after a lost response.

The client waits for its own cache cursor to reach that `seq` before confirming
a page. HTTP success alone cannot report locally completed clearing. Requests
and cursor waits have time limits; double clicks, closed/replaced conversations,
and uncertain responses cannot start clearing a new range automatically.

`tarobot messages clear CONVERSATION --json` previews without writing.
`tarobot messages clear CONVERSATION --through MESSAGE_ID --yes --json` executes
or resumes that exact boundary through the same API. `--yes` without `--through`
previews and executes in the same invocation. The boundary is printed before a
mutation, and failures include the exact continuation command. CLI `cleared`
counts received successful changes, excluding already-cleared records from
another device or an earlier lost receipt.

## Performance evidence and limits

The cache previously reread and sorted the whole conversation after **every**
personal deletion to rebuild its sidebar preview. A deterministic browser test
with 120 records, including an old reply edited most recently, reproduced **120
full-history reads**. The fix skips preview recomputation when the deleted record
cannot be the current preview source: the same scenario needs **2 reads**, with
identical preview, unread, attention and draft behavior. Missing legacy metadata
still takes the safe full projection; this is not a universal two-read guarantee.

Cleared records become small tombstones in the user's synchronized view. This
removes the old bodies from App rendering/search and reduces future snapshot/body
transfer and cache decoding work. It does **not** shrink the Host database or
native model context, eliminate all history scanning, or establish a measured
phone-wide speedup. Initial clearing itself adds deletion events and sync work.

The separate [artifact/text latency investigation](artifact-text-latency-2026-10-28.md)
found a 12.287-second gap before native public text and a 68 ms native-to-Host
boundary. Clearing App history does not fix that upstream gap. No provider,
engine or production runtime settings were changed here.

## Validation

Actual Claude Opus 5.5 implemented and independently reviewed the Host portion;
root implemented the App/CLI and cache optimization. Evidence is under
`/Volumes/gdrive/taro-tmp/clear-chat-history-20261028`.

- Host-focused suites: 100/100 across 8 files, plus prompt queue 47/47. The set
  covers permission revocation within the transaction, foreign boundaries,
  canonical/session/delivery preservation, replay/full/merge snapshots, another
  member's view, actionable complete cards, partial failure and later arrivals.
- Root's CLI/helper and client synchronization suites: 23/23 across 5 files.
- Chromium: the 2105-record phone/desktop flow, receipt-gated control cases,
  existing deletion behavior and 15 conversation-settings cases passed.
- App and standalone Host builds passed, including translation and app-source
  type checks. The broader test-inclusive `tsc -p tsconfig.json --noEmit` still
  reports 123 diagnostics; comparison against the main baseline found the same
  123 diagnostic lines with no additions. It is not a passing full type check.
- Parallel stress caused timeout-only failures under concurrent machine load;
  focused sequential reruns passed. The first cross-device fixture also checked
  presence before history synchronization ended; the corrected test explicitly
  awaits completed synchronization. These are retained in the artifact logs.

- Final CLI parser/API checks: 24/24, including real HTTP 409 for an active
  record and resumption after it completes. Across the overlapping focused
  Host/CLI/client unit runs above, 181 distinct cases passed (13 files).
- Chromium 23 distinct cases passed (clear flow/control, deletion/cache and
  conversation settings). WebKit 8/8 passed, including the 2105-record flow,
  offline second-device reconnect, a lost committed HTTP receipt, drafts/session
  retention, and legacy preview fallback. Screenshots were inspected for the
  phone confirmation and the desktop's preserved new messages.
- `git diff --check` passed. No production data was cleared; no release,
  installation, Host restart or real-model session reset was performed.

 Browser
Chromium/WebKit evidence is separate from physical iPhone, Android or installed
Mac acceptance. This source change does not release or install a new App/Host/CLI.
