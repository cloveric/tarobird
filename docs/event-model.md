# Event Model

This document defines the lightweight timeline model written to `timeline.log.jsonl`.

It complements `audit.log.jsonl`:
- `audit.log.jsonl` remains the operator-facing historical log
- `timeline.log.jsonl` is the more structured turn/event stream

The project currently dual-writes both.

## Goals

- Make turn lifecycle and budgeting visible without reverse-engineering audit lines.
- Give dashboard/debug tooling a stable event stream.
- Keep the first version lightweight; do not require epoch/cursor machinery yet.

## File

- Path: `<stateDir>/timeline.log.jsonl`
- Format: one JSON object per line
- Permissions: directory `700`, file `600`

## Event Shape

Every event may contain:

- `timestamp`
- `type`
- `instanceName`
- `channel`
- `chatId`
- `messageThreadId`
- `conversationKey`
- `userId`
- `updateId`
- `outcome`
- `detail`
- `metadata`

`channel` is currently one of:
- `telegram`
- `bus`
- `lark`

App conversations use `channel=lark` with `lark:gw_` keys; UI labels them App.
`gateway` and `hub` occur in diagnostic/lifecycle logs, not this timeline enum.

## Event Types

Current event types:

- `input.received`
- `command.handled`
- `turn.started`
- `turn.completed`
- `turn.retried`
- `workflow.prepared`
- `workflow.failed`
- `workflow.completed`
- `tool.executed`
- `file.accepted`
- `file.rejected`
- `budget.blocked`
- `budget.threshold_reached`
- `cron.triggered`
- `cron.completed`
- `cron.skipped`
- `cron.disabled_after_failures`
- `crew.run.started`
- `crew.stage.started`
- `crew.stage.completed`
- `crew.run.completed`
- `crew.run.failed`

## Write Rules

### Queued asynchronous answers

Cancelling a submitted answer before its follow-up starts writes one
`turn.completed` with `outcome=skipped`, `source=card_action`, `action=choice`,
`phase=queue` and its stable `taskId` in metadata. Duplicate cancellation does
not create a second terminal record. The submitted answers remain visible;
ordinary stop still leaves unrelated pending FIFO work untouched.

### Telegram

- `input.received`
  Written at Telegram entry after callback ack / typing starts.
- `command.handled`
  Written for command paths that already go through shared command bookkeeping.
- `turn.started`
  Written before the ordinary bridge turn is sent to the engine.
- `turn.completed`
  Written when a Telegram update finishes with `success`, `error`, or other handled outcome.
- `turn.retried`
  Written when auth-refresh retry or stale-session retry is triggered.
- `workflow.prepared`
  Written when attachment/archive workflow state is materialized for the turn.
- `workflow.failed`
  Written when an unfinished workflow is marked failed in error cleanup.
- `workflow.completed`
  Written when workflow state is marked completed after a successful turn.
- `tool.executed`
  Written whenever a registered Telegram bridge tool is invoked, including `send.file`, `send.image`, `send.batch`, and cron tools. `outcome` is the structured tool status (`accepted`, `partial`, or `rejected`).
- `file.accepted`
  Written for each outbound local file actually delivered to Telegram.
- `file.rejected`
  Written for each local file reference rejected during delivery.
- `budget.blocked`
  Written when a turn is prevented from running because the instance is already over budget.
- `budget.threshold_reached`
  Written after usage is recorded and the configured budget is crossed.
- `cron.triggered`
  Written when a persisted scheduled task begins an execution attempt.
- `cron.completed`
  Written when a scheduled task reports success or failure.
- `cron.skipped`
  Written when a scheduled task fire is intentionally skipped, for example because the same job is already running.
- `cron.disabled_after_failures`
  Written when a recurring scheduled task reaches its configured consecutive failure threshold and is disabled.
- `crew.run.started`
  Written when a coordinator-led crew workflow starts.
- `crew.stage.started`
  Written when a crew stage begins.
- `crew.stage.completed`
  Written when a crew stage completes, including partial research results.
- `crew.run.completed`
  Written when the final crew output is delivered.
- `crew.run.failed`
  Written when a crew workflow fails before final output.

