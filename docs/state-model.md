# State Model

This document describes the persistent on-disk state used by TaroCub.

The goal is to answer five practical questions for each file:

1. Where does it live?
2. Which module owns it?
3. What data is authoritative?
4. What are the write and recovery rules?
5. How sensitive is it?

This document covers both:

- **authoritative state**: files the runtime depends on for behavior
- **operational artifacts**: logs, inbox files, backups, and registry files that are useful but not the source of truth for core behavior

## Desktop and CLI Host directory identity

The desktop and headless CLI share one Host state directory, identity file, SQLite database and Bot tree. On Windows, equal path strings do not establish equal storage: MSIX AppData virtualization may expose a package-private view. The shared `host-cli/windows-state-admission.ts` gate and native probe reject packaged contexts and active shadow/conflicting state before creation. Missing identity alongside existing data is a recovery error, never permission to mint a replacement. Path and identity admission pipes supplement file locks across process views. Recovery comparison is read-only; no automatic merge or overwrite is allowed. See [Windows Host directory recovery](client/windows-host-directory-2026-10-19.md) for ownership, diagnostics, limits and rollback steps.

## Claude native pending-input receipts

Ordinary in-flight Claude inputs use the existing Hub message record with an
additive `steering.mode: "message"` and optional `nativeInput` progress. The
protocol schema validates admission, dequeue, model receipt and uncertainty as
separate states; no state means the user's task is complete. Legacy records
without `mode` retain explicit-steering semantics. No database migration is needed.

Gateway `gateway-receipts/` uses the shared `GatewayReceipts` / `JsonStore` owners
for `input.send:<author>:<request>` and `input.control:<author>:<request>`.
The receipt is written before the side effect. Stored request identity is checked
on a retry; an interrupted or uncertain operation never automatically resends
text or an interrupt. `input.progress` uses the existing durable transport outbox
and updates only its original author/conversation/Bot/target-bound message.
Replay is monotonic and idempotent. Unsupported optional progress is retired on
Hub rollback without blocking final-reply delivery.

The App's existing identity-scoped IndexedDB settings store holds
`draft:native-input:<conversation>:<bot>` (request, original target/text and
admission cleanup state) and `draft:native-control:<conversation>:<message>:<action>`
(the operation ID). Runtime schemas validate reads. Compare-and-swap transactions
preserve newer drafts and concurrent-window ownership. These recovery records
are not a second execution queue. The worker's native UUID mapping is transient;
a replaced worker cannot claim or control a prior process's input.

See [native input behavior and limits](client/claude-native-input-2026-10-24.md).

## Root Layout

Per-instance state lives under:

```text
~/.cctb/<instance>/
```

Typical files and directories:

```text
.env
config.json
access.json
session.json
runtime-state.json
usage.json
usage.last-good.json
file-workflow.json
cron-jobs.json
kanban.sqlite
kanban-assets/
mini-bus.json
delivery-obligations.json
restart-loop.json
audit.log.jsonl
instance.lock.json
workspace/
inbox/
service.stdout.log
service.stderr.log
```

Some related control-plane state lives one level above the instance:

```text
~/.cctb/.bus-registry.json
```

## Classification

The project should reason about state in four buckets.

### 1. Authoritative configuration

- `.env`
- `config.json`

These files define how the instance should run.

### 2. Authoritative runtime state

- `access.json`
- `session.json`
- `runtime-state.json`
- `usage.json`
- `file-workflow.json`
- `cron-jobs.json`
- `kanban.sqlite`
- `mini-bus.json`
- `delivery-obligations.json`

These files represent the durable control state of the instance.

### 3. Append-only or operational evidence

- `audit.log.jsonl`
- `service.stdout.log`
- `service.stderr.log`

These help with auditability and debugging, but the instance should not need them to compute its current truth.

### 4. Derived or transient artifacts

- `workspace/`
- `inbox/`
- backup archives
- `usage.last-good.json` (validated recovery snapshot for `usage.json`)
- migration leftovers
- `instance.lock.json`
- `restart-loop.json` (unclean-boot window for the restart-loop breaker; cleared on clean shutdown)
- `.bus-registry.json`

These files are important, but they are not all the same. Some are transient coordination files, others are user data or deliverables.

## Shared Storage Rules

These rules apply across most state files.

### JSON storage primitive

[src/state/json-store.ts](../src/state/json-store.ts:1) is the shared primitive for most structured state.

It provides:

- `ENOENT -> default` reads
- atomic temp-file + rename writes
- owner-only permissions on write (`0700` dirs, `0600` files)
- schema-version stamping
- downgrade protection when loading newer state
- quarantine support for unreadable/corrupt files

Implication:

- if a new state file is structured JSON, it should usually be built on `JsonStore`
- if a file is not using `JsonStore`, the code should explain why

### Concurrency rule

Atomic rename prevents partial writes, but it does **not** prevent lost updates in read-modify-write flows.

Stores that mutate counters or collections must serialize each read-modify-write transaction and every destructive recovery with the same file-scoped mutex across processes. A read that can quarantine/reset state must also hold that mutex; otherwise it can rename a newer writer's valid file as corrupt.

Current examples:

- `SessionStore`
- `RuntimeStateStore`
- `UsageStore`
- `FileWorkflowStore`
- `CronStore`

Some stores also keep an in-process promise queue to preserve call order, but that queue is not a substitute for the cross-process file mutex.

### Security rule

Anything under the instance state directory should be treated as private unless there is a strong reason otherwise.

That includes:

- bot token
- pairing/access policy
- session mappings
- usage/cost history
- workflow records
- scheduled task prompts and history
- audit events

## Per-File Model

## Historical transport `.env`

### Path

`<stateDir>/.env`

### Owner

The retired transport service and fleet CLI owned this file. Current App/Host
startup does not discover or initialize a Telegram transport from it. Existing
files remain private owner data; this retirement does not delete them.
Current explicit Bot integration environment loading is described in
[src/gateway/environment.ts](../src/gateway/environment.ts).

### Purpose

Stores the Telegram bot token for the instance when it is not provided through the ambient process environment.

The key field is:

- `TELEGRAM_BOT_TOKEN`

### Authoritative data

The token is authoritative if the service was started without `TELEGRAM_BOT_TOKEN` already set in the process environment.

### Write rules

- should remain owner-readable only
- should be updated without clobbering unrelated env lines
- should not be regenerated from runtime state

### Recovery rules

- if missing, the instance can still start if `TELEGRAM_BOT_TOKEN` exists in the process environment
- if missing in both places, startup must fail

### Sensitivity

Highest sensitivity.

Compromise of this file is effectively bot compromise.

## `config.json`

### Path

`<stateDir>/config.json`

### Owner

This file has multiple readers and writers.

Primary readers:

- [src/core/message-handler.ts](../src/core/message-handler.ts)
- [src/gateway/worker.ts](../src/gateway/worker.ts)
- adapter modules in [src/codex](../src/codex)

Primary writers:

- shared configuration APIs in [src/state/instance-config.ts](../src/state/instance-config.ts) and [src/runtime/permissions-settings.ts](../src/runtime/permissions-settings.ts)
- runtime updates in [src/core/message-handler.ts](../src/core/message-handler.ts)

### Purpose

Stores persistent instance configuration and a small amount of durable control state.

Important fields currently include:

- `engine`
- `approvalMode`
- `locale`
- `verbosity`
- `budgetUsd`
- `effort`
- `model`
- `claudeChrome` (optional boolean, absent defaults off): per-Claude-Bot Chrome
  launch policy. Owner-only App/CLI settings write it atomically with an optional
  UUID `_clientChromeRevision`; the revision detects stale on/off/on writes.
  Other config and session fields are preserved. Native workers apply changes
  between turns; existing foreground/background work is never terminated by a
  settings save. See [Chrome integration](client/claude-chrome-2026-10-17.md).
- `resume` (legacy migration input only; new bindings are stored per conversation in `session.json`)
- `bus`

### Authoritative data

This file is authoritative for instance configuration.

An old instance may still contain `resume`. Runtime code migrates that value onto the matching `session.json` record only when the owning session can be identified. New `/resume` and `/detach` writes never use the instance-global field.

### Write rules

- must be written atomically
- the state directory and `config.json` must remain owner-only (`0700` and `0600`) even when replacing a pre-existing file with broader permissions
- inspection and service-construction readers tolerate a missing file; execution
  readers require a readable config object with valid permission fields and block
  a turn if it is missing, unreadable or malformed. A valid empty object retains
  the established defaults. Repairing the file allows the next turn without
  resetting the conversation.
