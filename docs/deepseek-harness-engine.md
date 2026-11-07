# DeepSeek Harness Engine

For the current 0.2.1-rc.2 compatibility findings, shared-adapter corrections and
real verification boundaries, see the [2026-10-17 audit](client/deepseek-0.2.1-rc.2-2026-10-17.md).
The versioned historical matrices below are not a blanket compatibility claim.

This document is the release contract for TaroCub's `deepseek` engine. It
describes behavior verified against **DeepSeek Harness 0.1.5-rc.1**, not a
prompt-level approximation of another engine.

## Client-worktree verification, 2026-10-02

The local executable is now **0.2.0-rc.2**. The older release matrix below is
historical and does not establish every 0.2 capability. The App's real probe
confirmed session creation, remembered context after a managed restart, and
actual partial text before a worker SIGKILL. Full crash recovery passed after fixing the orphaned private Host discovered
by that probe: paired desktop/phone browsers receive one interruption notice,
and a new real answer succeeds in the same native session. This verifies that
lifecycle, not every tool/Goal/approval capability of the new CLI version.

0.2 moves assistant deltas into `session/follow` with `assistantStream: true`.
The bridge validates dense revision/index frames and compact reconnect baselines
separately from durable history. Prefixes never advance the journal cursor.
The adapter publishes only the missing suffix, ignores completed-step replay,
and reconciles any missing tail against the authoritative assistant message.
Foreground and Goal ownership still comes from the durable turn claim.
Pre-0.2 durable `assistant/chunk` remains supported.

The Node-based private Host receives a parent-lifetime preload through its own
child environment. It removes the activation marker before DSH starts, detects
bridge death/reparenting, sends itself SIGTERM and escalates after one second.
This releases native writer ownership even when the bridge dies without cleanup;
it does not scan for or terminate other instances' processes. Existing caller
NODE_OPTIONS are retained, and login/settings are not rewritten by the guard.
Tests: `deepseek-assistant-stream`, `deepseek-harness-protocol`,
`deepseek-harness-adapter`, `deepseek-parent-guard`, `deepseek-harness-host`.

## Version Policy

At the 2026-09-15 verification point, `0.1.5-rc.1` is both the locally installed
version and the npm `latest` release. TaroCub's authenticated
`/api/remote.mux` transport, session-v2 projections, and old/new command
attachment fields were verified through the real private Host and a streamed
model turn. The npm `next` tag points to `0.1.5-rc.2` and remains outside this
compatibility contract until the same probes pass; prerelease tags are never
promoted merely because they install successfully.

The rc.1 package line has an
[upstream compatibility report](https://github.com/deepseek-ai/deepseek-harness/discussions/5854)
about the removed `@deepseek-ai/dsh-llm` re-export of `assertNever`. TaroCub and its bundled search
plugin do not import that symbol. The installed Web bundle also includes the
`subagent-model-selection-settings` row required by the managed `web` profile.
The bridge Host smoke probe and standalone plugin verification both pass; a
custom third-party profile that imports the removed re-export remains an
upstream compatibility concern rather than a TaroCub fallback target.

## Native Web Search Plugin

The package in `deepseek-harness-plugin/` is the canonical source for a genuine
Harness bundle and self-contained Search MCP runtime. Install its standalone
repository into the profile used by ordinary Harness and TaroCub:

```bash
dsh plugin --profile web add github:cloveric/deepseek-harness-web-search-plugin
```

The bundle registers bounded web-search guidance and one `mcp-cctb-search`
client backed by its committed JavaScript bundle. Optional `/tarocub` guidance
describes companion integration without making TaroCub a prerequisite. It receives
provider keys only through the child environment and does not create a
Feishu/Lark app or claim that the separate TaroCub service is configured. The
legacy `github:cloveric/tarocub#path:deepseek-harness-plugin` source remains
compatible.

For TaroCub Lark turns, the DeepSeek adapter also injects an engine-only search
policy with the exact MCP tool names. It requires search before answering
time-varying external or high-stakes claims, uses extraction first for an exact
URL, keeps repository and local-machine checks local, and labels answers
unverified when required retrieval is unavailable. This policy is not added to
the shared Lark prompt or the user's global Harness `AGENTS.md`.

```bash
dsh --profile web --dump-config | grep -A18 -B2 mcp-cctb-search
dsh plugin --profile web update deepseek-harness-web-search-plugin
dsh plugin --profile web remove deepseek-harness-web-search-plugin
```

TaroCub also recognizes the former `tarocub-deepseek-harness-plugin` package
name during migration, but new installations and maintenance commands use the
web-search name.

## Runtime Architecture

Each TaroCub instance owns one private Harness host:

```text
TaroCub instance
  -> dsh web --no-open --host 127.0.0.1 --port 0
  -> launch-token exchange for a loopback-only browser session cookie
  -> official slash-separated HTTP RPC (/api/*)
  -> one multiplexed Remote WebSocket (/api/remote.mux)
  -> session follow/control streams plus forwarded Host events
  -> DeepSeek provider selected by the Harness profile
```

`DSH_EXECUTABLE` overrides the executable; otherwise TaroCub uses `dsh` from
`PATH`. `DSH_HOME` points at the user's authenticated Harness home (default
`~/.dsh`). TaroCub creates `<stateDir>/dsh-home` with mode `0700`, links the
shared credentials and profiles, copies mutable `settings.yaml` when the shared
home has one (current dsh no longer writes it), and installs
the bridge `AGENTS.md` plus permission presets. Before Search MCP registration,
it validates the installed plugin marker, declared entrypoint, and the bounded
package-local Harness patch that registers `mcp-cctb-search` through
`@deepseek-ai/dsh-mcp-client`. A valid plugin owns the client; otherwise the
Host appends its instance-local bridge fallback
and emits a diagnostic for a damaged claim. A bot can therefore reuse
authentication and native profiles without
letting model selection or bridge instructions overwrite desktop settings.

