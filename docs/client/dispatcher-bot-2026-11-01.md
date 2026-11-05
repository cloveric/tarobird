# Dispatcher Bots (2026-11-01, issue #110)

The App calls this Bot type **幕僚长** (English: **Chancellor**); code, APIs and
the CLI keep the technical name *dispatcher* (`role: "dispatcher"`, `tickets`).

A dispatcher Bot is a Bot type chosen only when the Bot is created. The owner
talks to it in a single conversation; it splits requests into tickets and runs
each ticket directly on an engine CLI installed on the Host (Codex, Claude,
Kimi, DeepSeek, Antigravity), in its own hidden worker conversation. The owner
does not configure other Bots for this. The
design discussion and decisions are recorded in issue #110 and
[the design notes](../design/dispatcher-bot-20261101/README.md).

## Identity

- `createBotSchema` accepts optional `role: "dispatcher"` and `dispatcher`
  settings (`allowedEngines`, `mode: ask|auto`, `maxConcurrent` 1–8). Ordinary
  Bots omit both, so existing managed specifications stay byte-identical and
  idempotent retries keep working.
- `BotManager.create` stores `bots.role`, the initial `dispatcher_settings` row
  and `config.json` `role`. Ordinary Bots cannot be converted later, and a
  dispatcher cannot be converted back; it can be deleted.
- `HubStore.createConversationInTransaction` allows one direct conversation per
  dispatcher (`dispatcher_single_conversation`) and no group membership
  (`dispatcher_group_forbidden`, also in `updateGroup`).
- The Gateway adds the host-owned dispatcher contract
  (`gateway/agent-instructions.ts::dispatcherInstructions`) to every turn of a
  dispatcher Bot. Ticket writes explicitly pass the current turn's
  `--context-message` named in the dispatcher contract (also present in the
  Cross-Bot CLI context line); they do not assume
  persistent engine processes receive new per-turn environment variables.
  Per-Bot persona files are not modified.
  The [2026-11-02 selection follow-up](dispatcher-model-selection-2026-11-02.md)
  keeps model/effort selection in the short independently delivered context.
  Simple execution still uses tickets; conversation/status need not. Omitting
  model/effort uses CLI defaults and does not invoke a Host-side task classifier.

## Engine workers

The Host reaches a CLI through a hidden worker Bot per (dispatcher, engine):
`BotManager.dispatchWorker` creates it on first use (`role: "worker"`, the
CLI's default model/effort, the dispatcher's workspace, and an inherited
permission choice) and records ownership in `dispatch_workers` atomically with
registration. Same-engine permission choices are preserved; cross-engine choices
without an exact equivalent conservatively use normal approval. Each ticket works in its own
directory, `<dispatcher workspace>/tickets/<ticket ID>` (`ticketWorkspace`),
carried by the conversation marker and applied as the turn's
`workspaceOverride`; every attempt of a ticket, on any CLI, uses the same
directory so another CLI can continue from its files. Public creation of
`role: "worker"` is refused (`bot_role_forbidden`); a worker cannot join an
ordinary conversation or group (`dispatch_worker_internal`). Workers are sent
only to `dispatch.v1` clients, which keep them out of every Bot list and use
them only to name messages in ticket chats. Operations, update-status and file
diagnostics can still expose workers for recovery; they are not claimed to be
invisible to every management interface. Deleting a dispatcher deletes its
workers and keeps their history.

## Ticket ledger and dispatch (`src/hub/dispatch.ts`)

- `dispatch_tickets` (schema 23) holds title, request, status (`queued`,
  `working`, `needs_answer`, `needs_review`, `blocked`, `done`, `cancelled`),
  pause flag, up to 32 attempts and a result excerpt.
- `targets` lists every engine CLI from the Host catalog: installed, allowed,
  models with supported efforts, defaults and availability.
- `dispatch` takes an engine. It validates the actor (owner, or the dispatcher
  inside an active turn via its context message), the allowed engine, the
  ticket state, engine availability, the concurrency limit and the per-ticket
  model/effort, prepares the engine worker outside the ledger transaction,
  then creates a hidden direct conversation with it (`conversations.hidden=1`,
  `ticket_json` marker) and queues the request there as a Bot-sourced input in
  one transaction. Re-dispatching on the same CLI with the same settings
  continues that worker conversation; another CLI or setting starts a new one.
- A 2 s sweep rotates through indexed batches of at most 64 working attempts
  (old long-running work cannot starve later results). It checks delivery state,
  live replies and foreground `nativeRun` outcomes: a `complete` message envelope
  can contain an error or an interrupted run. Active scoped subtasks still hold
  the slot, but their terminal errors do not override a completed parent run.
  In the same transaction it updates the ticket and
  posts a notice into the dispatcher's conversation (Bot-sourced, mentioning
  the dispatcher). That delivery wakes the dispatcher through its ordinary
  queue and session. A crash can therefore never settle a ticket without its
  notice.
