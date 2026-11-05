# Unified pending prompts

An async question answer can continue running after the original input's durable
delivery has been acknowledged. The Hub previously saw no outstanding delivery
and immediately dispatched the next ordinary prompt. Core then queued it behind
the answer. That first prompt was locked in the Hub queue while later prompts
remained editable, and it appeared again as a separate waiting card.

The lock boundary dates to `7e56acb` (2026-10-14). The compact waiting-card renderer
was added by `6f3ce28` (2026-10-19) and shipped in 1.0.95. The card exposed the
two queues; its presentation alone was not the cause of early dispatch.

## Execution boundary

New workers negotiate `prompt-queue.pull.v1` in addition to the existing queue
capability. For ordinary single-Bot direct chats, the Hub sends a conversation
wakeup without claiming a particular input. The worker reserves a position in
the shared Core conversation queue. When that position actually executes, it
claims the latest head with `queue.take`; edits, moves, cancellation and claim
use the same Hub transaction boundary. A late answer, cron or other Core job
cannot make the first waiting prompt leave the editable queue early.

The pulled input runs within that exact reserved slot, with its own message ID,
normal authorization, session preparation, attachments, receipt and completion.
It is not enqueued a second time. Each submitted prompt remains a separate turn;
the pull path does not park a batch inside its own slot. Controls, Agent Bus,
group discussions and legacy workers retain their dedicated dispatch paths.
In particular, explicit slash-command barriers can still flush preceding inputs
through legacy ordered ingress; this does not change their existing semantics.

Pull requests are connection-bound and are never written to the durable RPC
outbox. A lost response cannot replay a stale reservation and claim a later
prompt. The claimed delivery remains fenced, and reconnect sends it through
the existing Gateway receipt recovery. Unknown or previously dispatched inputs
are never reset to editable. No database migration is required.

## App and CLI

The pending panel contains only queued inputs, with a single execution order.
Active inputs no longer appear as a separate locked section. Waiting ordinary
prompts do not generate a second waiting card. Existing queue notices remain
readable for old workers, control-barrier ingress, group work and recovery;
terminal notices are not rewritten as successful execution.

Desktop, phone and ADHD use the same panel. Headless `queue list/move/edit/cancel`
uses the same Hub state, revision and request-ID checks, so the first waiting
prompt remains controllable there too. Existing CLI command syntax is unchanged.
The API retains `dispatched` entries for callers to distinguish active or
uncertain input from editable input.

## Verification

The new real Hub/Gateway/Core regression failed before the change: the first
waiting input was `dispatched` with all controls disabled. It now stays queued,
can move behind another input and be edited, and executes exactly once in the
revised order after the answer finishes. Separate checks cover cancellation,
attachment preparation, missing pull responses, reconnect fencing, Host drain
and forbidden conversation claims.

- Final full host suite: 415 files, 5,792 passed, five existing skips. Standalone
  host build and client translation/TypeScript/production build passed.
- Chromium and WebKit: 23 distinct flows each passed. The six async-answer flows
  in each engine exercise desktop, phone and ADHD, including editing the first
  prompt, moving it down, cancellation, actual execution order and draft retention.
  Desktop and phone screenshots were inspected.
- Native Rust unit/integration checks: 76 passed. The first native invocation
  stopped before tests because the fresh checkout lacked the ignored `host`
  resource directory. Preparing the current Host resources and rerunning the
  native command passed; this was not an installed-App interaction check.
- The first full host run had one obsolete direct-chat burst fixture failure;
  it now explicitly negotiates the older push worker and verifies preserved
  cancellation behavior. It passed alone and in the final complete suite.
  Chromium initially found an ambiguous existing steering-test text selector
  matching the sidebar as well as the message. Scoping it to message rows passed
  the targeted rerun and WebKit; no product change was needed for that selector.
- The optional broad root `tsc --noEmit` still reports 74 distinct existing
  diagnostics across tests/client imports. A clean `fc706ef` worktree with the
  same dependencies produced the identical normalized diagnostics, with none
  added. Required standalone and client production type checks passed.

These are source, isolated-runtime and browser checks with controlled engine
callbacks. No new paid-model, installed-App or physical-phone acceptance is
claimed. This change has not published or installed a new App/CLI release.
