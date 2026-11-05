# Context maintenance feedback across engines

The App now shows **正在压缩上下文** when the active engine reports compaction.
The run detail uses a readable explanation instead of exposing the internal
`context_compaction` identifier. Desktop and mobile use the same presentation;
conversation previews and fallback cards use the same activity. Completion is
recorded separately from completion of the user's request, with observed elapsed
time or the engine's reported duration. Maintenance does not add a tool action.

## Native event contracts

| Engine checked | Start | Terminal receipt | Ownership and limits |
| --- | --- | --- | --- |
| Codex CLI 0.163.0 | Preventive `thread/compact/start`; in-turn `item/started` with `contextCompaction` | Existing preventive completion/failure; matching `item/completed` | Native thread and turn ownership; preventive callbacks remain separate so they are not double counted. |
| Claude Code 2.1.301 | `system/status` with `status: compacting` | `system/compact_boundary` | Active foreground prompt only; child/review streams cannot change its state. `status: null` is not a successful completion receipt. |
| DeepSeek Harness 0.2.0-rc.2 | `compaction/start` | `compaction/end`, including its error field | Exact session and established native turn claim; arbitrary/old turn numbers cannot adopt the current request. |
| Kimi Code 2.2.0 | `PreCompact` hook | Paired `PostCompact` hook | Existing authenticated local relay, plugin version 3. Active foreground native session/turn only; unpaired completion and task-origin hooks are ignored. |
| AGY 1.4.0 | `checkpoint` step in `ACTIVE`, if provided | `DONE` / `ERROR`, native `duration_seconds` | Persistent and one-shot paths. Checkpoints are labeled **整理上下文摘要**: summarization alone does not prove that history was pruned. |

These are the production adapters selected by the shared engine factory; legacy
one-shot Codex/Claude adapters do not gain invented progress. Engines without
these optional signals retain their ordinary running status. Kimi installations
without the supported hook relay cannot report live compaction through ACP alone.
DeepSeek's explicit `/compact` command uses `commands/execute` and can emit
`turn: null`; its current RPC returns the command ID only at completion. This
change does not guess ownership for those events, so that manual command still
returns its existing result without live compaction progress. Automatic
compaction within an owned model turn is supported. Background child/review
compactions without an owned foreground callback are not projected onto a newer
user request.

