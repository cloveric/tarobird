# Visible answer follow-ups and admitted queue notices

## Confirmed failure

When a native asynchronous question outlived its originating turn, submitting
the answer admitted a new card-action turn to the conversation's `ChatQueue`.
That turn logged engine events but did not create the foreground run card used
by ordinary messages. The original reply was already complete, while the answer
receipt only said it was processing. A subsequent ordinary message correctly
waited behind this work, but its legacy wait card made the conversation appear
idle and stuck.

Read-only incident evidence showed the answer turn completing and the waiting
message starting immediately afterwards. This incident did not demonstrate a
deadlock or a reason to replay, interrupt, or delete queued messages.

## Changes

- Gateway card-choice turns use the shared run-card factory, injected to avoid
  a Core import cycle. This covers completed-origin async answers and ordinary
  choice-card continuations. Live-origin answers still steer the original turn
  and do not create another engine task.
- The follow-up exposes live text, tools, scoped activity and approval states;
  its own reply card carries stop, result, failure and restart-recovery metadata.
  The submitted-answer receipt remains a separate record of the user's choice.
- Final text appears in the same run card. Files are still delivered through
  the existing delivery path; a failed file delivery cannot mark the answer
  receipt as successfully finished. A stop during card publication is checked
  before calling the engine.
- An App message already admitted to Core but waiting behind a card-action turn
  uses a compact notice with one task-scoped cancellation action. It has no
  frozen elapsed-time estimate, manual `/stop` instruction or no-op Keep Waiting
  button. The same message becomes its run card when execution starts.

The two queue boundaries remain intentional. The Hub's existing **pending
messages** panel can edit/reorder/cancel messages that have not been dispatched.
An already dispatched message cannot become editable again: its compact Core
notice can only cancel that pending task. Cancelling it never stops the earlier
answer follow-up. No dispatch fences, persistent order or replay rules change.
Optional Feishu card rendering remains on its existing compatibility path.

The independent audit later on the same date added task-scoped cancellation to
the **queued answer receipt** itself. Cancelling keeps the submitted answers and
changes their follow-up status immediately; it does not stop the preceding run
or discard other queued messages. The button disappears when processing begins
or the receipt becomes terminal, including worker-restart recovery. Repeated or
stale taps never abort a different/current run. Gateway continues to disable the
optional transport's preempt mode, so ordinary App inputs retain queue order.

Card-driven turns and shared engine/collaboration commands now carry the owning
Bot's persisted `disableRuntimeTimeout` setting, as ordinary messages already
did. Bus targets read their own setting each turn. Agent Bus request deadlines
(30 minutes by default, explicit stage limits for crew) remain independent;
`/timeout off` and status text disclose that boundary.

## Verification and delivery boundary

- Regression tests reproduce the missing live card and old wait UI before the
  fix. Gateway tests cover successful, stopped and failed follow-ups; stopping
  during publication; normal ordered continuation and targeted cancellation;
  file byte delivery and missing-file failure. Existing tests cover duplicate
  submissions, changed sessions, budgets and worker restart recovery.
- Full host suite: 325 files, 4318 passed, 1 skipped. Host and client builds pass.
- Browser regression exercises desktop, phone and ADHD layouts, retaining the
  answer receipt and composer draft while the follow-up and queued input finish.
  Async-answer, pending-queue and stop-recovery journeys: 18 Chromium and
  18 WebKit checks passed. The answer journey is now included in WebKit's test
  selection. These use an isolated Hub and controlled engine fixtures.

The standalone CLI and App host use the same Gateway/Core implementation. No
new CLI command is needed; existing queue commands keep their pre-dispatch
semantics. A host-affecting release must ship App and standalone CLI together
from the fixed revision. Source/browser validation is not proof of installation
in the currently running App or acceptance on an Android/iOS physical device.

## Submitted receipt typography (2026-10-23)

`Content.tsx` now renders the submitted-answer heading at the compact status
size used by run labels, rather than the generic card-title size. Recognition
uses the existing producer's matching `summary` and checked title in Chinese
or English, so already-saved receipts benefit without a Host/schema change.
Answer text, other card headings, reading preferences and platform density are
unchanged. This is client presentation only; CLI behavior is not applicable.

Client translation/type/production build passed. Existing async-answer browser
coverage passed in Chromium and WebKit (six cases each across desktop, phone
and ADHD), including queue, execution, completion and cancellation. The desktop
WebKit receipt screenshot was visually checked. No installation or physical
phone acceptance is claimed. Logs: `/Volumes/gdrive/taro-tmp/submitted-answer-type-20261023/`.
