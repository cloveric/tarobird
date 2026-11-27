# oh-my-pi (`omp`) Engine Integration

TaroBird integrates [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) (MIT license) as a dedicated ordinary Bot engine (`omp`) using **Route A (`omp --mode rpc-ui` / `omp --mode rpc`)**, aligned with TaroBird's Codex and Claude Code capability level for every feature `omp` natively supports.

## Why `omp` Has Its Own Adapter

Although `oh-my-pi` originated as a fork of Pi (`badlogic/pi-mono`), its JSONL RPC protocol has diverged substantially (reference: `can1357/oh-my-pi` `docs/rpc.md`):

| Area | Pi (`pi --mode rpc`) | oh-my-pi (`omp --mode rpc` / `rpc-ui`) |
| --- | --- | --- |
| Startup & framing | Plain JSONL lines; no version handshake | Emits `ready` frame advertising `supportedProtocolVersions: [1, 2]`, `maxFrameBytes` (1 MiB), `maxReassembledFrameBytes` (64 MiB). Clients negotiate v2 (`negotiate_protocol`) for lossless `rpc_chunk` reassembly. |
| Turn completion | `agent_settled` event | Explicit per-prompt correlation: `prompt` response (`data.agentInvoked: false` for local slash commands) or `prompt_result` (`id`, `agentInvoked`, `status`, `error?`, `sessionSettled`), plus `session_settled` when async/background work drains. Eliminates cross-turn `agent_end` ambiguity. |
| Queues | 2 queues (`steering`, `followUp`) | 3 queues / channels: `steer`, `follow_up`, and ephemeral side questions (`aside` via `/btw` → `btw` / `btw_cancel` / `btw_delta` / `btw_record`). |
| Interruption | `abort` | `abort`, `abort_and_prompt`, `abort_and_restore_queue`, `abort_and_deliver_queue`, plus `set_interrupt_mode` (`immediate` \| `wait`). |
| Subagents (`task`) | Not native in Pi RPC | Native `set_subagent_subscription` (`off` \| `progress` \| `events`), emitting `subagent_lifecycle`, `subagent_progress`, `subagent_event`, plus `get_subagents`, `cancel_subagent`, `steer_subagent`. |
| Host-owned tools | Extension bridge required | Native `set_host_tools` + `host_tool_call` / `host_tool_cancel` / `host_tool_result` over stdio. |
| Autonomous Goal Mode | Not native in Pi RPC | Native `goal` RPC (`get` / `create` / `resume` / `pause` / `drop`) + `goal_updated` events. |
| History Fork & Rewind | Whole-session fork in helper | Native `get_entries`, `fork` (whole or at `entryId`), and `navigate_tree` (in-place rewind). |
| Slash command discovery | `get_commands` (`RpcSlashCommand[]`) | `get_available_commands` + `available_commands_update` (richer builtins/custom/MCP/file catalog). |
| Tool & extension UI | `extension_ui_request` (`select`, `confirm`, `input`, `editor`) | `--mode rpc-ui` enables `ask` (opt-in via `set_ask_dialog`) and `form` (HTML form for `ask` tool) alongside `select`, `confirm`, `input`, `editor`, `cancel`, `notify`, `setStatus`, `setWidget`, `open_url`. |

## Capability Alignment with Codex & Claude Code

Every capability `omp` natively exposes is wired to TaroBird's shared `CodexAdapter` contract; capabilities `omp` itself does not expose (such as account quota RPC) are explicitly reported as unsupported instead of fabricated:

| TaroBird Capability | Alignment Status | OMP Native Mapping |
| --- | --- | --- |
| Streaming text, thinking & tool cards | Aligned | `message_update` (`text_delta`, `thinking_delta`), `tool_execution_start` / `tool_stream_update` / `tool_execution_end` |
| Mid-turn steering & Bot-to-Bot steering | Aligned | `inFlightSendBehavior = "steer"`, `steerActiveTurn` → `steer`, `BOT_MESSAGE_STEER_ENGINES` |
| Next-turn queue & ephemeral side questions | Aligned | `follow_up` + `/side` (`openSideSession`) via native `/btw` (`btw` / `btw_delta` / `btw_record` / `btw_cancel`) |
| Host-owned App platform tools (`appPlatformTools`) | Aligned | `set_host_tools` + `host_tool_call` / `host_tool_cancel` / `host_tool_result` |
| History fork & rewind | Aligned | `history_anchor`, `getHistoryState`, non-destructive `forkHistory` (`fork` + restore source session), `rewindHistory` (`navigate_tree`) |
| Autonomous Goal Mode | Aligned | `getThreadGoal`, `setThreadGoal`, `updateThreadGoal`, `watchThreadGoal`, `clearThreadGoal` via `goal` RPC + `goal_updated` |
| Subagents & Task Panel | Aligned | `set_subagent_subscription("events")` → `scoped` (`subagent`) events, `listTasks` (`get_subagents`), `stopTask` (`cancel_subagent`) |
| Image & file attachments | Aligned | Base64 `prompt.images` for images (PNG/JPEG/GIF/WebP) + file references for other attachments |
| Usage & cost accounting | Aligned | `message_end.message.usage` → `AdapterUsage` (`inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`) + `withFailedTurnUsage` |
| Context usage & compaction | Aligned | `getContextUsage` (passive cached read + active `get_session_stats`) + `manual_compaction_*` / `auto_compaction_*` |
| Retry visibility & slash commands | Aligned | `auto_retry_start` / `auto_retry_end` → `engine_retry`; `get_available_commands` / `available_commands_update` → `advertisedCommands()` |
| Interactive dialogs (`rpc-ui`) | Aligned | `confirm`, `ask`, `select`, `input`, `editor`, `form`, `cancel` → TaroBird approval / `AskUserQuestion` cards |
| Tool approval bridge (`normal` mode) | Aligned | Fail-closed local socket extension (`omp-bridge-extension`); read-only auto-approval requires verified built-in `sourceInfo` (`origin: "builtin"`), never name-only matching |
| Account quota | Not natively exposed by `omp` | Reports `state: "unsupported"`, `reason: "not_adapted"` on Model Quotas page; `/api/engine-quotas` gates `omp` behind `includeOmp=1` for v1.6.0 client compatibility |

## Protocol Excerpts & Negotiation Contract

1. **Startup `ready` frame**:
   ```json
   {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}
   ```
   TaroBird validates `supportedProtocolVersions`:
   - If `2` is advertised, TaroBird immediately sends `{"id":"omp_1","type":"negotiate_protocol","protocolVersion":2}` and decodes `rpc_chunk` frames with strict `chunkId`/`index`/`count`/`byteLength` checks.
   - If neither `1` nor `2` is supported, TaroBird fails immediately with `OmpProtocolVersionError` — it **never silently downgrades**.

2. **Per-prompt completion & quiescence**:
   ```json
   {"id":"omp_5","type":"prompt","message":"Summarize this repo"}
   {"id":"omp_5","type":"response","command":"prompt","success":true}
   {"type":"agent_start"}
   {"type":"message_update","messageId":"msg-2","assistantMessageEvent":{"type":"text_delta","delta":"..."},"message":{"role":"assistant","content":[]}}
   {"type":"agent_end","messages":[],"isTerminal":true,"yielded":true}
   {"type":"prompt_result","id":"omp_5","agentInvoked":true,"status":"completed","sessionSettled":true}
   {"type":"session_settled"}
   ```
   Non-terminal `agent_end` frames (`yielded: false`, e.g. retries or compaction continuations) never end the turn.

## Executable Discovery

`resolveOmpExecutable` probes in order:
1. `OMP_EXECUTABLE` (or Host Engine Settings path override)
2. `omp` on `PATH`
3. Bun global installs (`$BUN_INSTALL/bin/omp`, `~/.bun/bin/omp`)
4. `omp.sh` install locations (`~/.local/bin/omp`, `~/.omp/bin/omp`)
5. Homebrew (`/opt/homebrew/bin/omp`, `/usr/local/bin/omp`)