Local evidence was checked against generated Codex app-server types, installed
Claude/Kimi implementations and DeepSeek session event types. Public contracts:
[Kimi hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks) and
[AGY headless step events](https://gweb-jetski.appspot.com/docs/cli/headless/).
An isolated actual AGY `/compact` run emitted only a `checkpoint: DONE`, with
`duration_seconds: 8.725516`. The UI records that completion and duration; it
does not invent an earlier live start. The test conversation was independent
of the user's App conversation.

## Honest state and privacy

- Ordinary assistant text, a tool whose name mentions compression, user prompts,
  idle time, and command submission are not compaction signals.
- Duplicate terminal receipts and delayed starts cannot reopen settled entries.
- If real output resumes before a completion receipt, the prior maintenance
  entry becomes unconfirmed and its spinner stops. A later explicit receipt may
  resolve it without changing an already active answer back to thinking.
- Completion-only events without native duration do not display a fabricated
  zero-second duration. Failure, cancellation and disconnection retain their
  existing distinct run statuses; missing receipts are not reported as success.
- Neither compressed summaries, raw prompts nor token-count internals are sent
  as assistant messages. Only the operation identity, state, kind and duration
  enter the existing bounded run journal.
- Quiet-time feedback reflects actual event times; no synthetic heartbeat is
  emitted. There is no automatic retry, new task or queue interruption.

## Preventive timeout correction (2026-10-27)

Read-only App and native-engine records confirmed that one preventive Codex
compaction took about 204 seconds. The Host declared failure at its old
180-second deadline and moved the next request to a new thread, even though the
original native compaction completed about 24 seconds later.

The shared Codex adapter now waits up to 300 seconds. If that deadline expires,
the maintenance entry is unconfirmed rather than failed, and the request returns
a timeout while preserving the original thread. The native operation remains
tracked: retries cannot start another compaction or silently replace the thread,
and idle/drain admission waits for a terminal receipt or engine exit. If no
receipt arrives within 15 minutes from the start, the original thread remains
fenced and its app-server is recycled once all other turns, completing turns,
goals, blocking requests and live compactions have finished. The ceiling alone
does not interrupt that other work. Relative timers keep both deadlines stable
through wall-clock corrections. A late
native completion clears the pending operation so a subsequent request can use
the original context. This does not automatically replay the timed-out message
or promise an automatic update to its already-ended progress card. Explicit
native failures and unsupported-RPC fallback retain their existing behavior.
Old RPC deadlines are bound to their own operation and cannot settle a newer
compaction on the same thread.

Retries distinguish an unconfirmed result, an earlier operation still awaiting
its receipt, and recovery waiting for other work to finish. Starting or setting
a goal on the fenced thread is refused before any goal clear/set or watcher
registration; read/stop operations remain available. Stop ends only the current
wait, including when it arrives while the initial status is being published.
It does not pretend the underlying compaction stopped. An idle ephemeral side
conversation may expire when its shared app-server is recycled, as with other
existing app-server restarts.

The incident timing, acknowledged and unacknowledged RPC deadlines, late native
completion, engine shutdown, retry fencing, and journal status have focused
regression coverage. These are deterministic protocol replays; the running Host
and installed Apps were not replaced or restarted for verification. Desktop,
mobile and standalone CLI use the same adapter and existing journal `unknown`
status; no CLI command or schema migration is needed. Publication remains paused.

## CLI and compatibility

The same adapters and run recorder serve desktop, mobile and headless hosts.
This is automatic progress reporting, so no new CLI command is required. Existing
run journal v1 already supports these text entries and optional duration fields;
there is no schema migration or separate reduced CLI implementation. A future
release must publish matching App/host/standalone CLI artifacts from the same
source. Updating source alone does not update the installed applications.

## Verification

Verification artifacts: `/Volumes/gdrive/taro-tmp/tarobot-compaction-20261017`.
Adapter tests replay the native payload shapes, including duplicate receipts,
foreign/idle events, private summaries, continuation, and AGY completion-only
behavior. Kimi hooks travel through the authenticated HTTP relay in tests.
Shared recorder tests cover missing receipts and late completion, with Gateway
writer/recovery and scoped-run regressions. Browser tests use a real local Hub
with normalized fixture events for all five engines on desktop and phone widths;
these are not five live model sessions or an Android hardware acceptance test.

Results on 2026-10-17:

- Default standalone regression suite: **316 files passed; 4,185 tests passed,
  one existing test skipped** (`regression-final.log`). An initial run hit the
  macOS Unix-socket path limit in `host-cli-update`; the isolated case and full
  suite pass with `TMPDIR=/Volumes/gdrive/taro-tmp/cp17`. No product code was
  changed to bypass that test.
- All **10 desktop/phone browser scenarios passed** (`browser-final.log`).
  Compaction/checkpoint status, readable details, continuation, reconnect,
  persistence and the existing run workflow are covered. Desktop and phone
  screenshots, including AGY's distinct summary wording, were inspected.
- `npm run build` for the standalone host and `npm run build` in `client`
  both passed. The host remains a 356-module graph without legacy transports.
- Focused adapter/relay, shared run and Gateway regressions passed before the
  builds; the new neutral session fixtures also pass their targeted replay.

This is a source implementation and GitHub checkpoint, not a new App release.
The installed Mac App, running host and Android APK are unchanged. The Android
hardware path and live compaction in every engine have not been claimed as
verified; the actual AGY probe and protocol/browser fixtures are distinct evidence.