Topic-aware Telegram events may include:

- `messageThreadId`
- `conversationKey`

Mini Bus command audit metadata commonly includes:

- `command: "mini"`
- `action`
- `miniPeer`
- `miniTarget`
- `miniTargets`
- `verifier`
- `role`
- `errorCount`
- `stageCount`
- `skippedCurrent`

Mini crew reuses the same `crew.*` timeline event types as instance-level Agent Bus crew. Its audit records use `command: "mini"` and `action: "crew"`.

Board command audit metadata commonly includes:

- `command: "board"`
- `action`
- `boardTaskId`
- `assignee`
- `dependencies`
- `unmetDependencies`
- `promotedTaskIds`
- `runId`
- `targetKind`
- `targetName`
- `priority`
- `labels`
- `limits`
- `review`
- `checklistItemId`

Board commands continue to use the shared `command.handled` timeline event for cross-system observability. The authoritative task projection and append-only Board-domain event stream both live in the instance-local `kanban.sqlite`; Phase 2 mutations update the projection and append their Board event in one SQLite transaction. Audit/timeline entries remain best-effort cross-system evidence and are not the Board source of truth. Board events carry a monotonic sequence, board/task/run correlation, a credential-redacted payload, a hashed idempotency key when supplied, and an optional source actor. Default exports remove actor identifiers, detailed logs, and workspace paths.

### Bus

- `turn.started`
  Written when a bus handler accepts a validated request.
- `turn.completed`
  Written when the bus turn returns success or error.
- `budget.blocked`
  Written when a bus turn is rejected because the target instance is already over budget.
- `budget.threshold_reached`
  Written when a successful bus turn pushes the target instance over budget.

## Relation To Audit

Do not delete or replace `audit.log.jsonl` yet.

Current division of responsibility:
- `audit.log.jsonl`
  Best for operator history, human-readable troubleshooting, existing CLI commands
- `timeline.log.jsonl`
  Best for turn reconstruction, dashboards, future replay/debug tools

Practical rule of thumb:
- write to `audit` when the event answers "what action/result should an operator care about later?"
- write to `timeline` when the event answers "where is this turn in its lifecycle right now?"

Expected split:
- `audit`
  configuration changes, access decisions, command outcomes, bus/Telegram operator-visible success or failure records
- `timeline`
  input received, turn start/completion/retry, workflow lifecycle, file accepted/rejected, budget lifecycle events

Avoid dual-writing new concepts by default. Add both only when:
1. operators need a durable historical record, and
2. UI/debug tooling also needs structured lifecycle visibility

Current consumers of `timeline.log.jsonl`:
- dashboard summary cards
- `telegram timeline`
- `telegram service status`
- `telegram service doctor`
- App owner diagnostics in `runtime/diagnostics.ts`, through Hub/Gateway

The App diagnostic view reads existing audit/timeline records without changing
their event vocabulary or authoritative state. It includes current files and
retained rotations, validates original schemas, reapplies secret redaction and
uses `summarizeTimelineEvents` for the filtered incident counters. Gateway events
with a `lark:gw_` conversation key display as the App channel; the persisted
`channel=lark` remains unchanged. Counts cover retained readable records, not
all-time history. Missing files, read errors, damaged/oversized lines and unfinished
trailing writes remain distinct from a complete empty result. The diagnostic
page documents shortened detail rendering and expired pagination cursors.

Hub audit is a separate source backed by SQLite `audit_log`. Its reader uses a
fixed upper row ID per request, batches to allow ordinary service work between
reads, and returns owner-visible redacted records. Viewing/filtering records does
not create a second event ledger or replay any recorded operation.

Managed-worker exits audit `bot.worker_stopped` with `exitCode`, the rolling
ten-minute `recentFailures` count and `restartPaused`. A planned idle exit (75)
is informational; a crash is an error. `bot.worker_error` records a live child's
IPC/control error with its Bot ID and PID; it does not assert that the process
stopped. Raw error objects and credentials are not included. Shutdown of the
owning Hub does not generate a crash/retry event.

