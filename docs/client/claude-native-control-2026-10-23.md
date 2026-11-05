# Claude native stop, mid-turn input and task control (2026-10-23)

Historical 2.1.307 verification. For the locally verified 2.1.309 send-now protocol,
human-origin input and receipt distinctions, see
[the October 24 follow-up](claude-native-input-2026-10-24.md).

Scope: `src/codex/claude-native-control.ts`, `src/codex/claude-stream-adapter.ts`.
Shared Engine/Bridge/Core/Gateway/Hub/CLI and client wiring are out of scope
here; the proposed shared interface is listed at the end.

## Verified protocol (Claude Code 2.1.307, stream-json)

Sources: the stream-json schema bundled in the installed CLI and isolated
probes with the adapter's production flags (`-p --verbose --input-format
stream-json --output-format stream-json --include-partial-messages
--forward-subagent-text --permission-prompt-tool stdio`), synthetic prompts,
fresh temporary workspaces and native sessions.

| Native surface | Observed behavior |
| --- | --- |
| `system/init.capabilities` | Lists `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1` among others. All new behavior is gated on these; no version sniffing. |
| `command_lifecycle` | For every user message written with a `uuid`: `queued` → `started` → one terminal (`completed`/`cancelled`/`discarded`/`refused`). A message folded into a running turn emits `started`, then `completed` before that turn's `result`; a fresh turn's command emits its terminal state after the `result`. |
| `result.user_message_uuid` | Names the user message that opened the native turn; folded additions do not change it; Claude's own review turns carry `origin.kind:"task-notification"` instead. Used for exact attribution. |
| `interrupt.for_user_message_uuids` | Marked internal in the schema. Naming the running turn's message stops it (`turn:"stopped"`); naming another spares the running turn (`turn:"spared"`); naming a finished turn while idle answers `turn:"idle"`. A CLI that ignores the field behaves as a plain interrupt. Used only to narrow the stop to this host's own turn. |
| `--replay-user-messages` | Echoes a user message (`isReplay:true`, same uuid) when it is taken into the model input — the `started` moment — without admission or terminal states. Not enabled; lifecycle frames cover it. |
| `interrupt` | Success receipt `{still_queued:[…]}`; the running turn ends with `result{subtype:"error_during_execution", is_error:true}`; the process and native session stay usable (same-session recall verified). Background shells (`local_bash`) keep running and later trigger Claude's own review turn. **Background subagents (`local_agent`) are ended by this interrupt** (`task_updated killed`, `task_notification stopped`). The request has no field that preserves them; the interactive REPL's separate kill-agents gesture is not exposed in stream-json. |
| interrupt with no host turn running | Hits whatever Claude runs at that moment, including an automatic background-review turn. |
| user message during a turn | Default priority is folded into the running turn at its next model request (one `result`, answer uses the addition). `priority:"now"` aborts the running turn (empty `success` result, `terminal_reason:"aborted_tools"`) and runs the message as a new turn — not steering. |
| `cancel_async_message` | Withdraws a queued uuid (`{cancelled:true}`, lifecycle `cancelled`). |
| queued message at interrupt | Survives (`still_queued`) and starts ~1 ms later as its own turn unless withdrawn. `cancel_queued:true` would also drop uuid-less background task notifications, so it is not used. |
| `stop_task` | Stops one task. Terminal task frames precede the `{}` success response. The running foreground turn continues (the model may mention the notification). Errors include `Task X is not running (status: …)`. |
| task list | No list request. `background_tasks_changed` is a REPLACE level signal; `task_started`/`task_updated`/`task_notification` are edges. |
| stdin EOF with a background task | The CLI keeps running; forced cleanup still needs the process-tree stop. |

## Adapter behavior

- **App stop** (`APP_USER_STOP_REASON`): with both capabilities, the worker
  stays and the host turn settles only on Claude's confirmation: stopped (the
  interrupted turn's own `error_during_execution` result and terminal
  lifecycle), `EngineStopTooLateError` (receipt `idle`/`spared`, or a clean
  result for the stopped command), or `EngineCancellationUnconfirmedError` after
  10 s. Nothing is killed to make a stop look complete: an unconfirmed turn stays
  isolated; later input is never written or consumed as a failure — it waits
  (abortable by its own stop) until Claude settles the fence or an explicit
  recovery replaces the worker, then runs once. `isSessionInputBlocked(sessionId)`
  reports any open fence so the host can hold its queue instead. Only an
  explicit recovery, `forceStopSession` or a lifecycle shutdown stops the
  process. While a stop is unconfirmed, `listTasks` carries
  `recovery: { token, reason: "stop_unconfirmed" }`; `recoverSession(sessionId,
  { token })` accepts only that token of the current worker's current fence
  (anything else is `rejected/stale`) and returns `accepted` once the bounded
  process-tree stop is issued — not proof that the process already exited. The adapter interrupts, naming
  its own command, only while that command has `started`; a command still
  queued is withdrawn with `cancel_async_message`. Own uuids in `still_queued`
  are withdrawn; one that still starts is interrupted. A fence keeps every
  frame of the interrupted turn (matched by `result.user_message_uuid`) away
  from other turns and from the review machinery, and holds the next prompt
  until all fenced commands reached a terminal state and their open native turn
  emitted its `result`. Permission requests arriving meanwhile are denied
  without reaching the next turn's approver.
- **Other aborts** (shutdown, timeout, preemption, no reason) and CLIs without
  the capabilities keep the existing bounded process-tree stop.
- **Background ownership** is unchanged: tasks stay bound to the turn that
  started them. After a soft stop, surviving shells report to that turn;
  subagents ended by Claude's interrupt report their native `stopped` state to
  that turn instead of `engine_exit`.
- **Mid-turn input** (`steerActiveTurn`, `steeringCapability`): only while the
  turn's own command has started; writes the user's real text with a uuid and
  no priority; returns `true` on lifecycle `queued`/`started` (admission, not
  immediate effect). Rejections write nothing: `stale`, `queued`, `not_ready`,
  `unsupported`; an unacknowledged write throws (uncertain) with
  `throwOnError`. `onOutcome` reports `applied` (`fold` or `continuation`),
  `absorbed` (taken in by Claude's own review turn) or `dropped`. If the
  addition misses the fold, Claude runs it as its next native turn; the adapter
  treats that turn as the continuation of the same host turn and settles once
  with both segments' text and summed tokens; the held segment is never
  baselined, so the cumulative cost is charged once by the settling (or next)
  result. A continuation that never starts (30 s), ends unstarted, or is
  stopped settles with the finished first segment; unobserved drops add a
  visible notice. Withdrawn additions sit behind the fence until terminal.
- **Ordinary sends**: `inFlightSendBehavior = "steer"`;
  `supportsSessionSteering(sessionId)` is true only while that live worker's
  latest `system/init` advertised `msg_lifecycle_v1` (an init without the field
  revokes it).
- **Task control**: `listTasks` (live plus recently ended tasks, at most 128 in
  total; `foregroundStopScope: "subagents"` with the soft stop, `"all"` when only
  the bounded process stop is available; a task missing from the level is
  `unknown` until its own bookend names the outcome; with
  opaque per-worker ids, `kind`, `mode`, `status`, `canStop`, `progress`,
  additive `parentId`/`owner`), `stopTask` (native `stop_task` for a token of
  the current worker only; `accepted` / `rejected: stale|unsupported` /
  `unknown: uncertain`), `forceStopSession` (bounded process-tree stop).

## Shared interface (to be added to `adapter.ts` by the shared-layer change)

```ts
listTasks?(sessionId: string): Promise<EngineTaskSnapshot>;
stopTask?(sessionId: string, input: { taskId: string }): Promise<EngineTaskControlResult>;
steerActiveTurn?(sessionId: string, input: { text: string; throwOnError?: boolean; onOutcome?: (outcome: EngineSteerOutcome) => void }): Promise<boolean>;
steeringCapability?(): EngineSteeringCapability;
forceStopSession?(sessionId: string): Promise<boolean>;
```

`ClaudeEngineTask`, `ClaudeEngineTaskSnapshot`, `ClaudeEngineTaskControlResult`,
`ClaudeSteerOutcome` and `CLAUDE_STEERING_CAPABILITY` in the adapter are
structurally compatible.

## Limits

- Claude 2.1.307's interrupt ends background subagents; no native request
  preserves them without fabricated input. Background shells survive.
- A stop that coincides with the turn's natural end reaches an idle CLI
  (`turn:"idle"`), which the schema describes as handled like a plain interrupt.
- Before the first `system/init` of a new process, capabilities are unknown and
  a stop uses the bounded process-tree stop.

## Tests

`tests/claude-native-control.test.ts`,
`tests/claude-stream-adapter-native-control.test.ts`; existing
`claude-stream-adapter`, `claude-stream-adapter-retry`, `claude-scoped-events`,
`claude-side-session`, `claude-app-mcp`, `claude-turn-recovery` suites.