- Outcomes: completed → `needs_review`; engine unavailable (`engine-quota`,
  `auth`, `engine-rate-limit`, `engine-backend`, `engine-cli`) → `queued` with
  a 【需要改派】 notice; other failures → `blocked`; cancelled → `queued`.
  Foreground `partial`, `stopped` or `interrupted` → `blocked` with a notice to
  inspect preserved work and ask the owner before re-dispatching; partial side
  effects must not be automatically replayed.
  `core/errors.ts::renderedEngineFailure` recovers the category and reset hint
  from the user-facing error the worker published; keep it in sync with
  `renderCoreUserFacingError`.
- `engine_health` records `cooldown` (until the parsed reset time, otherwise a
  per-category default) or `login_required`. Dispatch refuses an unavailable
  engine unless forced; a success whose attempt started strictly after the
  recorded failure, or an explicit `engine-reset`, clears it. Older concurrent
  successes and ambiguous same-millisecond starts retain the restriction. The
  dispatcher cannot sign in for the owner.
- Owner actions (`pause`, `resume`, `cancel`, `accept`) and dispatch requests
  are idempotent per request ID. Pause and cancel atomically cancel inputs that have not been handed to a
  worker. For dispatched inputs, `attempt.stopRequested` persists the intent;
  the ticket stays working and holds its concurrency slot until the delivery
  is terminal and no live reply remains. Controls target the exact input
  message, retry after disconnect and never stop a later attempt. A reconnect never replays an input carrying a stop intent. RPC delivery is
  asynchronous; the API returns its durable intent without waiting for an offline
  worker. A manual pause/cancel preserves any result already published and does not wake the dispatcher; only resume posts a 【工单恢复】
  notice. The UI distinguishes stopping from fully paused/cancelled.

### Reconciliation and retained history

- `tickets update` has no request-ID receipt. After an unknown result, use
  `tickets show ID` to inspect status/note before retrying. A `ticket_closed`
  response after a lost cancel response does not imply the cancel failed.
- The dispatcher can set `done` after the owner accepts in conversation;
  acceptance and `mode=ask` are agent instructions, not a second server-side
  approval mechanism. This is separate from the owner-only `action: accept`
  route. Worker Bots cannot write the dispatcher's ledger.
- `paused=true` while `stopRequested=cancel` is an admission fence until terminal
  stop evidence arrives. Clients must display the stop intent (正在取消), not
  infer a completed pause from that flag alone.
- Archiving an execution conversation prevents reuse of that conversation.
  Re-dispatch must not silently undo the owner's archive or fork around it.
  The owner can restore the exact conversation from archived conversations, or
  with `tarobot conversations restore --ids CONVERSATION_ID --yes`, then retry.
- A dispatch that loses the final concurrency race may leave a reusable hidden
  engine worker and ticket directory. Worker startup stays outside the ledger
  transaction; the final check still prevents duplicate input and slot admission.
- `tickets show` retains a bounded result excerpt (up to 4,000 characters), not
  the complete transcript. Use the ticket's 「打开」 action for execution history.
  Deleting a dispatcher retires its ticket controls (show/list return
  `bot_not_found`); retained worker files and transcripts are not deleted by this
  action. Export needed ledger details before deleting the dispatcher.

## Per-ticket model and effort

The worker conversation's `ticket` marker carries the model/effort. The Gateway
maps it to `engineOverride` on the Core turn (`gateway/channel.ts`), and Core,
Bridge and every adapter use it for that session only:

| Engine | Application |
|---|---|
| Codex app-server | `model`/`effort` on `turn/start` (verified in codex-cli 0.165.0 `TurnStartParams`); the shared app-server is not restarted |
| Codex process | per-run `-m` / `-c model_reasoning_effort` |
| Claude | part of the session worker's options key (`--model`/`--effort`) |
| Kimi | per-session settings key and session config options |
| DeepSeek | per-session model selection and its change fingerprint |
| Antigravity | per-session `--model`/`--effort` and settings key |

An unsupported effort fails the turn as `engine-settings` before the engine
starts; the Hub also rejects known incompatible combinations at dispatch
(`dispatch_effort_incompatible`). The Bot's `config.json` is never changed.
Known gap: turns started from card buttons inside a worker conversation
(choices, archived continuations), DeepSeek `/goal` and side conversations do
not carry the model/effort or ticket workspace override. Those paths can use
the worker's dispatcher-root workspace instead of the ticket directory. This
review does not claim end-to-end acceptance of those continuation paths.

The dispatcher's list avatar also summarizes its open tickets with the
ordinary avatar states (`client/src/dispatcher-signal.ts`): waiting for an
answer → ask, running → working, blocked → failed, awaiting review → done; the
higher-priority of its own state and its tickets wins. One shared 8 s poll of
`GET /api/bots/:id/tickets?open=1` per Host and dispatcher feeds every row.

Notices in the dispatcher's conversation (Bot-sourced, request ID = ticket ID)
render as one folded gray line (`DispatchNotice`); the full text opens on
demand. They are authored by the owner, so they never notify or count as
unread.