Gateway composer stop records the existing `command.handled` timeline event with
`detail=/stop`, its conversation key and `metadata.source=gateway.stop`. Outcome
is `success` when it cancels active work or a pending burst, otherwise `noop`.
`cancelledPendingBurst` counts dropped inputs. Each cancelled burst member retains
the shared `command.handled`/`batch-cancelled` terminal record, preventing false
interrupted-input recovery on restart. These are observed actions, not a queue of
future stops. Hub audits an incomplete group result as `request.rejected` with
`code=stop_incomplete`; that does not mean every member failed to stop.

Large Gateway final/background replies retain the same `delivery.recovered`
lifecycle and destination filtering. Their content is loaded and checksum-checked
from the body store before replay; a missing/invalid body produces the existing
error outcome and leaves the obligation failed. Successful recovery metadata uses
the resolved original response length, not the empty inline index placeholder.
No new execution event is synthesized and the original engine input is not rerun.

When the standalone Gateway's shared restart-loop guard trips, it writes
`service.startup_maintenance` to the existing lifecycle log and Bot audit with
`channel=gateway`, `recoverySkipped=true` and `uncleanBoots` in metadata. The
audit copy makes this service-level pause visible in App → Activity records;
it is not a fabricated turn event. The same readable notice goes to worker
stderr for managed service details. Fatal startup or cleanup records
`service.fatal` in the redacted lifecycle log. Guard state clearing requires a
successful complete shutdown, including cleanup.

The App Bot dashboard does not derive current liveness from an old `turn.started`
event or a saved session status. Gateway samples its shared runtime maps and
includes the sampling time; an unavailable process produces unknown live state.
Cron histories and crew stages remain persisted records with their own timestamps,
not new lifecycle events or proof of an active worker. Detailed execution events
remain available through the existing diagnostic timeline. No events are replayed
and no schedules or crew runs are started by opening this view.

Current status/doctor summary fields include:
- total timeline events
- last turn completion / retry / budget block timestamps
- incident counts for retries, budget blocks, file rejections, and workflow failures

Read-side rule:
- missing timeline log is acceptable
- unreadable timeline log should degrade to an operator-visible warning, not crash status/doctor

When a new lifecycle concept is added:
1. decide whether it needs structured timeline visibility
2. if yes, add a new timeline event or extend metadata additively
3. only then decide whether audit should also change

## Change Rules

- Add new event types; do not repurpose an existing type for a different lifecycle moment.
- Keep metadata additive when possible.
- Prefer writing through shared helpers instead of ad-hoc per-command append logic.
- When changing timeline semantics, update:
  - this file
  - `docs/entrypoint-map.md` if module ownership changes
  - relevant tests such as:
    - `tests/shared-turn-bookkeeping.test.ts`
    - `tests/gateway-service.test.ts`
    - `tests/core-reactions.test.ts`
    - `tests/artifact-delivery.test.ts`
    - `tests/bus-handler.test.ts`

## Native approval correlation

`EngineApprovalRequest.approvalScopes` declares the actual lifetime of its
legacy `once` / `session` decision keys. A missing key in an explicit declaration
means that choice is unavailable. Codex app-server, Claude streaming and Harness
declare session grants; one-shot Codex/Antigravity declare a whole-turn grant;
the one-shot Claude permission hook caches only for its current turn. Kimi
declares only advertised ACP choices and marks `allow_always` as an engine-owned
persistent option. One-time consent never falls back to `allow_always`.

The shared Lark/Gateway approval card, text fallback and resolved receipt show
the declared scope. Callback and text-command handlers reject unavailable
scopes without consuming the pending request. Legacy integrations that omit
this metadata keep their original labels. This metadata describes authority;
it does not change native policy, grant persistence or the Bot's approval mode.

`EngineStreamEvent.permission_request` has optional `toolUseId`, using the same
native identity as `tool_use`/`tool_result`. Claude control requests, Codex item
approvals, Kimi tool-call permissions and Harness call permissions now forward
that identity when provided. This is an additive in-memory event field; it does
not invent a journal sequence or repurpose an approval request ID.

