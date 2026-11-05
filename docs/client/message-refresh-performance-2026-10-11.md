# Conversation refresh and host preview follow-up, 2026-10-11

This source-only batch reduces overlapping history allocations during streaming
updates and provides recovery when a local history read fails. It is newer than
the r29 development DMG and does not establish a native memory or startup result.

## Reproduced issue and implementation

`Workspace` previously started `cache.messages(selected)` for each cache
revision. Its effect cleanup prevented stale results from being displayed, but
did not prevent all the outstanding reads from cloning the full conversation.

The controlled slow-read test uses the actual Vite App, temporary Hub, streamed
Hub updates and real IndexedDB. With 300 historical messages plus a streaming
message, 12 updates produced **12 overlapping reads and 3,612 returned message
records** before the fix. The barrier delays returning already-read data, so
this measures concurrent allocations rather than claiming a particular device
has that disk latency.

`useConversationMessages` now subscribes to cache revisions and serializes the
Workspace's automatic history refreshes. Revisions received during a read request one catch-up read;
each finished read can render, and the final update is not discarded. Connection
status changes alone do not trigger history reads. The same held-update test
now has **one outstanding read / 301 records**, followed by one fresh read that
displays the twelfth update. Completion and explicit retry also update the view.
No history limit, deletion or fixed refresh delay was added.

Astra identified an additional lifetime boundary in the first implementation:
effect-local serialization alone permitted duplicate reads when leaving and
returning before an old request finished. The final implementation retains only
in-flight promises in a hook-owned WeakMap keyed by the connection object, then
conversation ID. On return it waits for the old slot, discards the old outcome,
and reads current data. Exact-promise cleanup cannot delete a replacement slot.
Both successful and rejected old reads are covered by repeated A→B→A→B→A tests,
with the same-conversation maximum concurrency remaining one.

Read failures preserve the displayed content, show localized feedback and offer
Retry. Errors from retired views cannot appear in the new view. Hidden host
views retain their existing reading state; this change does not evict background
drafts, cancel uploads or solve all retained-view memory costs.
First-read loading/failure is distinct from an empty conversation, so empty-chat
actions only appear after a successful read. The phone inbox also pauses hidden
history reads while connection events continue to reach IndexedDB. Returning to
the chat reads its latest content; the fault/navigation test verifies both paths.

## Preview hypothesis checked separately

Notification-driven host switching was investigated as a possible source of
orphaned PDF/image previews. **It did not reproduce on the previous production
code.** In desktop and 390-pixel phone layouts, existing virtual-row teardown
closed the previews and released the PDF worker. A late text-file download
also could not reopen after A→B→A; explicit reopening still worked, and captions
remained with their originating hosts. These three cases passed in Chromium and
WebKit before changing message refresh. No speculative preview fix was added.

## Evidence and boundaries

Final Chromium and WebKit regressions each passed 36 cases covering refresh,
previews, complete drafts, background uploads across hosts, local reset, history
search, interrupted snapshots, long content and final/worker recovery. Root and
client builds passed. Evidence is stored in
`evidence/host-previews-20261011`（本地材料：`evidence/host-previews-20261011`）, including the
old failing read-count test, focused tests, build logs and independent reviews.
Two earlier WebKit failures are retained: initial 301-event replay exceeded the
test's five-second setup wait, and an existing settings test measured geometry
immediately after opening the phone dialog. Setup now waits up to 20 seconds;
the geometry assertion waits for both rows and the original alignment / 44px
minimum to hold. That phone case also passed three repeated runs. No production
layout or message assertion was relaxed to make the tests pass.

Actual Opus 5.5 xhigh completed a one-turn, 466,639 ms source-snapshot review.
Its empty-state and phone-inbox findings were verified and fixed, with stronger
post-release concurrency and first-read recovery tests. Some of its claimed
storage details did not match current source and were not applied. The exact
findings, corrections and outstanding candidates are recorded in
`opus-review-disposition.json`; tools were disabled, so the model's references
to additional file inspection are not repository inspection receipts. Astra
independently reviewed the final cross-activation and post-Opus changes.
The outbox/history display gap was subsequently reproduced and fixed in the
[send continuity follow-up](message-send-continuity-2026-10-11.md). Metadata-refresh
coalescing and abnormal DB-connection recovery remain separate candidates for
fault reproduction.
Neither review is a native test. Browser concurrency counts do not demonstrate
an RSS reduction or close the 200 MB / 1.5-second acceptance budgets. The latest
delivered DMG remains r29; no installer, fleet deployment or phone build was
performed for this batch.
