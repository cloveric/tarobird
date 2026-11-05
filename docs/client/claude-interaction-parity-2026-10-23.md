# Claude conversation input and native task controls

Historical 2.1.307 verification. For the locally verified 2.1.309 send-now protocol,
human-origin input and receipt distinctions, see
[the October 24 follow-up](claude-native-input-2026-10-24.md).

This change aligns the App's foreground-input and task-control boundaries with
Claude Code's interactive workflow. Ordinary direct-chat text sent during a
native-capable Claude turn updates that turn. The explicit **Send as next turn**
action retains durable queue behavior. Attachments, quotations, group routing
and slash commands retain their existing delivery paths; the composer describes
the selected behavior. Other adapters keep their existing behavior unless they
explicitly opt in through the actual runtime capability.

Native acceptance means the CLI has received the instruction, not that a running
tool was interrupted or the model has already acted on it. Lost HTTP responses
retain the original request and target for receipt checks; they never silently
become new instructions or queued messages. A definitive pre-delivery rejection during ordinary Enter falls back to the
normal send path if the conversation and draft have not changed; explicit
steering, unknown outcomes and binding changes never silently queue. The original
rejected receipt remains in history with its text collapsed (expandable), followed
by the ordinarily sent message. This avoids presenting duplicate full text.

Native adoption outcomes update that original receipt through the negotiated
`steering.outcome.v1` durable RPC: applied, absorbed by native review, or dropped.
The model seeing input is not proof that it fulfilled the request. Early outcomes
survive a later admission response; only the addressed Bot may annotate its
user/request/conversation/target. Dropped input is never automatically replayed.
Old Hubs keep the native final notice; a rollback retires only unsupported outcome
observations from the outbox, preserving other replies.

## Task list and presentation

The conversation-local task strip and `/tasks` open a compact task list with
names, native states, foreground/background ownership and bounded public
progress and parent-task labels. Top-level stoppable tasks have individual controls. Child steps point to their
parent agent: stopping a shell step alone may cause that agent to retry it. **Stop all background tasks**
captures only the handles visible at that click, excluding the foreground and
tasks started later. Accepted requests remain distinct from confirmed terminal
states. Offline views retain the last observation and mark it unconfirmed.
Hidden conversation panes stop polling; navigation never stops native work.
Open task lists poll at 1.5 s, active collapsed lists at 4 s, idle lists at 30 s.
Unknown stops retain their original request ID for checking; a separate explicit
retry becomes available after a fresh snapshot confirms the same task is running.
No timer silently repeats a stop.

Scoped reply cards keep the task's display name. Short completed public replies
render directly in the bubble; long reports keep their full reader. Process
details and historical records retain the existing scoped-journal ownership.
The display-only label is not a session, task-control target or permission.

## Coexistence with the durable prompt queue

Steering never adds a delivery or changes the pending queue's revision, content
or order. Explicit next-turn input uses the original Hub queue. Queued prompts
keep their existing edit, move, cancel, permission and cross-device receipt rules;
individual native task stop does not consume or reorder them. Stopping the
foreground does not cancel the remaining Hub queue.

Independent queue review found and reproduced a less common failure: after an
unconfirmed native stop, claiming pending inputs could consume each as an error
without sending any to Claude. `canStartQueuedTurn` now checks the existing
session's native stop fence before `queue.take`. Blocked prompts remain in the
Hub, editable and cancellable; a 2 s recheck resumes automatically in their latest
order after native confirmation or explicit recovery. Disconnect clears those
checks. A newly selected binding reaches normal binding preparation instead of
waiting on the superseded session.

The native adapter also holds an input if a stop fence opens between the check
and the claim. It waits for that fence or its own cancellation, including beyond
the original stop-confirmation timeout; it cannot become a spurious failed
prompt. Explicit recovery reacquires the worker before writing this as-yet-unsent
input. The stopped original turn still reports its unconfirmed status. If Claude
never confirms and the user does not recover, work remains waiting; the task list
keeps the explicit recovery action visible. No automatic forced stop is added.

## Shared host and CLI

`client-protocol/engine-tasks.ts` defines bounded snapshots, opaque task handles
and control receipts. `gateway/engine-tasks.ts` resolves the existing binding,
rechecks it at dispatch and persists at-most-once receipts. Hub routes validate
the authenticated device, user/conversation membership and Bot membership, both
before dispatch and after the worker response. Old workers return unsupported;
the client never infers native capability from a model label.

`tarobot tasks list CONVERSATION --bot BOT` reads the same live snapshot.
`tarobot tasks stop CONVERSATION --bot BOT --task ID --request-id ID` controls
exactly that handle through the same authenticated API. A request ID can be
reused to check an uncertain result. It cannot stop a different task. A deliberate
retry uses a new ID after checking the still-running task; nothing retries on a
timeout. `tasks recover CONVERSATION --bot BOT --token TOKEN --yes` is available
only for an unconfirmed stop; its worker/fence token cannot affect a replacement
process, a different session or a later stop. The App confirmation states that
all background work in this session will end and lists observed active tasks.
A recovery receipt acknowledges dispatch, not observed process exit.
`tarobot steer status CONVERSATION --bot BOT` returns the current target;
`tarobot steer send CONVERSATION --bot BOT --target ID --text TEXT --request-id ID`
adds text to that exact target. Neither command starts a native session or
silently substitutes a queued turn. No desktop
window is required, and no new database schema or separate task executor exists.