The host binds only to loopback and uses an ephemeral port. The authenticated
Remote event stream has a 15-second readiness deadline. TaroCub drains its stdio,
detects process/socket failure, reconnects with backoff, replays only
unseen ordered history, merges projections by `asOfSeq`, re-arms active Goals
after a process restart, and fails active work closed when recovery is
incomplete or malformed.

## Capability Matrix

| Capability | DeepSeek Harness behavior in TaroCub |
|---|---|
| Session create | Durable standard Harness session with a preallocated ID and verified workspace |
| Session resume | Native `session.list` scan and `/resume session <id>`; authoritative cwd is resolved and validated before binding |
| Streaming | Text deltas, reasoning, tool calls/results, usage, and terminal result events; reasoning is progress-only and never enters the final assistant reply |
| Files | Original paths for all attachments accompany the prompt so native tools can edit or return the actual source files |
| Images | Encoded as Harness image content, with the original path retained alongside the pixels; vision depends on the selected provider/model |
| Tool approvals | Deny/allow-once plus bridge-managed session grants for the exact tool name and input; missing/mismatched call evidence offers only once. At most 128 hashed grants per session; evicted inputs require fresh approval. Broken UI and abort paths fail closed |
| Questions | Structured `AskUserQuestion`, including multiple questions, multi-select, and free-text Other answers on Lark |
| Stop | Native `session.cancel`, local abort propagation, and immediate writer-slot release |
| Mid-turn steering | Native `session.steer` from Lark during the configured `/steer` window |
| Compaction | `/compact` is executed through Harness `commands/execute`, never exposed as an ordinary model prompt |
| Context | `/context` reads the durable `contextPressure` projection |
| Web research | Native Harness search remains available; TaroCub also injects source-traceable `mcp__cctb_search__web_search` and `mcp__cctb_search__web_extract` tools when their providers are configured |
| Media intake | Lark voice/audio is transcribed before dispatch, using Tingwu at 15 minutes or longer when configured and local Qwen otherwise; Lark video up to 10 seconds supplies sampled frames plus the original path, while longer video supplies the original path directly |
| Group sessions | Ordinary Lark groups share one chat session; topic/thread groups isolate sessions by thread while access control remains anchored to the parent group |
| Model / effort | Harness session model APIs validate provider/model and reasoning effort on each turn |
| Goals | Native durable Goal create/read/watch/clear/resume; persisted budget counts reported native goal-turn tokens, excluding ordinary/background/child work; private CAS pause preserves an ordinary turn |
| Background jobs | Structured lifecycle, ownership routing, final review grace, and exactly-once terminal result delivery |
| Crash recovery | Host restart, ordered history replay, projection reconciliation, recovery admission barrier, and Goal re-arm |
| Usage | Structured input/output/cache token totals |
| Dollar cost | Not reported by Harness; USD budgets cannot constrain DeepSeek turns |
| Claude `/ultrareview` | Not available; this is a Claude-specific workflow |

## Verified Limits

- An earlier live probe using `deepseek-v4-flash` returned
  `MODEL_DOES_NOT_SUPPORT_IMAGES`; vision capability is model-dependent. The
  later [ten-image/PDF App acceptance](client/deepseek-media-2026-10-04.md) records
  the installed Harness and configured default used for that run. It does not
  establish support for every provider or model.
- Harness reports tokens but not per-turn USD cost. `/usage` states this
  explicitly even when no dollar budget is configured.