- runtime should not silently overwrite unreadable/corrupt config
- a web-console engine change clears incompatible provider-session bindings and commits the config update under one session transaction; if the config write fails, the original session bindings are restored before the mutex is released

Current behavior depends on purpose:

- inspection/service-construction reads may log parse failure and use defaults;
  native execution validates permissions separately and refuses damaged config
- configuration commands can recover malformed JSON or a non-object root using
  normal approval, after making and syncing an exclusive backup copy (and its
  parent directory where supported). The original stays in
  place until a synced replacement is ready for atomic rename. Backup or write
  failures cannot turn damaged config into missing config or overwrite a backup
- transient read errors still abort the write. New-instance missing-file setup
  retains the documented defaults; explicit permission writes can override the
  recovery mode

### Recovery rules

- missing file can be initialized with fresh instance defaults; it cannot authorize
  a native turn until a valid config exists
- malformed files block execution. A repair-capable command keeps an exclusive
  backup and normal approval, or the operator repairs the original directly

### Sensitivity

Private configuration. It can contain a Bus shared secret as well as instance
topology, peers, legacy resume state, model selection and operator intent.
Do not commit a real instance's configuration or recovery backups.

## `access.json`

### Path

`<stateDir>/access.json`

### Owner

[src/state/access-store.ts](../src/state/access-store.ts:1)

### Purpose

Stores Telegram access policy and pairing state.

Schema:

- `policy: "pairing" | "allowlist"`
- `pairedUsers[]`
- `allowlist[]`
- `pendingPairs[]`

### Authoritative data

This file is authoritative for:

- who is allowed to talk to the bot
- whether pairing or allowlist mode is active
- outstanding pairing codes

### Write rules

Current writes are read-modify-write operations serialized in-process and across processes. Status reads that can trigger corruption recovery use the same file mutex as mutations.

### Recovery rules

- missing file -> default state:
  - `policy = pairing`
  - empty allowlist/pairs/pending codes
- corrupt JSON or invalid shape is quarantined and reset to the fail-closed default (`pairing`, no authorized chats) on a repair-capable operation
- transient I/O and permission errors are rethrown rather than mistaken for corruption

### Sensitivity

High sensitivity.

Leaking this file exposes pairing codes, authorized chats, and chat/user linkage.

## `session.json`

### Path

`<stateDir>/session.json`

### Owner

[src/state/session-store.ts](../src/state/session-store.ts:1)

### Purpose

Maps Telegram and Lark conversations to provider session identifiers and conversation-scoped resumed workspaces.

Schema:

- `chats[]`
  - `conversationKey` (canonical private-chat/group/topic identity)
  - `telegramChatId` (numeric compatibility key; Lark uses a stable derived value)
  - `telegramThreadId` (Telegram topic, when present)
  - `codexSessionId`
  - `resume` (provider session metadata plus resumed workspace root)
  - `suspendedPrevious` (binding restored by `/detach` when available)
  - `status`
  - `updatedAt`

### Authoritative data

This file is authoritative for durable conversation -> engine session and resumed-workspace binding.

Bridge persists an engine-confirmed binding even if its ID equals the provisional
ID (Harness can accept that ID as its durable session). Repeated session events
and the final result share bind deduplication. A one-off `sessionIdOverride`
does not replace the conversation binding. Process restart must reopen this saved
mapping; successful streaming alone is not evidence that it was persisted.

When no binding exists, SessionManager issues a fresh UUID-suffixed logical
`telegram-` identifier. Reusing a deterministic chat-derived placeholder would
reopen old DeepSeek Harness history after `/reset`, because Harness can retain
the supplied identifier as its native ID. Existing bindings, including legacy
`telegram-<chatId>` native IDs, are returned unchanged. Fresh placeholders are
not persisted until an engine confirms the binding.

Background goals publish their native session during startup, under the same
conversation lock as ordinary turns and reset/resume/detach. They release this
lock after the binding is durable so conversation can continue. The terminal
goal result does not overwrite a later reset/resume; native cleanup uses the
watch's confirmed session rather than re-reading the current conversation.
Replacing a live Lark/App goal waits for the prior pursuit's cleanup.
Conversation locks include the canonical SessionStore path, so separate Bot
instances serving the same Telegram user do not serialize each other. Explicit
shared native sessions still use the native-session lock.

It lets Telegram private chats/topics and Lark private chats/groups/topics continue independently across process restarts. A `/resume` in one conversation cannot change the file-delivery root or provider session of another conversation.

### Write rules

- reads and writes are serialized with a cross-process file mutex; writes also retain in-process ordering
- updates are upsert-style by canonical `conversationKey`, with legacy chat/thread keys normalized on read/write
- removal supports recovery behavior on corrupt state
- `clearAllThen()` holds the session mutex across session clearing plus its durable companion update, and restores the original bindings if that update fails

### Recovery rules

This store has the best repair story in the project today.

It can:

- inspect unreadable state without throwing to the outer system
- distinguish repairable vs non-repairable failures
- quarantine corrupt files to `*.corrupt.*.bak`
- reset to an empty default state when safe to do so

### Sensitivity

Moderate to high sensitivity.

It exposes chat IDs and engine session identifiers, which are operationally sensitive even if not credential-equivalent.

## `runtime-state.json`

### Path

`<stateDir>/runtime-state.json`

### Owner

[src/state/runtime-state.ts](../src/state/runtime-state.ts:1)

### Purpose

Stores polling progress.

Current schema:

- `lastHandledUpdateId`

### Authoritative data

This file is authoritative for "how far Telegram polling has durably advanced".

### Write rules

- reads and writes are serialized with a cross-process file mutex; writes also retain in-process ordering
- updates are monotonic: lower update IDs do not replace higher ones

### Recovery rules

- missing file -> `lastHandledUpdateId = null`
- invalid file throws

This file matters because if its semantics drift from update acknowledgment semantics, the system can either replay or lose updates.

### Sensitivity

Low sensitivity, but high correctness importance.

## `usage.json`

### Path

`<stateDir>/usage.json`

### Owner

[src/state/usage-store.ts](../src/state/usage-store.ts:1)

### Purpose

Stores cumulative token and cost accounting for the instance.

Schema:

- `totalInputTokens`
- `totalOutputTokens`
- `totalCachedTokens`
- `totalCostUsd`
- `requestCount`
- `lastUpdatedAt`

### Authoritative data

This file is authoritative for user-visible cumulative usage and budget comparisons.

### Write rules

- read-modify-write
- candidate records are schema-validated before persistence
- writes are serialized both in-process and across processes
- a successful write updates `usage.json`, then `usage.last-good.json`

Important nuance:

`usage.last-good.json` is recovery state, not a second independently mutable
ledger. Callers must always read and mutate through `UsageStore`.

### Recovery rules

- missing file -> zeroed counters
- invalid primary + valid `usage.last-good.json` -> quarantine the primary,
  restore the validated snapshot, and continue
- invalid primary + missing/invalid backup -> throw `UsageStateCorruptError`
  and leave the corrupt primary in place (fail closed; never reset budget usage
  to zero)

### Sensitivity

Moderate sensitivity.

It reveals usage volume, cost, and activity timing.

## `cron-jobs.json`

### Path

`<stateDir>/cron-jobs.json`

### Owner

[src/state/cron-store.ts](../src/state/cron-store.ts:1)

### Purpose

Stores persistent Telegram scheduled tasks.

Schema:

- `jobs[]`
  - `id`
  - `chatId`
  - `userId`
  - `chatType`
  - `cronExpr`
  - `prompt`
  - `description?`
  - `enabled`
  - `runOnce`
  - `targetAt?`
  - `sessionMode` (`new_per_run` by default for new jobs; `reuse` only for explicit continuation jobs; older persisted jobs keep their stored value until updated)
  - `mute`
  - `silent`
  - `timeoutMins`
  - `maxFailures`
  - `createdAt`
  - `updatedAt`
  - `lastRunAt?`
  - `lastSuccessAt?`
  - `lastError?`
  - `failureCount`
  - `runHistory[]`

### Authoritative data

This file is authoritative for which scheduled jobs exist and whether they are enabled. Before a `runOnce` executor can cause effects, queue admission atomically persists an optional `runOnceExecution` claim and sets `enabled=false`. The claim contains an ID, actual start time, manual/scheduled trigger, PID and available native process epoch. A revision check prevents two schedulers from admitting the same configured one-shot. Existing records without claims remain readable; even older readers preserve the disabled flag. Successful/failed completion clears only its own claim. A confirmed dead owner is recovered as `unknown`, with an unconfirmed-result history/error and no automatic retry or failure-count increment. Live or unverifiable owners are not stolen. This is an at-most-once admission boundary, not exactly-once side effects: a crash after the claim write can leave zero or partial effects. Users must check the outcome before explicitly re-enabling a task; changing its target time also rearms it. A manual `/cron run` on an enabled one-shot still consumes that one-shot, as before; it does not silently rearm a disabled/unknown task.

