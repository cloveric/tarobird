# Conversation and scheduler audit — 2026-10-12

This pass reviewed message submission, references/forwarding, attachment and
voice drafts, group membership, host isolation, settings requests, search/file
pagination, and task scheduling. Reproductions use disposable Hubs and local
engine doubles; no personal API configuration or live fleet is used.

## Fixed behavior

| Trigger | Previous behavior | Result |
| --- | --- | --- |
| An older scheduler load resolves after a newer refresh | The old snapshot could reinstall a disabled or outdated timer | Only the latest refresh can reconcile timers; startup shares that path |
| A one-shot task is rescheduled during execution | Completion of the old run disabled the new plan and stopped its timer | Completion uses a revision check and preserves the newer schedule |
| A recurring task is corrected while an old run is failing | The old failure could increment the new configuration's failure budget and disable it | The old result remains in history without applying control changes to the new revision |
| Another trigger arrives while the previous result is being persisted | The task's active marker had already been removed, allowing overlap | Both execution and bookkeeping must settle before releasing the task |
| A selected forwarding recipient is removed on another device | An invisible, stale Bot ID remained selected and could be submitted | Removed recipients are cleared; the user selects a remaining Bot explicitly |
| The forwarding source changes or is deleted while the dialog is open | Preview showed an old snapshot; deleted messages could still be queued | Preview follows the source; unavailable, unreadable or unfinished sources cannot be submitted |
| A quoted source changes or is deleted, including during attachment upload | The draft preview stayed stale and the failed submission cleared the editor | Preview follows current history; deletion blocks submission and preserves text/files until the user cancels the reference |
| A long rich quote and attachments are composed with the phone keyboard open | The quote consumed the constrained composer height and clipped the input | The quote yields and scrolls independently while its cancel action stays reachable |
| A right-click/keyboard menu opens after focusing an older message | Queued scroll notifications or automatic tail following immediately dismissed it | Already-applied scroll events are ignored; opening message actions stops tail following and keyboard focus does not scroll the page |
| An unpaired browser starts the client | First-view JavaScript exceeded the existing 700,000-byte budget | Host transport loads only when a ready host exists; download code loads on demand, bringing first-view scripts from 714,254 to 681,959 bytes |

The server remains authoritative for races that occur after a client submits a
message. Existing durable outbox, delivery authorization and forwarding receipts
continue to handle offline delivery and retries.

## Regression repairs

- The download cancellation fixture now supplies the attachment action context
  required by `MessageContent`. Its renderer previously crashed before exercising
  cancellation. The unchanged cancellation assertions now pass.
- Link-preview forwarding assertions now account for the existing direct-chat
  default that asks the target Bot to reply. They verify both the unchanged
  source messages and the target delivery rather than an obsolete global count.
- Phone steering checks use the current held-recording interface: it stays
  disabled while steering owns submission, while file drafts remain editable.
  Desktop recording and both platforms' file drafts survive the delayed receipt.
- Keyboard history tests wait for the virtualizer's deferred iOS inertia
  correction before saving the reference reading position. Instrumentation
  traced the apparent jump to that pending correction, not keyboard resize;
  the application's existing reading strategy remains unchanged.
- The polling backoff test now yields an actual timer turn. Its former recursive
  microtask timer could starve the file I/O needed to start a queued message under
  full-suite load. Teardown also aborts and drains the poller so a failed assertion
  cannot leave work running in subsequent tests.

## Validation

- Six scheduler concurrency regressions initially reproduced the faults. The
  scheduler/store/Gateway focused set passes all 54 tests.
- Full standalone build and test gate: **219 files, 2,851 passed, one skipped**.
  The initial run's seven polling-suite failures were investigated, not accepted
  as product results; the corrected fixture passes the full gate.
- Client production build, TypeScript and translation checks pass.
- Chromium: eight new desktop/phone reference lifecycle scenarios pass, including
  deletion during upload and delivery exclusively to the newly selected Bot.
- Affected existing journeys: Chromium **17 passed / two opt-in skips**; WebKit
  **25 passed / two opt-in skips**, including all eight new lifecycle scenarios.
  These cover rich references, readable copied attachments, offline forwarding,
  per-conversation drafts, voice lifecycle and schedule CRUD.

- Full Chromium inventory was reconciled by file, nested suite and test title
  across the initial scan, remaining-file scan, focused retakes and isolated
  performance run: **666 passed, 41 opt-in skips (707 total)**. This is a
  partitioned audit, not a single uninterrupted green run. Every observed
  failure was investigated and its affected case rerun after correction.
- Final changed-area Chromium run: **48 passed**. Final WebKit run: **30 passed**
  and one menu timing failure; the additional timing fix then passes that
  complete menu journey **five consecutive WebKit runs and three Chromium
  runs**. The repaired cancellation fixture also passes separately on WebKit.
- Isolated performance set: **eight passed**. The 5,000-line streamed answer
  retains all ten tables and equations; input takes 8 ms, frame p95 is 16.8 ms,
  with no measured long tasks in this local Chromium run. Worker warm-request
  median is 69.6 ms and p95 104.4 ms; these are local measurements, not native
  device or network performance promises.

Browser checks are not physical Android/iOS microphone, native permission,
Tailscale-over-mobile-data or real provider acceptance. No installed application
or running user service was replaced or restarted for this audit.
