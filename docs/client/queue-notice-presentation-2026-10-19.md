# Core queue status presentation

The [2026-10-22 unified pending queue](unified-pending-queue-2026-10-22.md)
supersedes the ordinary direct-chat waiting path below: new workers leave those
prompts editable in the Hub until execution. This renderer remains for legacy
and special-purpose queue notices and their recovery states.

The Gateway's already-admitted Core queue previously published a generic card
with a task-specific cancel button. Native run presentation applies only after
execution starts, so this separate path retained the older visual treatment.
This did not prove that a request was stuck: the reported request had completed
when checked. A separate restart-recovery gap was reproduced in isolated tests:
orphaned Core queue notices were not settled after their worker disappeared.

## Behavior

- Gateway queue cards now carry additive `appQueue` metadata, rendered as a
  compact waiting status consistent with native run cards. It has no fake run,
  duration, progress journal or conversation-wide stop button.
- Cancellation continues through the original task-bound interaction. Submission
  is not success: the UI waits for the real update, prevents double taps, and
  reports an unconfirmed cancellation after eight seconds. Offline controls are
  unavailable. Execution replaces the same message with its normal run record.
- Attachment preparation and skipped tasks use the same structured surface.
  Preparation has no obsolete queue cancel or conversation-wide stop button.
  Routine queue updates do not trigger action-required or reply-completed push
  notifications; the actual reply retains its existing notification behavior.
- Existing compact Gateway cards are recognized by their exact structure and
  task/conversation binding, independently of localized text. Invalid or future
  metadata is left in the generic renderer. The old `lark:` routing prefix is a
  persisted compatibility key, not a new transport dependency.
- New worker attachment settles only orphan notices older than that attachment,
  with no pending durable delivery. Active deliveries and newly attached work
  are untouched. Recovery is idempotent and never resends a prompt. An orphan
  notice expires neutrally because its actual task may already have completed.
  Its envelope becomes `complete`, preventing a false failure/retry marker from
  overriding a real completed reply. Expiry does not assert task completion.
  Failed delivery recovery uses its confirmed failure/interruption reason,
  and deleting a Bot also terminalizes its active queue metadata and controls.
- Forwarded snapshots strip queue identity and interaction bindings. Other
  cards, answer receipts and optional transports retain their existing behavior.

The Hub pre-dispatch queue still owns editing and ordering before admission.
This UI must not expose those operations for an already-admitted Core task.
`runs.v1` and the protocol version remain unchanged; older clients can still
read the generic fallback. CLI command parity is not applicable to the visual
change; recovery uses the shared Hub implementation for App and headless hosts.

## Independent review

Opus 5.5 / xhigh independently read the original flow and reviewed the evolving
implementation. Confirmed findings incorporated here include the preparation
card, skip state, misleading push classification, Bot deletion, explicit Gateway
metadata validation and neutral expiry of orphan notices. The persisted callback
compatibility boundary is recorded in `docs/neutral-naming.md`.
The second review also identified desktop notification claims being consumed by
the queue card before its real reply. `message-notification.ts` now gates the
claim itself, so bookkeeping remains silent and the later reply can notify.

The reported malformed-config leak was not reproduced: the controlled malformed
configuration followed the existing defaults path and cleaned the queue entry.
No speculative exception-handler rewrite was made for that finding. Simultaneous
publication and recall failures remain a fault-injection follow-up, not a
confirmed cause of the user's screenshot. The implementation keeps the compact
surface rather than reserving empty run-card height; width and border treatment
match the running reply while content height changes naturally.

## Verification

- Before the fix, the new presentation browser assertion failed and both
  structured/legacy orphan queue recovery tests failed.
- Focused protocol, Gateway queue/answer and recovery tests cover
  task-scoped repeated cancellation, same-message execution takeover, safe
  forwarding, legacy recognition, live-delivery protection and restart cutoff.
- Six Chromium flows pass across desktop, phone and ADHD, with both completion
  and cancellation, draft preservation, no extra stop/process control, no queue
  surface horizontal overflow and unchanged active-work cancellation state.
- Six additional isolated production-renderer browser checks cover narrow
  Chinese/English surfaces, light/CLI themes, double-click guarding, lost cancel
  confirmation, offline controls, preparation, legacy notices and neutral expiry.
- Sixteen existing browser regressions cover pre-dispatch queue edits/order,
  cancellation, ADHD long queues, stop confirmation and reconnection.
- Client and standalone host builds pass.
- Final frozen-source regression: 352 test files pass, 4,885 tests pass and
  three are skipped. The 12 final presentation/browser flows pass; combined
  with the 16 existing queue/stop regressions, this task verified 28 browser
  cases. Chromium evidence is retained outside the repository.

Earlier runs exposed a missing constructor ledger entry (now added) and one
intermittent late-Claude-answer receipt count failure. That workflow passed the
focused rerun and the final complete suite without a product change for it; the
earlier failure remains in the local verification log for future reproduction.

This is source/build and browser validation. Installed native Apps have not
been replaced by this task. The original Git/WebKit environment blockers are resolved; follow-up source
delivery and browser results are recorded below. Native acceptance remains
separate from browser checks.

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.