For App/Feishu shared conversation queues, `timeoutMins` starts when the queued executor is admitted, not when it is enqueued. Scheduler shutdown records a `cron.skipped` interruption rather than increasing task failure counts. A one-shot still waiting in the queue at clean shutdown remains enabled, and cancellation during the claim write releases it only if the claim/revision still belongs to that unstarted execution. An already admitted one-shot interrupted by shutdown remains disabled and reports an unconfirmed result. Persistent claim writes are required for admission: a storage error prevents execution. App/Feishu and optional Telegram executors await the admission callback at their actual queue/notification boundary. Recurring jobs track consecutive `failureCount`, keep the latest 10 `runHistory` entries, and are disabled when `failureCount >= maxFailures`. Use `/cron mode <job-id> new_per_run` to update older recurring jobs that were persisted with `sessionMode: "reuse"` before isolated cron runs became the default.

### Write rules

- built on `JsonStore`
- writes are serialized per `CronStore` instance
- scheduler and `/cron` commands should share the active runtime store where possible

### Recovery rules

- missing file -> no scheduled tasks
- invalid file throws and prevents the cron runtime from starting
- operator repair should quarantine/reset this file rather than silently dropping jobs

### Sensitivity

High sensitivity.

It can contain durable prompts, chat IDs, user IDs, schedule intent, and last error details.

## `kanban.sqlite`

### Path

`<stateDir>/kanban.sqlite`

Related migration and asset paths:

- `<stateDir>/board.json` becomes a fail-closed sentinel after migration
- `<stateDir>/board.json.migration-<timestamp>-<id>.bak` retains the exact legacy source
- `<stateDir>/kanban-assets/` is the private owned-attachment root

### Owner

[src/state/board-service.ts](../src/state/board-service.ts:1) owns the shared use-case boundary and typed errors. [src/state/sqlite-kanban-repository.ts](../src/state/sqlite-kanban-repository.ts:1) owns schema, transactions, migration, permissions, and diagnostics. [src/state/board-store.ts](../src/state/board-store.ts:1) remains the current domain-behavior and compatibility facade behind the service.

### Purpose

Stores durable, instance-isolated Kanban task state for `/board` commands. It is intentionally separate from Mini Bus and Agent Bus topology: the board tracks work, while bus layers decide who can execute work. There is no cross-instance global board.

Schema version 1 created `meta`, `boards`, `board_contexts`, `tasks`, `task_dependencies`, `task_labels`, `checklist_items`, `artifacts`, `attachments`, `comments`, `runs`, `claims`, `events`, `notification_subscriptions`, and `migration_history`. Phase 1 created the complete table set so Phase 2 could activate richer records without adding tables. Schema version 2 rebuilds only `events`: its task and run IDs are immutable audit correlations rather than foreign keys, so deleting mutable task/run rows cannot erase historical associations. Phase 2 uses these tables for boards, scheduling, parent/child links, comments, attachments, claims, authoritative events, subscriptions, dispatcher state, and richer run evidence.

Current `BoardService` compatibility projection (stored across normalized tables):