Ticket lists remain bounded to 200 rows, with open tickets ahead of completed
history so newer finished tickets do not hide older pending work. This is not
a history-search or retention feature.

## Hidden conversations

The Hub lists hidden conversations only to `dispatch.v1` clients (ready
snapshot, `conversation.updated`, `GET /api/conversations?hidden=1`) and never
enqueues push notifications for them. The App keeps them out of lists, unread
counts, desktop notifications and avatar state unless the device setting
「在列表里显示工单对话」 is on; they remain directly openable from the ticket list.

## Entry points

| Surface | Entry |
|---|---|
| Desktop / phone | New Bot dialog checkbox and 调度设置 (allowed CLIs, mode, concurrency); Bot settings; ticket list in the dispatcher conversation; star badge on the dispatcher's avatar |
| Owner HTTP | `GET/PUT /api/bots/:id/dispatcher`, `GET/POST /api/bots/:id/tickets`, `POST /api/bots/:id/tickets/{dispatch,update}`, `GET /api/bots/:id/dispatch-targets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/action`, `POST /api/dispatch/engines/:engine/reset` |
| Dispatcher Bot | `POST /api/instance/tickets` (Bot credential + active turn) through `tarobot tickets …` |
| CLI | `bots create --role dispatcher [--dispatch-mode] [--max-concurrent] [--allow ENGINE,…]`; `tickets list/show/targets/engines/create/dispatch --engine/update`; owner `tickets pause/resume/cancel/accept/remove/engine-reset/settings` |


## Post-merge controls and recovery

- Explicit CLI allowlists survive installation/catalog changes and remain explicit
  even when all currently installed CLIs are selected. Only an omitted allowlist
  includes later installations; the explicit “也允许以后安装的 CLI” choice or
  the owner CLI can restore it with
  `tarobot tickets settings --bot BOT_ID --allow all`.
- Session/device and Bot credential guards run inside the ledger transaction,
  before new writes or cached receipts. Worker preparation gets the same guard.
- Worker registration and its dispatcher ownership link commit atomically;
  deleting a dispatcher reads its workers after revoking the parent. Deleting
  an internal worker retains history and allows a new deterministic generation.
  Deleted dispatchers' attempts stop and settle without notices to a deleted Bot.
- Workers inherit the dispatcher's permission choice. Engine-specific auto
  choices are not assumed equivalent across CLIs: cross-engine mappings fall
  back to manual unless the owner selected bypass or manual explicitly. A changed
  permission replaces an idle worker with a fresh session; pending input,
  card-action or active-run evidence refuses replacement with
  `dispatch_worker_permissions_busy`. Finish or stop that worker before retrying.
- `mode: ask` is a planner instruction to obtain owner confirmation in chat;
  it is **not** a Hub-enforced per-ticket approval token. Engine/tool approval
  is a separate permission layer. Do not describe ask mode as a security boundary.
- A worker's live question or approval is recorded in `attempt.waitingFor` and
  emits a deduplicated planner notice. App labels and the dispatcher avatar show
  attention; the ledger keeps `working` so the attempt retains its concurrency
  slot. Open the worker conversation to answer/approve. Recovery clears the
  marker. A failed delivery alone cannot settle a still-active reply.
- Stop requests remain pending while execution is uncertain. There is no new
  force-abandon action in this patch; deleting a managed worker is the existing
  owner recovery path and retains durable history. No RPC acknowledgment is
  presented as proof that external CLI work stopped.
- The 2026-11-01 review, test boundaries and remaining limitations are recorded
  in [the post-merge audit](dispatcher-post-merge-audit-2026-11-01.md).

## Verification

Hub/CLI/Gateway: `hub-dispatch`, `host-cli-tickets`, `gateway-dispatch`
(real Hub and Gateways with scripted engines: dispatcher contract, worker
override, result notice waking the dispatcher), `engine-override` and the
adapter suites (`app-server-adapter`, `process-adapter`, `claude-stream-adapter`,
`kimi-acp-adapter`, `deepseek-harness-adapter`, `antigravity-adapter`),
`hub-bot-manager`, plus the schema-version suites updated to 23.
Browser: `dispatcher-bot`. Real engine runs, physical phones and an installed
App are separate acceptance steps and are not covered by these tests.

## Follow-ups (agreed with the owner, not in this change)

- Per-ticket time limits, configurable in 调度设置.
- An owner-editable model rule table and fallback order in 调度设置.
- An engine status table in 调度设置 (available / cooling down until / needs
  sign-in / not installed) with a clear action.
- Owner interjections in a worker conversation report back to the dispatcher.
- Attachments sent to the dispatcher travel with a ticket to the CLI.
- Pre-dispatch sign-in checks where a CLI exposes its login state without
  running a task (to be verified per CLI).
- Ticket history search and retention cleanup; folder/email/GitHub sources; an
  aggregated 「需要我处理」 view; automatic retry after a quota reset.