- TaroCub does not emulate Claude's `/ultrareview`. Ordinary review prompts,
  Agent Bus `/verify`, and native DeepSeek Goals remain available.
- Native Harness profiles, plugins, and MCP configuration remain Harness-owned.
  TaroCub uses the installed Search plugin when valid and otherwise its private
  compatibility client. `TAROCUB_SEARCH_MCP_OWNER` guarantees one active owner;
  TaroCub never downloads or upgrades the plugin during bot startup.

## Safety Invariants

The adapter enforces these invariants with regression tests:

1. One foreground writer per Harness session; prompt rejection, abort, timeout,
   malformed recovery, and host error all release the claim.
2. A known session cannot later be attached to a different workspace.
3. Reconnect history must advance and reach the saved sequence within 100
   pages; otherwise the active operation fails instead of accepting a partial
   replay.
4. Projection snapshots require `asOfSeq`; a malformed snapshot cannot freeze
   all future live updates behind an artificial maximum watermark.
5. Malformed approval/question requests receive an explicit error response so
   Harness never waits forever for a bridge callback.
6. A final result is emitted once even if completed-job snapshots race with
   asynchronous Lark card delivery.
7. Goal and foreground turns retain separate ownership for approvals,
   questions, tool calls, background jobs, usage, and terminal events.
8. Turn, approval, question, and background-job routing is bound to a unique
   task claim. A cancelled turn's late terminal frame or job update cannot
   cancel, approve for, or settle a replacement turn in the same session.
9. Closing the protocol client while the Remote mux is connecting or waiting
   for its forwarded-event readiness frame rejects the pending connection
   instead of leaving startup blocked forever.
10. Frames from a superseded WebSocket generation are discarded before they
    can enter the adapter's event queues.
11. An abort received during session creation/configuration is checked again
    before a prompt is submitted, and an empty `[]` shared Cordis patch is
    normalized before TaroCub appends its permission layer.
12. Closing a Host while its protocol is still connecting rejects startup;
    shutdown can never publish or report a usable replacement afterward.
13. Finalized assistant messages project `reasoning` blocks only as thinking
    events and `text` blocks only as assistant output, including autonomous Goal
    turns and reconnect history replay.

The focused release gate is:

```bash
npm run build
npx vitest run \
  tests/deepseek-harness-protocol.test.ts \
  tests/deepseek-harness-host.test.ts \
  tests/deepseek-harness-adapter.test.ts \
  tests/deepseek-harness-plugin.test.ts
```

The full repository test suite and a real local Harness probe are still
required before release.

## Effort levels

DeepSeek Harness accepts `low`, `high`, and `max` (its `off` = thinking disabled
is expressed by clearing the effort with `/effort off`). `medium`, `xhigh`, and
`ultra` are rejected by both `/effort` handlers and dropped on config load —
DSH would otherwise reject `session.selectModel` with
`UNSUPPORTED_REASONING_EFFORT` before every prompt and no turn could run.
Model/effort alignment runs when the instance config or the transport changes
(fingerprinted per session), not on every turn.


### Goal usage isolation (2026-10-04)

The private App plugin registers `tarocubGoalUsage` on the native session projection
registry. Goal ID and the first work input in a native turn determine ownership;
a whole-session usage delta is never a goal counter. Provider settlement samples
include input, output and cache traffic with the native attempt/retry replacement
rules. Budget checks happen on settlement, so they can overshoot, and they are not
a hard billing limit across child/background work. `usageScope=nativeGoalTurns`
exposes that boundary in App/Lark status.

Budget pause checks the current goal revision and native turn origin in the same
synchronous native operation. It suppresses public goal.pause's blanket cancel
and cancels only a goal-owned turn. See [native evidence, state migration and
limits](client/deepseek-goal-budget-2026-10-04.md).

A failed pause, or accounting still unavailable after a fresh read, uses a
reported CAS `goal.clear` emergency stop. It disarms automatic continuation
without cancelling ordinary work; the current turn may finish naturally. Native
history remains, but resuming requires setting the goal again. A successful
accounting reread preserves an in-budget goal. Unbounded goals remain usable on
hosts without the projection and display usage as unavailable. Complete native
goals retain completion priority through failed/delayed pause receipts.

For an unbudgeted goal, a transient history read failure keeps its existing
watcher and native goal alive. Only failed reads back off (500 ms up to 5 seconds);
a successful read resets the normal cadence and reconciles the real goal state.
This does not resubmit a goal or repeat its work. Budget-protected reads and pause
policy failures keep their existing fail-closed handling. Tests:
`deepseek-harness-adapter`. See the [independent review](client/deepseek-opus-audit-2026-10-24.md).
