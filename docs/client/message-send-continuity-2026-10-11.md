# Message send continuity, 2026-10-11

This source follow-up fixes an observed gap between the durable outbox and the
rendered conversation. It is newer than the r29 development DMG. It does not
change the Hub protocol or use durable outbox entries as display placeholders.
It does not establish installed-app/mobile acceptance.

## Reproduction and behavior

The actual Vite App, temporary Hub and IndexedDB reproduce the issue at both
1360px and 390px: an outgoing message is visible as pending, a full history read
is held, the Hub accepts the message and the client commits its event and ACK.
The independent outbox refresh removes the pending row while the history view
still predates it. Both original cases failed because the message had no visible
representation. The barrier holds a completed IDB read, so this is deterministic
ordering evidence, not a claim about measured physical disk latency.

The connection now emits an in-memory settlement only after the outbox deletion
commits. Message ACKs carry the removed entry; the most recently sent entry is a
fallback when another cache handle already removed that same ID. The UI keeps
an acknowledged message with the localized `Sent` status until canonical history
is displayed, or a successful history read that began after the ACK completes.
Normal Hub event-before-ACK ordering and sync-before-retry make this watermark
valid; it is not a substitute for a protocol that actually ACKs before committing
its event. The message is already removed from the durable outbox and is not
resent by this display bridge.

Fast pending reads remain independent of history. New sends therefore appear
while a history read is slow. Explicit discard and card ACK mask stale pending
rows without waiting for a canonical user message. Failed history reads do not
advance the successful-read watermark; deleted canonical records can release a
receipt after a later successful read rather than leaving it permanently visible.

Receipts are kept in a hook-owned WeakMap keyed by connection and conversation.
Each mounted host workspace continues listening for visited-chat receipts while
its chat is hidden or another chat is selected. Hidden views do not read history
or outbox for this display. Returning to the chat reconciles both fresh views;
post-settlement outbox reads allow consumed receipts to be discarded. Retried
IDs preserve their queue order, and a newly enqueued ID after removal has a new
order that supersedes an older display receipt. Late snapshots cannot restore an
old failure or an explicitly removed row. Reset-generation fencing remains in
the same cache write path, and aborted deletions emit no success receipt. Terminal
errors, successful discard and connection close release the last-sent fallback
frame; an aborted discard retains it.

## Independent review and additional reproduced faults

Actual Opus 5.5 xhigh completed a one-turn source-snapshot review successfully
in 677,953 ms. Tools were disabled and the reviewer explicitly limited its
claims to the six supplied files. Its hidden-receipt finding matched the Astra
finding already repaired while it was running. Both independent reviews are
retained with their exact scopes and dispositions.

Two further Opus findings were reproduced with the full Vite App, real Hub and
IDB, and then fixed:

- A delayed Retry could read a failed entry, wait while the user removed it,
  then recreate it through `enqueue` and actually send it. The UI now calls a
  generation-fenced atomic `retryFailed`: it only clears the error/retry budget
  of a still-existing failed record, preserving its ID and queue order. If
  discard or ACK committed first, retry does nothing and cannot recreate it.
- An event write could fail while its ACK was already queued on the same
  socket. The existing drain still processed that ACK and deleted the only
  local pending copy before reconnect. A per-socket receive-failure flag now
  prevents later message ACKs or `sync.complete` from confirming that failed
  stream. The durable item stays available offline; reconnect synchronizes and
  resends the same idempotent ID. The test verifies one Hub message after
  recovery. Signed denial, revocation and other security-relevant drain paths
  remain active; the entire chain is not discarded.

Both before tests failed in `opus-faults-before.log`; both after tests passed.
Astra independently checked the atomic retry ordering and failed-receive guard,
including continued security-frame draining. Neither source review is a native
test. The receipt cases also now assert actual viewport intersection, not only
CSS visibility.

## Validation

The focused suite has 17 cases. Ten receipt scenarios use the full App, real
temporary Hub and IDB: desktop/phone versions of pending-before-history, history-before-send,
hidden/return, and deletion by a second ClientCache handle before the sending
connection handles its ACK, plus desktop/phone rich forwards. Five use the
production hooks/connection/cache with
controlled transport calls and real IDB: history failure/deleted canonical,
discard/retry/card ACK, two persistent host views with identical IDs, ACK before
any outbox read renders, and aborted deletion/reset fencing. The latter are
component/integration fault tests, not socket or device acceptance. The two
additional Opus fault cases use the actual App, Hub socket and IDB.

The first cross-host fixture replaced one hook's connection prop, unlike
HostApp's persistent per-registration workspaces. Its failure is retained in
`targeted-first.log`; the corrected fixture matches the real HostApp mounting
structure. No product assertion was removed to mask that mismatch.

Final post-review Chromium and WebKit regressions each passed **72 cases**,
including all 17 send-continuity cases. Root and client builds passed. An initial
WebKit run had one 404 failure because a build
replaced lazy assets while that test was serving `dist`. The final build was
completed before both final runs; no product assertion or timeout was weakened.

Final regression/build results and independent review dispositions are recorded
with source hashes in `evidence/message-send-continuity-20261011/verification-summary.json`.
The original failures and all intermediate results are retained alongside it.

## Remaining boundaries

Opus also identified two unmeasured candidates: sustained streaming revisions
faster than outbox reads may delay first pending feedback; and very long-history
queue-following needs a dedicated viewport check. Short receipt cases now verify
viewport intersection, but do not close those broader performance/scrolling
questions. They remain hypotheses requiring focused reproduction.

A second read-only window sharing the same IndexedDB may observe a pending item
sent exclusively by another window, then lose that row when the other window
removes it. It has no local ACK receipt. Cross-window settlement broadcasting or
atomic missing-item reconciliation remains separate work; the second-cache test
only verifies the sending connection's own eventual ACK fallback. This report
does not claim complete multi-window continuity.

No production fleet was restarted, native App installed or phone package built.
No test Bot invoked a live engine or created a real CLI session. The latest delivered DMG stays
r29. Native RSS/cold-start budgets and the remaining 21-gate product acceptance
work remain open.