Official behavior references:
- [Queued interactive input](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
- [Foreground and background subagents](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)
- [Persistent streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

## Native stop boundary

Claude Code 2.1.307's stream-json interrupt also ends background subagents, even
though its interactive terminal offers separate gestures. It preserves background
shells. The task snapshot reports this actual scope, and the App shows affected
background agents while the foreground is active. Individual task stop remains
independent. A foreground stop is not advertised as preserving all subagents.
This is a verified native protocol limit, not complete interactive-CLI parity.

The App instruction contract also requires observed native task state or task
notifications before claiming why work stopped. A new user message alone is not such
evidence; the model must not ask the user to stay silent to preserve background
work. This stable-instruction change causes a one-time resumed worker
reconfiguration on upgrade; existing background work defers that reconfiguration
through the existing retirement guard. No production worker was restarted here.

## Validation boundary

Implementation and independent review used actual **CC1 / Opus 5.5 xhigh**,
including a final targeted review of receipt/adoption and recovery authorization.
Native recovery and queue-fence changes are
`b00fa8876389186aa58a5e1a065691a9910a9185` and
`f568b22d124d40b94368e413dc64c4af024922df` (cherry-picked into the integrated branch). Root resolved both final findings:
the instance method allowlist and rollback replay gate, plus conversation-scoped
outcome lookup. The review also led to explicit unknown-stop retries, safe
ordinary-send fallback, parent-step guidance and slower idle polling.

Verified evidence under `/Volumes/gdrive/taro-tmp/claude-interaction-parity-20261023`:
- Host standalone build (437 modules), client TypeScript/translation checks and
  production build passed. The existing Capacitor mixed-import warning remains.
- Initial broad focused selection: 16 files / 354 tests passed (`final-focused.log`).
  Final changed-path selection including native recovery, Hub authorization,
  Gateway/workflows and CLI: 7 files / 133 passed (`review-final-unit.log`).
  Outcome/rollback transport and steering: 2 files / 16 passed
  (`review-outcome-transport.log`). Counts overlap and are not summed.
- Initial Chromium 43 and WebKit 40 regressions passed, covering scoped/public
  replies, tasks, input, draft retention and stop. After review fixes, Chromium
  15 and WebKit 11 changed-path regressions passed (`review-chromium2.log`,
  `review-webkit.log`), including the real Hub/Gateway outcome round trip and
  drained transport outbox. The first run caught the missing protocol method;
  one microphone fixture timing failure also passed on rerun without audio code
  changes. No whole-repository test claim is made.
- Real managed Claude Code **2.1.307**, Sonnet/low fixture: two actual background
  agents, default App follow-up adopted at a tool boundary, stopping alpha while
  beta and the primary continued, same-process recall, then stopping beta. The
  final integration check passed with a persisted native adoption receipt
  (`live-final-parity/.../claude-parity.json`).
- Real App foreground stop and same-process recall passed
  (`live-app-stop-final/.../stop-claude.json`): native acknowledgment plus aborted
  result, no process replacement, correct recall, and no replay after browser
  reload. This local run observed the native boundary after 9 ms and desktop/phone
  views after 62/65 ms; these are measurements, not a latency guarantee or proof
  of provider compute cessation. Earlier failures were stale test metadata lookup
  (`larkMessageId` instead of `messageId`), repaired in the observer assertions.
- The user's explicit queue-preservation requirement received another independent
  Opus review. Chromium and WebKit each passed 16 prompt-queue/integration cases
  (`queue-boundary-*.log`): edit/reorder/cancel with a running Claude turn, follow-up,
  uncertain follow-up, per-agent stop and final execution in the retained order.
  `queue-fence-before.log` records the reproduced pending-consumption bug;
  `queue-fence-final.log` includes 6 files / 114 tests covering the repaired path
  and native fences; the final 2-case gateway fence selection also verifies
  switching to a new binding (`queue-fence-binding.log`). After the receipt
  presentation change, Chromium and WebKit each passed 3 affected integration
  cases (`queue-final-ui.log`, `queue-final-webkit.log`).
- Real Claude queued-stop acceptance passed (`live-queued-stop-final/.../stop-claude.json`):
  two inputs were queued from the desktop and phone views while the original
  answer streamed. Both remained Hub-owned and editable/cancellable/reorderable.
  Foreground stop then dispatched them in order to the same native process;
  both returned distinct correct title recalls, and reloading both views caused
  no replay. Three native prompts and two successful follow-ups were observed.
  The first attempt stopped at an outdated assertion requiring eager worker
  delivery; the repaired assertion checks the current queue ownership before
  stop and actual native dispatch/completion afterward, without changing runtime
  behavior to satisfy the test. The fixture Host and transcripts were cleaned.
- Native unconfirmed-stop recovery tests verify exact-fence authorization,
  rejection after fence release/worker replacement and process cleanup. Normal
  stop confirmation never falls back to killing the process on a timer.

The real CLI journeys use paired desktop/phone browser contexts. They do not
establish physical iPhone/Android acceptance. This is a source change: no App
installation, production Host restart, package publication or release occurred.