The shared Lark/Gateway run renderer keeps one process row per native call ID
regardless of approval/start ordering. The start event supplies the actual tool
name/input when it follows an approval; later permission events cannot revive a
resolved row. Different IDs remain distinct even for identical tool names, and
uncorrelated legacy events retain their prior behavior. The separate approval
card and its decision/authorization logic are unchanged.

## Codex native questions and MCP forms

`item/tool/requestUserInput` and standard `mcpServer/elicitation/request` form
requests use the shared `AskUserQuestion` interaction. They retain request IDs
inside the adapter and question/property IDs inside the response normalizer;
display labels never replace native response values. Empty MCP schemas request
explicit one-time confirmation. Fields with no choices render a text input;
finite choices with `allowFreeText: false` cannot accept a forged Other value.

Questions are distinct from tool approval: bypass/full-auto does not answer for
the user. Native Codex may itself suppress elicitation according to its policy;
the adapter only handles requests actually emitted. Secret questions, URL/auth
and OpenAI-specific forms are cancelled rather than treated as ordinary text.

`item/permissions/requestApproval` uses the approval path instead of a question.
`codex-permissions.ts` validates the complete native profile, including legacy
read/write paths, constrained entries and network grants. Unknown constraints or
details exceeding the complete-card budget receive an empty grant. The displayed
profile is literal fenced JSON; a captured copy supplies the response, so neither
render callbacks nor `updatedInput` can widen it. Choices are explicitly whole
turn or native session. Bypass/full-auto does not auto-grant these requests.
Since installed 0.159.3 emits no ordinary tool completion for this interaction,
the adapter emits its correlated result after sending the decision. This closes
the permission row, not any later shell/file action. A progress-renderer failure
after sending cannot fail the native turn or produce another decision.

Interactions belong to a matching native thread/turn and child generation.
Stopping, completing, failing or losing that turn aborts the shared pending
card. A matching `serverRequest/resolved` also retires it; a late click cannot
write to a resolved request or a new child. MCP requests lacking a turn ID are
not assigned to a concurrent foreground turn when a Goal watcher makes ownership
ambiguous. Unsupported forms receive a protocol cancellation without failing
the whole turn.

## Public process journal (runs.v1)

App process detail is a bounded projection of existing EngineStreamEvent public events, not a new audit or execution authority. Exact tool call IDs correlate starts, approvals, progress and results; ambiguous id-less results do not close parallel tools. Tool completion, CLI result, delivery completion, stop acknowledgement and restart interruption remain separate. Ordinary, scheduled and goal turns share capture; existing audit/timeline semantics remain unchanged. Codex item starts and command output deltas now feed the existing public stream, retaining actual exit codes, durations and supplied diffs at completion. See [native run contract](client/native-run-presentation-2026-10-13.md).


Native App run evidence uses the same collector for Codex, Claude, Antigravity,
Kimi Code and DeepSeek. Each adapter retains public protocol evidence and exact
call IDs. ACP terminal truncation propagates as optional `tool_result.truncated`;
plans use native IDs where present so a nameless result cannot create a phantom
tool step. Repeated output snapshots emit only confirmed suffixes. DeepSeek
ordinary turns and goal watchers share result-block and actual diff extraction.
No adapter converts printed stdout into trusted exit status.

## Codex child activity receipts

`subagent_activity` is a public engine event with a native activity ID, kind
(`started`, `interacted`, `interrupted`, `completed`), child ID/label and optional
model/effort. The adapter accepts it only for the owning foreground or exact live
Goal turn. Shared `engine.event` timeline metadata stores this identity; it does
not create background-task liveness or settle the parent turn. The v1 process
journal stores deduplicated `text` entries named `subagent_<kind>` with status
`done` meaning the receipt was recorded, not that the parent work finished.
Native `collabAgentToolCall` items use the existing tool event pair and preserve
returned agent states. Activity receipts can arrive through either item start or
completion; both use identical ownership checks and journal deduplication.
Oversized agent-state JSON is bounded structurally, with explicit truncation,
rather than sliced into invalid JSON. The additive `runs.tail.v1` capability
enables latest/earlier journal reads without changing forward cursors, entry
ordering, retention or authorization. See [evidence and limits](client/codex-process-visibility-2026-10-18.md).
