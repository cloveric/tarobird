# Transient model failure recovery

The observed Codex failure was a short capacity outage. The provider returned
`serverOverloaded` after ongoing project work, then again on the next request.
A manually continued request succeeded on the same native thread shortly afterward.
Previously, Bridge classified the error as retryable but immediately failed the
App run instead of attempting recovery.

## Behavior

- Confirmed transient failures keep the same App run and native conversation.
  A continuation asks the engine to reconcile outstanding results and finish the
  remaining work. It does not resend the original project request or attachments.
  Claude's interrupted-turn note (which tells the model not to resume on its own)
  is omitted from that automatic continuation; it remains for the user's next
  message if recovery ends without a successful turn.
- Desktop and mobile display the reason, a retry countdown, retained progress,
  and Stop. Recovery does not insert another user message or another run card.
  Stop cancels the pending timer; a disconnected client does not own the host run.
- Backoff starts at 2, 5, 10, 20, 30, then 60 seconds, with 15% jitter. A provider's
  longer Retry-After is respected. A consecutive outage gets at most 10 minutes
  and 20 retries; the shorter bound wins. Actual assistant/tool progress resets
  that outage window, but not the backoff sequence: short fragments followed by
  failures cannot cause a rapid retry loop. A separate 100-retry total bound
  cannot be reset by progress.
- The engine's existing total runtime cap spans backoff, worker-pool waits and
  continued execution; a retry does not grant a new six-hour budget. Explicitly
  disabling the runtime cap still works. Cancellation uncertainty remains visible
  if a native engine cannot confirm that it stopped at the deadline.
- Conversation/session serialization remains held. Shared worker capacity is
  released during backoff, so other conversations can run.
- Every failed recoverable attempt records available usage, or an explicit
  unmetered attempt. The normal caller records the final successful attempt once.
  Budget and execution configuration are rechecked before each retry. An invalid
  budget cannot silently disable budget enforcement during automatic recovery.
- Claude's `total_cost_usd` is session-cumulative, including after native resume.
  A per-session/workspace high-water mark converts it to an incremental cost.
  The baseline is atomically saved under a cross-process file mutex before the
  cost is released; repeated/late results cannot count the same interval twice.
  Unknown resumed baselines, lower totals and failed or slow writes remain
  unmetered. A crash between baseline and usage writes can undercount, rather
  than double-count. Existing historical statistics are not rewritten.
  Budget enforcement uses provider-reported costs only; token-only engines do
  not gain an invented USD estimate from this change.
- An input-replay receipt conflicts with any observed execution, and a native
  session receipt conflicts with a different confirmed session ID: both stop
  recovery. Observed child/background work or tool calls without their completion
  receipts also withhold automatic continuation. Codex collaboration calls are
  tracked separately: completing a spawn/send call does not complete its child.
  A fresh child turn or a later running state reopens the guard; an older turn's
  completion cannot release newer work. This covers child work observed in the
  failed turn, not unrelated background work from an unobserved earlier turn.
  Provider credentials, quota, policy/configuration failures, explicit
  Stop, and native turn watchdog failures do not enter the recovery loop.
- If the window or total limit is exhausted, the conversation and completed work
  remain available for a later manual continuation. Nothing switches the model,
  resets the conversation, or restarts the host automatically.
- Recovery exhaustion, unconfirmed work and budget exhaustion are nonretryable
  to delegating agents, so a caller is not invited to resend the complete task.

## Native boundaries

| Engine | Automatic recovery boundary | Cases that remain nonautomatic |
| --- | --- | --- |
| Codex app-server | Exact foreground `turn/completed`, `status=failed`, with a transient structured `codexErrorInfo`; older versions may use the provider's error text, excluding subprocess diagnostics | Request-level RPC errors without a terminal/admission guarantee, unknown socket/process outcomes, transient `willRetry` notifications alone, side turns, interrupted turns, permanent/unknown structured codes |
| Claude stream | Foreground `result.is_error` from the still-registered native worker after the prompt was written, with a transient API status | Quota/session limits (including 429), stale or removed workers, unfinished background tasks or review, process exits, placeholders, Stop |
| DeepSeek Harness | Durable input admission followed by foreground `turn/end kind:error` with a transient LLM failure code | Other active turns, unanswered tools, live jobs, review, goal ownership, observation loss, unknown admission, quota/auth/configuration errors |
| Kimi ACP | No new automatic receipt | Current ACP can report provider failure as `end_turn`; a confirmed, attributable provider failure is required before adding recovery |
| Antigravity | No new automatic receipt | Its own internal retries remain; failed-turn persistence and worker cleanup are not sufficiently verified for an additional host continuation |

The shared `input` mode exists for adapters that can prove rejection before
execution. Codex's request-level JSON-RPC error alone is deliberately insufficient:
absence of a turn ID does not prove that nothing was admitted.

## CLI and protocol

App, headless CLI, scheduled work and Agent Bus use the shared Bridge. No new CLI
execution path or permission bypass is introduced. `messages wait` defaults to
120 seconds; `timeout` with `deliveryStatus: pending` ends only that observation.
Continue querying the same message ID. Do not resend the request because a wait
timed out. `--timeout` accepts up to 3600 seconds.

The client protocol remains version 1. Recovery is represented as an existing
`working` phase and a journal `text` entry named `engine_retry`; only safe reason,
attempt and delay labels enter the summary. Timeline milestones record waiting,
retrying, resumed, cancelled or failed without copying provider diagnostics into
the UI.

## Verification

Focused suites cover native terminal/error classification, preserving the real
session ID, continued work without original-input replay, abortable waits,
backoff and hard limits, worker-pool release, failed-attempt usage, budget/config
changes and contradictory receipts. Browser coverage exercises the real Bridge,
Core, Gateway and Hub with a deterministic adapter in Chromium and WebKit,
desktop light and phone dark layouts, cross-device Stop and client reconnection.
These are controlled failure injections, not a claim of physical-phone testing
or a live provider outage/recovery benchmark.

Opus 5.5 xhigh independently reviewed the recovery path and UI. Real isolated
Claude Code 2.1.307 runs against a local scripted API verified prompt retention,
`-r` context retention and cumulative cost semantics. A two-process ledger probe
recorded overlapping cumulative values once and retained all 81 session records.
Real isolated Codex app-server 0.163 runs confirmed that children can continue
after their parent fails; completed collaboration calls alone are not proof that
their child work stopped. No production credentials or historical usage were
changed by these probes.

The final frozen source passed `scripts/pre-complete-hook.sh`: 443 test files,
6,110 tests passed and 5 existing skips; standalone host and desktop/mobile
client builds passed; 77 native Rust tests passed. The final browser recovery
suite passed 2/2 in Chromium and 2/2 in WebKit, each checking desktop and phone.
The production App TypeScript graph also passed `tsc -p tsconfig.app.json`.

Independent review fixes include the original runtime deadline across recovery,
unfinished child/tool guards, nonretryable Agent Bus termination, monotonically
increasing backoff, delivery-repair answer boundaries, accurate retry labels and
Claude's durable cumulative-cost conversion. Controlled real Codex/Bridge probes
confirmed automatic continuation without children and a nonretryable retained
conversation with live children. The ledger probe covered real Claude resume
and overlapping writes by two processes.

This is a source checkpoint. It does not install or restart a production host,
replace desktop/mobile installations, publish the standalone CLI, or claim a
physical-device/live-provider outage test. Existing clients can retain the run
through protocol v1, but need the updated client bundle for the specific recovery
countdown and labels. Historical usage is unchanged.