- `nextTaskId`
- `nextRunId`
- `tasks[]`
  - `id`
  - `title`
  - `status`: `triage`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`, or `archived`
  - `description?`
  - `acceptanceCriteria[]`
  - `priority`: `low`, `normal`, `high`, or `urgent`
  - `labels[]`
  - `checklist[]`
    - `id`
    - `text`
    - `done`
    - `createdAt`
    - `completedAt?`
  - `artifacts[]`
    - `kind`
    - `value`
    - `createdAt?`
  - `review`
    - `required`
    - `reviewer?`
  - `assignee?`
  - `dependencies[]`
  - `workspace?`
    - `mode`: `default`, `dir`, `worktree`, or `scratch`
    - `path?`
    - `branch?`
  - `blockedReason?`
  - `summary?`
  - `createdAt`
  - `updatedAt`
  - `completedAt?`
  - `createdBy`
    - `chatId`
    - `userId`
    - `messageThreadId?`
    - `conversationKey`
  - `runs[]`
    - `id`
    - `status`: `running`, `review_requested`, `succeeded`, `done` (legacy read alias), `failed`, `blocked`, `cancelled`, or `timed_out`
    - `startedAt`
    - `lastHeartbeatAt?`
    - `heartbeatNote?`
    - `completedAt?`
    - `summary?`
    - `error?`

### Authoritative data

This database is authoritative for Board and task ids, task status, dependencies, parent/child links, schedules, assignees, blocked reasons, completion summaries, claims, comments, attachments, subscriptions, dispatcher state, the append-only Board event stream, and run history/evidence.

It is also authoritative for card metadata used by planner/dispatcher flows: description, acceptance criteria, priority, labels, checklist, artifacts, review requirement, optional workspace metadata, run heartbeat evidence, and WIP limits.

It is not authoritative for access control, Mini Bus peers, or Agent Bus peer configuration.

### Write rules

- all production channel operations enter through `BoardService`
- each state transition uses a short SQLite `BEGIN IMMEDIATE` transaction
- mutations accept an optional expected revision and idempotency key; stale revisions fail closed, raw idempotency keys are hashed before persistence, and successful replays return the first result
- every Phase 2 mutation appends an authoritative Board event in the same transaction as its projection update
- task, comment, event, run-log, error, and export strings pass through the shared credential-pattern redactor before persistence or delivery
- foreign keys, WAL mode, a bounded busy timeout, full synchronization, and owner-only permissions are enabled
- normalized tables and constraints protect task ids, dependency edges, run ids, and the one-active-run-per-task invariant
- task ids are normalized as `B<number>`
- dependency completion promotes waiting `todo` tasks to `ready` when all dependencies are done
- WIP limits are enforced before a task can start a new run
- default WIP limits are `global=3`, `perAssignee=1`, and `perConversation=1`
- `/board plan <goal>` creates a task graph from the current engine's JSON output and stores the resulting dependencies atomically
- `/board heartbeat <id>` updates the active run's `lastHeartbeatAt` and optional `heartbeatNote`
- `/board recover [minutes]` closes stale running attempts as failed and blocks those tasks for operator review
- `/board worktree <id> [path] [branch]` stores optional per-task workspace metadata; task metadata by itself does not grant access or change bus topology
- starting a task is rejected while dependencies are incomplete
- dependency cycles are rejected when adding a dependency
- each `start` creates one run attempt; duplicate concurrent running attempts are rejected
- `/board run <id>` starts one ready task, sends the task card to its assignee, then closes the run as done or failed
- `/board run <id>` resolves assignees by preferring Mini Bus peers in the current group, then falling back to Agent Bus instance names
- `fail` closes the active run as failed and moves the task to `blocked`
- blocking a running task closes its active run as failed before moving the task to `blocked`
- tasks with `review.required` move to `review` after completion and record the run as `review_requested`; dependents are promoted only after approval
- claims use expiring opaque lease tokens in the owner-only database; lease tokens are excluded from events and exports, and a stale claim generation cannot be mistaken for a later worker's claim during idempotent replay
- automatic dispatch is opt-in per board, honors WIP/schedule/dependency/retry constraints, and recovers expired claims/runs before deciding whether a circuit breaker permits new work
- owned attachments are copied under `kanban-assets/` by content hash after realpath, symlink, size, and digest validation
- export omits actor identifiers, detailed logs, and workspace paths by default; import validates the complete graph and all identifier collisions before publishing assets or state
- completed tasks retain their original source chat/topic metadata for auditability

### Recovery rules

- neither database nor legacy file -> initialize a private empty `main` board
- valid legacy `board.json` -> validate it, copy an exact owner-only backup, import into a temporary database, reconcile counts/integrity/foreign keys/cycles/active runs, atomically publish, then replace the legacy path with a fail-closed sentinel
- invalid legacy JSON -> abort before database creation and leave the source unchanged
- failed relational import -> leave `board.json` authoritative and unchanged; retain any backup already taken
- existing empty, corrupt, newer-schema, or conflicting database/legacy state -> fail closed with an actionable error; never reset to an empty board
- a published database with the matching unswapped legacy source -> finish the interrupted sentinel step using the recorded migration receipt
- old/missing counters are normalized from the maximum stored task/run ids
- stale-run recovery scans active runs directly, so it also repairs legacy task/run status drift
- expired active claims atomically time out their run, block the task, remove the claim, and append `task.claim_expired`; expired idle claims return to their prior schedulable state
- repair creates an owner-only backup before reconciling expired claims and inconsistent task/run projections; destructive repair and asset GC require explicit confirmation
- migration backups are never deleted automatically

### Sensitivity

High sensitivity.

The database, WAL/SHM files, retained migration backups, exports, and asset directory can contain durable task titles, operator intent, summaries, chat IDs, user IDs, topic IDs, local paths, and workflow topology hints. Credential-pattern redaction reduces accidental secret retention but does not lower this classification. They are mode `0600` (files) or `0700` (directories).

## `mini-bus.json`

### Path

`<stateDir>/mini-bus.json`

### Owner

[src/state/mini-bus-store.ts](../src/state/mini-bus-store.ts:1)

### Purpose

Stores Telegram group-local Mini Bus configuration. A Mini Bus lets one bot treat different topics in the same allowed group as named peers.

Schema:

- `groups`
  - `<chatId>`
    - `peers[]`
      - `name`
      - `chatId`
      - `messageThreadId?`
      - `conversationKey`
      - `createdAt`
      - `updatedAt`
    - `parallel[]`
    - `chain[]`
    - `verifier?`
    - `roles`
      - `researcher?`
      - `analyst?`
      - `writer?`
      - `reviewer?`
    - `crew`
      - `maxResearchQuestions`
      - `maxRevisionRounds`

### Authoritative data

This file is authoritative for Mini Bus peer names, default fan/chain order, verifier selection, and Mini crew role mapping inside each Telegram group.

It is not authoritative for Telegram access. Group access still comes from `access.json` and `config.json` group mode settings.

### Write rules

- built on `JsonStore`
- writes are serialized with a file mutex so concurrent topic registrations do not clobber each other
- peer names and role names are normalized before persistence
- removing a peer also removes references from `parallel`, `chain`, `verifier`, and `roles`

### Recovery rules

- missing file -> no Mini Bus peers configured
- invalid file throws and prevents Mini Bus command handling from using stale or partial state
- old records without `roles` or `crew` are normalized with default empty roles and default crew limits

### Sensitivity

Moderate sensitivity.

It reveals group chat IDs, topic IDs, peer topology, and operator workflow intent. It does not contain bot tokens or engine credentials.

## `file-workflow.json`

### Path

`<stateDir>/file-workflow.json`

### Owner

[src/state/file-workflow-store.ts](../src/state/file-workflow-store.ts:1)

### Purpose

Tracks attachment and archive processing workflows that span multiple Telegram messages.

Schema:

- `records[]`
  - `uploadId`
  - `chatId`
  - `userId`
  - `kind`
  - `status`
  - `sourceFiles`
  - `derivedFiles`
  - `summary`
  - `summaryMessageId?`
  - `extractedPath?`
  - `createdAt`
  - `updatedAt`

### Authoritative data

This file is authoritative for in-progress and resumable file-processing state, especially archive workflows that wait for a follow-up `/continue`.

### Write rules

- writes and corruption recovery are serialized with a cross-process file mutex; writes also retain in-process ordering
- ordinary snapshot reads rely on atomic replacement and do not mutate or quarantine state
- records are append/update/remove by `uploadId`
- status is mutated over time; `updatedAt` is refreshed on mutation

### Recovery rules

Like `session.json`, this store supports:

- inspect-with-warning
- corruption detection
- quarantine to backup
- reset-based repair

This is important because users can still receive successful Telegram output even if bookkeeping later fails.

### Sensitivity

Moderate sensitivity.

It contains local file paths, chat IDs, and summaries of processed content.

## `audit.log.jsonl`

### Path

`<stateDir>/audit.log.jsonl`

### Owner

[src/state/audit-log.ts](../src/state/audit-log.ts:1)

### Purpose

Append-only operational and forensic event log.

Each line is an `AuditEvent` with fields such as:

- `timestamp`
- `type`
- `instanceName`
- `chatId`
- `userId`
- `updateId`
- `outcome`
- `detail`
- `metadata`

### Authoritative data

This file is **not** authoritative for current runtime truth.

It is authoritative only as a historical record of what the system attempted and reported.

### Write rules

- append-only JSONL
- best effort in some call sites
- no compaction semantics

Callers should never rely on this file for reconstructing canonical current state.

### Recovery rules

- malformed lines are ignored by parsers
- summaries are best-effort over whatever lines remain parseable

### Sensitivity

High sensitivity.

It may contain prompts, error details, chat IDs, workflow metadata, and operational clues.

## `instance.lock.json`

### Path

`<stateDir>/instance.lock.json`

### Owner

[src/state/instance-lock.ts](../src/state/instance-lock.ts:1)

### Purpose

Ensures only one service process owns an instance state directory at a time.

Schema:

- `pid`
- `token`
- `acquiredAt`

### Authoritative data

This file is authoritative only for process exclusivity at startup/runtime, not for user-visible behavior.

### Write rules

- created with exclusive write (`wx`)
- stale file is removed only after verifying the recorded process is dead
- release checks both `pid` and random `token`

### Recovery rules

- missing file is normal
- stale file is automatically pruned
- live holder means startup must fail

### Sensitivity

Low confidentiality sensitivity, high coordination importance.

## `service.stdout.log` and `service.stderr.log`

### Path

- `<stateDir>/service.stdout.log`
- `<stateDir>/service.stderr.log`

### Owner

These historical fleet log names belonged to the removed transport service
commands. Existing logs remain untouched. Current Host service registration is
owned by [src/host-cli/service-manager.ts](../src/host-cli/service-manager.ts),
which writes `hub.log` in the explicit Host directory.

### Purpose

Operational logs for managed background service processes.

### Authoritative data

Not authoritative for runtime behavior.

Useful for diagnosis only.

### Write rules

- append as process output streams
- subject to rotation via [src/state/log-rotation.ts](../src/state/log-rotation.ts:1)

### Recovery rules

Safe to truncate or rotate.

### Sensitivity

Moderate sensitivity because logs may include prompts, errors, config paths, and stack traces.

## `workspace/`

### Path

`<stateDir>/workspace/`

### Owner

Created by service/adapters, then effectively co-owned by the engine and the user.

### Purpose

The instance working directory.

This is where:

- engine tasks operate
- `CLAUDE.md` may live
- generated files may be created before Telegram delivery
- resumed-session workspace alignment matters

### Authoritative data

Not canonical bridge control state, but authoritative as the working tree the engine sees.

### Write rules

- contents are not schema-managed
- should be treated as user/engine data, not config

### Recovery rules

Backed up and restored as part of instance archives.

### Sensitivity

Potentially very high, depending on project contents.

## `inbox/`

### Path

`<stateDir>/inbox/`

### Owner

Telegram delivery and workflow code.

### Purpose

Stores downloaded Telegram attachments and quoted files for local processing.

### Authoritative data

Not authoritative long-term control state, but important transient input material for workflows.

### Write rules

- created on demand
- contains downloaded user data

### Recovery rules

Safe to treat as ephemeral operational data, but note that in-progress workflows may still reference files under it.

### Sensitivity

High sensitivity because it contains raw user attachments.

## Backup archives (`*.cctb.gz`)

### Path

User-chosen output path, not a fixed in-place state file.

### Owner

[src/state/archive.ts](../src/state/archive.ts:1)

### Purpose

Portable backup/restore format for an instance state directory.

### Authoritative data

A backup is authoritative only as a snapshot artifact, not as live state.

### Write rules

- skips symlinks
- skips oversized files
- skips regenerable dependency/VCS/scratch directories and operational logs by default
- streams source file bodies through gzip rather than buffering the complete archive
- rejects manifests above 10,000 files and archives above the 128 MiB expanded-format limit
- writes a gzipped custom archive format through a private temporary file before atomic replacement

### Recovery rules

- restore validates archive magic and version
- restore prevents path traversal
- restore rejects compressed inputs above 64 MiB, expanded archives above 128 MiB, manifests above 10,000 files, and individual members above 100 MiB
- restore expands and copies members through bounded streams instead of loading the complete archive or every member into memory
- restore reapplies restrictive permissions

### Sensitivity

Highest sensitivity.

A backup may contain nearly the entire private state of an instance.

## `.bus-registry.json`

### Path

`<channelRoot>/.bus-registry.json`

Where `channelRoot = dirname(stateDir)`, usually `~/.cctb/`.

### Owner

[src/bus/bus-registry.ts](../src/bus/bus-registry.ts:1)

### Purpose

Shared control-plane registry of locally running instances participating in the bus.

Schema:

- `instances[instanceName]`
  - `port`
  - `pid`
  - `secret`
  - `updatedAt`

### Authoritative data

This file is authoritative for local instance discovery on the bus.

It is not part of a single instance's isolated state; it is shared across sibling instances.

### Write rules

- cross-process file mutex around read-modify-write, with a synced temporary
  file atomically renamed into place; this is coordination state, not `JsonStore`
- liveness is verified via `/api/health`, not by trusting the file alone

### Recovery rules

- a missing registry starts empty; malformed/unreadable state is preserved and
  reported as an error rather than overwritten
- a failed probe hides a target from active discovery but does not by itself
  delete its registration
- pruning requires a confirmed dead PID and the exact probed registration still
  present under the file mutex; a new registration wins over an old probe

### Sensitivity

High sensitivity for local control-plane security because it contains bus secrets and routing info.

## Optional shared turn pool

`src/runtime/turn-pool.ts` owns `os.tmpdir()/tarocub-turn-pool/turns.json`, or the
explicit `TAROCUB_TURN_POOL_PATH`. It is enabled only when
`TAROCUB_MAX_CONCURRENT_TURNS > 0`. The lease file retains its existing shape
and path so an upgrade does not silently create a second concurrency allowance.

Every mutation takes the file mutex and replaces the file atomically after
syncing its bytes. Invalid JSON, invalid lease records, unsafe file types and
unsafe default directory ownership/modes refuse admission and preserve the
original file. It is unsafe to recover by assuming an empty lease list: already
running tasks could then exceed the cap.

Recovery is explicit: stop **all** services sharing the pool, preserve the
damaged file for diagnosis, then remove it from the configured path and restart
those services. For an unsafe location, inspect it and use one private location
for all participating services. Moving only some services splits the limit.
Unknown liveness and platform-specific native checks are not proof of no work.

## Files That Are Not Canonical State

These files may exist under the state directory but should not be treated as authoritative business state:

- `runtime.log`
- rotated logs like `audit.log.jsonl.1`
- `engine-home.migrated-*`
- temporary `*.tmp` files
- transient Telegram-out directories

They matter operationally, but no feature should depend on them as the sole source of truth.

## Current Gaps

These are the most important state-model gaps in the current code.

### 1. `config.json` has multiple owners

That is manageable, but only if all writers keep using atomic write and we stay disciplined about which fields are runtime state vs operator config.

### 2. Not every JSON store has the same repair semantics

`session.json` and `file-workflow.json` are more mature here than `access.json`, `usage.json`, and `runtime-state.json`.

### 3. Some coordination files do not use `JsonStore`

That is not automatically wrong, but the difference should be intentional and documented.

### 4. Shared-state files and per-instance files are easy to conflate

`.bus-registry.json` is not just another instance file. It belongs to the local mesh, not one bot.

## Recommended Next Steps

1. Keep this file updated whenever a new persistent file is introduced.
2. Normalize repair behavior across state stores where it materially helps operators.
3. Remove the legacy `config.json.resume` compatibility path after all supported upgrade windows have migrated.
4. Keep `docs/security-boundaries.md` aligned whenever a state file changes trust or sensitivity.

## `gateway-group-mode.json`

Owned by `src/gateway/group-mode.ts` in each Bot state directory. Runtime-validated
`modes` maps Hub `gw_` conversation IDs to `all` or `at`; a missing entry inherits
the Gateway's default mention requirement. An explicit `at` overrides even an
instance configured to accept all messages. JSON writes retain private modes,
atomic replace and a file mutex. Invalid state is refused without overwriting it.
For existing development state, a positive `gw_` entry in `lark-group-mode.json`
is read as `all` only when the new file has no explicit choice. New settings never
write the Feishu file, so later Feishu group changes cannot erase an explicit
App policy. Full Hub bundles include this Bot-owned file automatically.

## `delivery-obligations.json`

### Path

`<stateDir>/delivery-obligations.json`

### Owner

`src/state/delivery-obligation-store.ts`. Written by shared Core final delivery and the Gateway boot-time recovery sweep.

### Purpose

Durable delivery-obligation ledger (Hermes-inspired): one row per outbound final engine response with checkpoints around the send (`pending` → `attempting` → `delivered`/`failed`). A row reaches `delivered` only after every requested artifact and text chunk receives a definite success; a rejected or ambiguous artifact ACK keeps the row failed and the turn partial. On boot, `sweepRecoverable` claims undelivered rows whose owning process is dead and `src/core/delivery-recovery.ts` redelivers them — plainly for `pending` (send never started), with a visible ♻️ recovered-reply marker for `attempting`/`failed` (the platform may already have the message; honest at-least-once, never a silent duplicate).

### Write rules

- Atomic tmp+rename writes serialized by a file mutex; every operation is best-effort and must never block or fail an actual send.
- Attempts are capped (3) and rows older than 24h are `abandoned` — a poison reply cannot crash-loop redelivery, and a day-old reply never suddenly reappears.
- Bounded index: settled rows pruned after 7 days, 200-row cap. Default platform
  recording retains its 200,000-byte inline ceiling. Gateway final responses and
  background-task notifications explicitly opt into out-of-line bodies above that
  ceiling; other platform recording behavior is unchanged.
- Large Gateway bodies live in `delivery-bodies/<sha256>.json`: a JSON string
  preserving the exact response, including Unicode and unpaired surrogates. The
  index has empty `content` and `contentRef: {sha256, bytes}`. Body writes use a
  private temporary file, fsync and atomic rename before the index commit, under
  the same ledger mutex. A metadata-only read or state update never loads all
  response bodies. Recovery resolves one body at a time and verifies regular-file
  type, exact length, SHA-256 and JSON-string shape before running delivery guards.
  Invalid/missing bodies fail recovery; they never become empty successful replies.
- The body directory is 0700 and files 0600, cannot be a symlink, and resolution
  accepts only validated hashes, never paths. After index mutations, unreferenced
  owned body/temp filenames older than seven days may be collected; referenced
  and young orphan files are kept. Shared hashes remain until all referencing
  retained rows are gone. Full Hub backups include managed Bot body directories.
- Kill-switch: `CCTB_DELIVERY_LEDGER=off` disables recording and sweeping.
- Gateway ordinary turns retain the existing `channel=lark` ledger format. Before
  claiming or expiring rows, recovery selects `gw_` chat IDs for Gateway and all
  other Lark IDs for Feishu; neither surface changes the other's attempts/owner.
  Gateway attaches one boot sweep after journal replay and before pending input
  receipts can retire interrupted turns. Its callback restores the conversation
  and ChannelProfile for native uploads and unlimited card formatting. A resumed
  send writes `attempting` before any visible publication, including a row that
  was originally pending. Ambiguous recovery remains visibly at-least-once.
- Recovery parses persisted responses through the normal guarded artifact pipeline. It may replay `send.file`, `send.image`, `send.audio`, `send.video`, `send.batch`, and whole-response `file:` blocks, but it strips cron and all other side-effect tools rather than executing them again.
- Artifact identity uses the real file (device/inode, with canonical-path fallback), so structured and legacy tags cannot resend one file through symlink, hard-link, or case aliases.
- Image cards split only after an explicit platform size rejection. Timeout, disconnect, and other ambiguous acknowledgements stop without an immediate retry and surface a “request a resend” notice.

### Recovery rules

Corrupt file → treated as empty and rewritten on the next record; never fatal.

## `restart-loop.json`

### Path

`<stateDir>/restart-loop.json`

### Owner

`src/runtime/restart-loop-guard.ts`.

### Purpose

Rolling window of UNCLEAN boot timestamps (boot recovered a stale service lock = previous run died without clean shutdown). Three unclean boots inside 10 minutes trips the breaker: that boot skips boot-recovery work (interrupted-turn marking, delivery-ledger redelivery) so a poison replay cannot keep killing a supervised service; live traffic is still served. Operator restarts shut down cleanly, release the lock, and are never counted; a clean shutdown also deletes this file.

Standalone App Gateway workers now use this same guard and file. Handled fatal
startup/shutdown errors record an unclean ending before releasing their lock, so
clean lock removal cannot hide an exception loop. A completely successful stop
or idle restart clears the window; a failed cleanup retains it. A guarded boot
skips file-workflow/turn recovery and final-delivery sweep for that process only.
It neither deletes the pending obligations nor bypasses the transport's durable
publication journal. Existing delivery age/attempt/retention bounds still apply
when a later boot resumes recovery. Invalid configuration or ordinary runtime
failures are not repaired by this guard.

### Recovery rules

All failures fail OPEN (no trip). Delete the file to manually reset the window.

## Client Hub file-center annotations

`src/hub/file-center.ts` owns `<hub>/file-center-labels.json`, version 1. The
runtime-validated document holds a global revision and labels keyed by the shared
scanner's 24-character unit ID. Labels carry optional category, important flag and
note (500 characters maximum), an ISO update time and a per-unit revision. Writes
use a file mutex and private atomic JSON replacement. A patch must match the
current unit revision; stale clients receive a conflict without replacing newer
data. Clearing fields keeps the revision record, preventing ABA and legacy reimport.
Corrupt authoritative Hub state is rejected and never silently rewritten.

The Hub imports original Console labels only for units in a completed scan that
have no Hub record yet. Unrelated labels are not imported; existing Hub values
and cleared records win. Original Console state is never modified. Malformed
legacy metadata produces a visible warning and is left intact. This is an initial
import, not bidirectional synchronization with the original Console.

Inventory snapshots are derived, in-memory state. A single cancellable background
scan serves all devices, and failure/cancellation preserves the previous snapshot.
Hub restart requires another scan; annotations survive. Poll revisions include
the Hub epoch, scan and label revisions, scan status and a minute bucket so unchanged
polls omit the full inventory while activity badges can age. Scanner evidence is
retained separately from labels so resetting a category restores automatic
classification without scanning again. Offline full Hub bundles include the label
file with private permissions; database-only backups do not include this JSON file.

## Client Hub Bot and topic ownership

`src/hub/database.ts` migrates Hub databases through schema 10. Schema 10 adds `profile_avatars`, including PNG bytes and revision tombstones, so online database and full-state backups preserve avatars. Schema 9 adds `conversations.binding_id` for one-time session binding selections. Native session state remains Bot-owned; `gateway-bindings/` stores durable application receipts.
An explicit owner clear sets both selection columns to NULL using an atomic
`expectedBindingId` comparison; it does not undo native state or discard a
corrupt receipt. An empty destination has an explicit null previous-session
snapshot so native Claude detach can restore the unbound state.
Client IndexedDB outbox entries persist retry count, first failure and retry time.
A monotonic transactional order key survives reload/manual retries. Failed entries
remain visible (including card submissions) and pause their conversation until
retried or explicitly removed; other conversations can progress.
`conversations.parent_id` links a topic to a root group; topic creation copies its
user and Bot memberships in one transaction and creates a fresh conversation ID,
without copying `session_id`. History, sequence/read cursors and engine session
keys remain independent. Archived groups block new topics and new topic sends.
`managed_bots` records owner-scoped creation receipts and initial specifications.

`src/hub/bot-manager.ts` owns only `<hub>/bots/<generated-id>/`. Each directory
contains a private `gateway.key`, ordinary `config.json`, `session.json` and an
automatically created `workspace/` unless the owner chose an existing folder.
The normal config updater and engine compatibility rules remain authoritative.
Initial specifications never overwrite later `/model` or `/effort` edits. The
Hub supervises one Gateway-only process per managed Bot and restores it on boot.
Its in-memory crash window allows three automatic retries (1/2/4 seconds), then
pauses after a fourth failure within ten minutes. Older failures age out; planned
exit 75 clears the window. Manual restart clears a stopped worker's budget;
Hub restart resets this in-memory budget. The worker's separate persisted
`restart-loop.json` continues to govern recovery work. Live children remain owned
through IPC errors until their actual exit, preventing duplicate workers.

Managed restart operations reuse `GatewayReceipts` under
`<hub>/bot-operations/<bot-id>/gateway-receipts/<sha256>.json`. The key includes
the operation and validated client receipt ID. A durable running receipt precedes
the side effect; the final result follows it. Replaying the same receipt returns
its saved result, including an uncertain result, without another restart. An
interrupted receipt requires a new explicit operation. These private files are
included in full state backup/restore, not database-only snapshots. Control IPC
uses a separate random request ID and matching child PID; a queued receipt means
the worker accepted the request, not that a replacement is online.

Existing Lark/Telegram instance directories are
not imported or modified by this flow. Hub database backups alone do not include
these instance directories. `hub backup --full` now adds an offline, versioned
directory bundle containing the checkpointed database, identity, attachments,
incomplete chunks and Hub-owned instance/workspace state. The final manifest has
strict runtime validation, per-file sizes/hashes, explicit operational exclusions
and external dependency reporting. `hub restore` validates then restores only to
the absent original Hub path; existing directories are never merged or replaced.
This preserves absolute workspace bindings without rewriting arbitrary persisted
text/engine state. Native engine login/history and externally selected workspaces
remain separate dependencies. `restore.incomplete.json` blocks ordinary database
opening until a restoration has passed every check. See the operations guide for
format, size bounds, symlink handling and recovery procedure.

Schema 7 stores selected preview URLs and server-read link metadata; schema 8 adds
an optional, validated `messages.preview_style` (`card`/`inline`). Missing styles
render as cards. Selection is immutable after send and survives metadata updates,
forwarding, replay and snapshots. A received preview's temporary reading fold is
local component state, outside message history and Bot delivery bookkeeping.

Hub `config.json.maxFileBytes` owns the upload policy (default 512 MiB). The
authenticated connection's `ready` carries it to the client. iOS stores only this
public staging hint in the App Group inbox's `.limits.json`; Android uses the
private `tarocub-share-limits` preferences. Clearing the share inbox also resets
the hint. Neither cache contains a device key or token, and the Hub revalidates
current size policy on upload-init and unfinished chunk/completion writes.

Attachment collection marks unreferenced aged IDs in the existing
`retired_attachments` table before deleting bytes. Unlink failures retain the
attachment row for retry; only after file removal are attachment/chunk rows
removed. Upload chunk/completion publication rechecks the live, unretired row
inside the database guard around final rename and row update. This prevents a
collector racing an upload from accepting bytes for an already retired ID.
Legacy DB-first leftovers are collected only for exact owned filenames whose
row is absent and file age exceeds the cutoff; that scan does not follow symlinks.
Exports and backup validation exclude retired attachments, allowing collection
interrupted after file removal to recover without blocking backup. Active blobs
and unfinished chunks remain mandatory. Read-only backup snapshots predating the
retirement table keep their existing validation path without a schema migration.

Long Bot replies remain complete canonical messages and full durable events.
`fragments.v1` only changes physical WebSocket framing, not the database schema,
message ID, version, search text or forwarding snapshot. Gateway stores the
complete request in `gateway-outbox.json` before transmitting any fragment.
Receiver fragments are socket-local memory only: partial or invalid transfers
cannot update history/cursors; reconnect starts from durable state. Consistent
snapshot staging receives each logical message only after full verification.

HTTP history and event replay pages now select lightweight IDs/sequences before
decoding content. History targets 6 MiB and replay targets 4 MiB; one complete
logical message/event can occupy its own larger page. `nextBefore` and `more`
reflect all remaining records, so clients must follow cursors rather than infer
completion from item count. CLI history GET responses allow 33 MiB for that
single-message case; other CLI response limits are unchanged. No text truncation
or event-sequence rewrite is introduced.

Gateway delivery receipts remain in `<instance>/gateway-receipts/`; a `running`
receipt at restart is not permission to repeat a side effect. Once outstanding
publications are replayed, authenticated `delivery.fail` atomically settles that
Bot's pending Hub delivery to `failed`, preserves completed output, retires its
unfinished/actionable reply cards, and writes one recovery notice plus audit event.
The notice ID hashes both Bot and source message, so multiple Bots can fail the
same group input independently. `ack` only changes `pending` to `accepted`; late
publications on a failed input cannot restart its visible state. No schema bump
is needed for this additional delivery state. Standalone workers also use the
shared six-hour timeline scan to mark interrupted accepted input terminal.

### Hub history search reads

`HubStore.search` serializes searches on a separate queue and opens/closes a
readonly WAL connection for each query. Its single SELECT sees committed state;
slow one/two-character searches no longer occupy the mutation/authentication
queue. Message writes maintain `messages_fts` in the same transaction as blocks.
No persisted schema or reindex is required. Matching remains literal substring
search, with SQLite LIKE's existing ASCII case behavior. Indexed LIKE candidates
omit ESCAPE; `%`/`_` queries add a second escaped predicate to verify exact literal
characters. This preserves backslashes and avoids interpreting MATCH operators.
[SQLite FTS5 documentation](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)
explains why ESCAPE disables trigram acceleration and terms without a three-code
point literal sequence fall back to scanning. Filters and membership remain in
the same SQL statement. Results are newest first, with message ID as a stable
secondary key, capped at 100 full messages. Pagination and payload-size budgets
for many huge matching messages are not established by this change.

### Hub audit diagnostic snapshots

`readHubDiagnostics` uses a separate readonly WAL transaction and at most one
active diagnostic reader per Hub. A fixed committed upper ID and 250-row batches
keep the page, complete retained totals, filter options and last outcome times
consistent even when maintenance deletes rows. It never joins the mutation/auth
queue; HTTP authorization is rechecked against live state before the result is
returned. Disconnect/shutdown aborts the scan between batches, queued cancelled
requests never open a connection, and `finally` closes readers on success or
error. `HubServer.close()` waits for accepted HTTP work before closing the writer.
The bundled SQLite driver already provides a finite 1,000 ms busy timeout for
readonly connections. A read pins its WAL snapshot until it closes; the existing
90-day/100,000-row audit retention, finite upper ID, bounded batches and disconnect
cancellation prevent an endless live append scan. No silent truncation or partial
statistics are returned to satisfy an arbitrary display limit.

### Hub push notification receipts

`push_outbox` stores operational payloads and retries; terminal rows older than
seven days are eligible for maintenance. `push_receipts(id,device_id,message_id)`
stores only the deterministic notification identity, without its text. It commits
with the message/outbox and is not expired when transport rows are pruned. The
identity includes device, message and notification kind, so editing a completed
message does not alert again while new messages or a different outcome can.
Opening a compatible database and retiring old outbox rows both backfill retained
legacy identities; an insert guard also protects against old compatible writers.
Already-pruned historical transport rows cannot be reconstructed.

Receipts follow message/device lifetime through foreign keys; permanently revoked
device identities can be cleared. Personal deletion or a shared message tombstone
does not count as physical deletion and does not re-arm notifications. This is
compact durable state proportional to retained messages/devices, not a fixed-size
cache. Notification disabling and quiet hours retain their existing behavior;
this change does not redefine whether an edit after that period should notify.
Provider/native display titles use `TaroBot` or the conversation name. The strict
wire payload still carries the historical `title:"TaroCub"` discriminator so
installed clients can validate notification actions; changing that value alone
would make valid notifications fail schema validation. Identity domains and
stored historical payloads are unchanged.

### Cross-Bot upload permit retention

`bot-messages:incoming:*` and `bot-messages:outgoing:*` retain their existing
content-conflict and no-repeat contracts; maintenance does not delete them.
Upload permits are a separate authority check bound to source host/Bot, target
Bot/conversation and attachment ID. They are not short-lived passports and are
still required when a previously committed send is explicitly retried.

Upload permit values keep the original `{requestId}` representation. Only a
newly created permit gets a `bot_message_upload_permits` row linking its meta
key to an attachment ID and a monotonic `used` flag. A new row starts used if
that attachment already has a message reference. An `AFTER INSERT` trigger on
`message_attachments` marks all tracked permits for the referenced attachment
used in the message transaction; failed writes roll this back. This also
protects compatible schema 19 writers that know nothing about the new table.
Attachment-ID indexes keep reference writes and initial reference checks out
of full meta scans. Repeating upload initialization never resets tracking or
classifies an old untracked permit as unused.

Garbage collection deletes only tracked permits explicitly marked unused whose
attachment row is physically gone; deleting their meta row also deletes its
tracking row. Retirement alone is insufficient. Used tracking has no attachment
foreign key, so it survives physical attachment deletion. Used permits and old
hashed permits without consumption provenance are retained, so a
shared tombstone whose bytes were collected can still return its original
duplicate receipt under the existing guard order. This reduces abandoned-upload
orphans; it does not impose a total hard limit or retroactively classify legacy
records as unused.

## Client device revocation recovery

The existing IndexedDB `settings` store can hold `revokedIdentity`, a serialized
pair of device ID and pinned Hub public key. Only a notice received after the
verified socket handshake writes it, with current-identity and cache-generation
checks in the transaction. Startup leaves that identity disconnected and shows
the re-pairing reason while preserving cached conversation history. Local reset
or identity replacement clears the record. No schema/version migration is needed;
unrecorded/offline revocations remain subject to Hub authentication rejection.

## App native tool receipts

`app-tool-threads/` records the installed dynamic-tool schema version for each hashed
native thread ID. `gateway-receipts/` durably records each native call before its
side effect and its result after acknowledgement. Successful file results include
the canonical path and SHA-256 of the actual uploaded bytes. These are private
Bot runtime records, never user persona or project instructions.

A user turn additionally owns an in-memory content-publication cache and confirmed
receipts shared by automatic repair attempts. They prevent native/legacy replay
while allowing an updated file at the same path, or an explicit resend in a later
user turn. A crash still uses the durable uncertain-call policy; the memory cache
does not assert transactional delivery or replace the receipt journal.


### Desktop ADHD layout (HostRegistry meta)

`tarocub-hosts-v1` stores `meta["adhd-board-v1"]` as a versioned JSON value with
column preference and up to 12 ordered `(hostId, registrationId, conversationId)`
references. `client/src/adhd-board-state.ts` validates reads and writes, rejects
malformed/duplicate references and bounds sizes. Writes are atomic IDB puts and
serialized per board; this is a last-saved local presentation preference, not
host-authoritative state or cross-window collaborative editing. No history,
attachment bytes or credentials are copied. Unavailable targets remain visible
placeholders; read failures preserve the original record and allow retry/exit.
Re-pairing cannot bind a saved panel to a new registration. Mode/focus/expansion
are transient. [Behavior](client/adhd-board-2026-10-17.md).

### Complete client drafts (IndexedDB schema 7)

`conversationDrafts` stores unsent attachment/finished-recording bytes and file
metadata, quotes, preview choice/style and recipient selection. It is separate
from downloaded attachment caches and is never LRU-evicted. A pairing-owned
cache and explicit Hub/device/public-key owner fence prevent cross-host reuse.
Writes compare revisions atomically, including empty revision tombstones;
a late receipt clears only the matching local fields and cannot overwrite a
newer window's draft. Text remains in the existing `settings` draft entries.

Offline draft storage allows 32 files and 64 MiB (including metadata) per
conversation, 128 MiB per pairing, 1 MiB metadata per draft and 1,000 active conversation drafts (empty CAS tombstones do not count). These are local persistence limits, not upload limits. Failure
retains visible content, warns before browser unload and offers retry; directly
sending oversized drafts remains possible. Abrupt OS termination before a save
receipt cannot be guaranteed. Active microphone capture is not persisted until
recording finishes. Cached drafts survive revocation for local recovery, but
revoked identities cannot write. Explicit host removal/local reset and pairing
replacement clear drafts with the other pairing-owned stores; old generation
handles cannot restore them. No restoration path sends a message automatically.

Clean in-memory rich drafts are revalidated when re-entering a conversation or
when its window regains focus/visibility; sends remain unavailable during that
read. Pending writes, local edits and failed saves are never overwritten by this
refresh. Identity replacement includes a changed device public key, even when
the device ID and Hub public key remain the same.

## Hub schema 13: bounded public run details

`run_journal` belongs to the Hub database, keyed by message/run/step with revision, Bot and conversation ownership. Runtime schemas live in `client-protocol/run.ts`. Details are separate from canonical messages, bounded to 2,000 records / 8 MiB per run, and become unreadable after 30 days; write-time and daily maintenance purge expired rows. Recall deletes rows, while conversation deletion cascades. Full and SQLite backups include this table and retain their existing independent policies. Upgrade is additive; older Hub versions must restore a pre-upgrade backup to downgrade. See [native run contract](client/native-run-presentation-2026-10-13.md).

Claude background-report provenance is additive `card.extra.backgroundTask`
v1 metadata (`origin: bound | unattributed`), not a new Hub schema. `replyTo`
links only verified original App requests; forwarding drops live provenance.
Run journal child progress uses existing `text`, final tool output uses `output`,
and background start/end receipts use `kind: text` with an event name and task
call ID. Existing ownership, retention and size limits apply. The final card's
background note is a snapshot at turn completion, not live task status.
See [Claude continuity](client/claude-card-continuity-2026-10-14.md).

### Claude interrupted-turn receipts

Each Claude Bot's `claude-turn-recovery.json` is optional, private host state
owned by the stream adapter. It stores at most 64 session/workspace hashes,
observed tool-call/result counts, timestamps and at most eight pending tool
names. It does not copy prompts, commands, output or reasoning, and does not
modify native Claude transcripts or Bot persona files. A known interruption,
process failure or graceful host shutdown records observed foreground work;
abrupt host termination before that point is not covered.

The next user turn in that exact native session and workspace receives these
facts as private context, with explicit unknown-outcome and no-replay rules.
A successful foreground result clears its receipt. Other Bots, sessions,
workspaces and child/background scopes cannot consume it. Malformed or failed
receipt storage falls back to memory; it is neither a task queue nor proof of
completion. Desktop hosting and headless CLI use the same adapter/state path.
No Hub schema, membership or protocol change is required.

Optional receipt reads/writes have a one-second deadline. In-memory updates are
ordered independently of disk writes, which coalesce to the latest state. A
stalled write cannot block the next prompt or hold adapter shutdown indefinitely.
An unreadable or newer file is preserved, and late reads cannot replace newer
in-memory facts. After storage failure the adapter retains memory-only receipts;
an underlying OS write already in progress may still finish, so durability is
not claimed after that failure. Broken stdin uses the common worker-failure path
to capture observed work and reject the actual active turn, including delayed
write callbacks. See [the upgrade audit](client/cli-upgrade-audit-2026-10-15.md).

## Local cross-process mutex ownership

`withFileMutex(target)` uses a local Bakery ticket directory at
`target.mutex.lock`. Each acquisition publishes an immutable UUID directory
whose name includes PID, host digest and available boot/process identity. It
publishes its integer number atomically, then scans the participants again and
waits in integer-number/ticket-ID order. Recovery removes only a proven-dead
owner's unique ticket. A live or unverifiable owner is never removed because of
age. Release publishes a `released` marker before deleting ticket contents;
Windows cleanup failures preserve that marker for later cleanup. Only an empty
shared container may be removed with nonrecursive `rmdir`.

Unknown, choosing and foreign-host owners have a five-minute wait limit with
PID, host digest, epoch and elapsed-wait diagnostics. A verified live owner can
hold a model turn longer; management callers can set an explicit wait bound.
Waiters may pass an AbortSignal. Cancelling a queued waiter retires only its
own ticket and never releases or bypasses the predecessor; Bridge and Kimi
startup waits use the active turn's signal. Ticket and instance-lock records
include boot UUID plus native process start identity on Linux/macOS, and
process-creation identity on Windows, so a known reused PID does not strand
startup. Linux uses `/proc/<pid>/stat` start ticks; macOS uses the native `ps`
start timestamp (second precision). Older boot-only tickets remain readable
and conservatively bounded.
When identity queries fail, recovery remains conservative. Legacy live
`target.lock/owner.json` records block; proven-dead legacy records are removed
without modifying the new ticket container. Simultaneously running old and new
binaries against one state directory is unsupported.

This protocol requires a local filesystem with normal cross-process visibility
(such as APFS, ext4 or NTFS); network filesystems and cloud-synchronized state
directories are unsupported. This is a deployment constraint, not a claim that
`doctor` detects every unsupported filesystem. Both lock-container names end in
`.lock` and are excluded from host snapshots and runtime-update backups.


## Shared media transcripts (2026-10-22 audit)

`<Host-state>/media-transcripts/` is a disposable private cache owned by
`runtime/media-transcript-cache.ts`. Gateway supplies the conversation and
attachment identity only after the normal authorized download. Keys additionally
hash the downloaded bytes and effective local/cloud configuration. Bot state
paths are not keys, so separate Worker processes can reuse a recording across
group recipients and discussion rounds. The existing process-identity file mutex
serializes each key; it does not serialize unrelated recordings.

Directories use 0700, result files 0600. Results expire after 24 hours and each
encoded result is at most 1 MiB; periodic pruning targets 128 completed entries
(per-process scans at most once per minute, so short bursts may exceed that
count). Old files are removed on subsequent use, not by a background timer.
Failed, partial, empty or cancelled work is never cached. Cancellation of a
waiter does not stop the owner. Cancelling the owner aborts its existing pipeline;
another active recipient may then retry. This is not an exactly-once guarantee
across process death, cancellation, expiry or failed cache persistence.

No Hub schema migration or new API is introduced. Cache loss does not lose a
message or its source attachment; a later authorized request transcribes again.
The cache is not a user-export endpoint and is not added to Hub database backups.

The transient `media-transcripts/` directory is excluded from Host backup/restore;
transcripts are recomputed after restoring an otherwise authorized attachment.

## Fixed reports and local widget quarantine

Report cards persist typed version-1 data in `extra.report` and a script-free
preview in the existing `extra.widget` v1 envelope. Forwarding preserves the
extra data; older readers keep the preview and summary. No schema migration is
needed. Fixed-reader selection and filtering are local transient state. Series visibility and row selection survive view/expansion changes but reset when their source dataset changes. Custom widget state remains local to its Worker lifetime unless the author explicitly saves a small selection through `tarobot.state`; that bounded cache is window memory only, best-effort and not durable. A successful widget compose request appends through the ordinary conversation draft writer; it creates no message, delivery, task or new durable widget-state record.

The HTML reader records confirmed CPU/error/content-limit failures in client
localStorage `tarobot-widget-quarantine-v1`: SHA-256 source hashes, timestamps
and reasons, at most 64 entries with seven-day expiry. It contains no HTML. A
matching source is not automatically retried by history/expansion/reload; the
reader's explicit Reload clears its record. Changed HTML has a new hash. This
is client-profile state, neither shared Host configuration nor a backup item.
When persistent storage fails, the current window keeps a bounded memory copy.

## Hub catch-up activity and incremental client cache (2026-10-22)

The Hub journal and canonical messages retain their existing authority.
`message_activity`, `message_hide_events` and `conversation_activity` are
rebuildable derived tables. The per-conversation `through_seq` watermark advances
in the same transaction as event insertion; triggers also cover compatible old
writers. Missing coverage is rebuilt in bounded transactions between live writes.
These tables are additive within schema 21; no event sequence is removed.

A negotiated `snapshot.delta.v1` merge preserves unchanged cached messages.
`ClientCache` stages frames under its existing owner lease, then commits changed
messages/tombstones, activity/read/attention projections and the new cursor in one
transaction. Partial transfers never advance the committed cursor. Invalid or
unusable cursors receive a full replacement. Per-conversation completion controls
outbox admission without changing its idempotent IDs or authenticated receipts.
See [catch-up repair](client/sync-catchup-repair-2026-10-22.md).

## Temporary side conversation state

Side questions use memory-only `CoreSideSessions` state with user/device/chat
ownership, bounded request receipts and renewable 90-second leases. The Hub keeps
only authenticated lease metadata. Native temporary handles never replace the
parent `session.json` binding; the client does not save side text or drafts to
IndexedDB. Shared usage and command-outcome audit remain durable without question
or response bodies. See [side conversation lifecycle](client/side-conversations-2026-10-22.md).

### Background subagent groups

`card.extra.backgroundTaskGroup` is additive, validated presentation metadata
bound to the card's read-only `scopedRun.id`. A per-controller group ID separates
parent turns; member messages and journals remain the sole source of truth.
The App reconstructs groups from cached/replayed messages, with no aggregate
execution state or new control handle. Old or unsupported records render
individually; forwarding strips group metadata and interrupted-run recovery
retains validated original grouping. See
[compact background task groups](client/background-task-groups-2026-10-24.md).

## Hub schema 23: dispatcher Bots and hidden ticket conversations

A dispatcher Bot is an ordinary managed Bot with `bots.role='dispatcher'`,
chosen only at creation (`managed-bot-spec.json` and the Bot's `config.json`
carry the same role; ordinary Bots omit the field so existing specifications
stay byte-identical). `dispatcher_settings` holds its owner-editable settings
(allowed engine CLIs, `ask`/`auto` dispatch mode, concurrency) with a
revision. `dispatch_workers` maps each dispatcher and engine to its hidden
worker Bot (`bots.role='worker'`), created on first use.
`dispatch_tickets` is the ticket ledger: status, pause flag, a bounded list of
attempts (Bot, engine, model, effort, worker conversation, input message,
outcome, failure category) and a result excerpt. `dispatch_requests` makes
dispatch and owner actions idempotent per actor/request ID. `engine_health`
is the Host-wide cooldown / sign-in state learned from worker failures; an
elapsed cooldown reads as available, and a later success clears the row.

Worker turns run in direct conversations with `conversations.hidden=1` and a
`ticket_json` marker (ticket ID, dispatcher, per-ticket model/effort). The Hub
lists them only to `dispatch.v1` clients, never enqueues push notifications
for them, and the App keeps them out of lists and unread counts. The bump to
23 makes an older Host refuse this state instead of listing and notifying
those conversations. The tables are otherwise additive; downgrade uses the
existing pre-upgrade backup path. See
[dispatcher Bots](client/dispatcher-bot-2026-11-01.md).
