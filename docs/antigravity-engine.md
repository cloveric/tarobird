# Antigravity Engine

TaroCub drives the official `agy` CLI as a native local engine. The current repository contract records **Antigravity CLI 1.2.16**
(see `entrypoint-map.md`); the older live probes below describe 1.2.2 only. Install and authenticate
`agy` locally before selecting `/engine antigravity`.

Official references:

- [Antigravity headless CLI](https://antigravity.google/docs/cli/headless/)
- [Antigravity slash commands](https://antigravity.google/docs/slash-commands/)
- [Antigravity CLI changelog](https://antigravity.google/changelog?app=cli)

The 1.2.2 baseline was live-verified on 2026-09-15 with consecutive turns on one
persistent worker. The prior fresh-process `--conversation` resume and real
`cctb_search` MCP probes remain applicable because the 1.2.2 change does not
alter the headless stream contract. TaroCub treats these protocol probes, not
merely the installed version string, as the compatibility evidence.

Upstream 1.2.2 only improves the startup warning and migration guidance for
deprecated `unsandboxed` permission rules. It does not change the headless
`stream-json` contract used by TaroCub.

## Runtime Contract

Ordinary turns share one persistent headless worker per live conversation, with
both input and output in NDJSON `stream-json` format. TaroCub writes one `user`
event per turn and keeps stdin open. It accepts one process-level `init`, the
matching `user` echo emitted by `agy`, and structured `step_update` and `result`
records for each turn. An unstructured stdout line, a mismatched user echo, an
error result, or a process exit before the active turn's final result fails
closed instead of being posted as assistant text.

The worker remains warm for later turns and is reaped after two idle hours.
Changing a startup setting such as workspace, approval mode, model, effort, or
native timeout recycles an idle worker and starts a replacement with
`--conversation <uuid>`. A crash removes the worker; the next turn resumes the
same authoritative conversation ID in a fresh process.

Antigravity 1.2.2 retains retries for transient model API failures, including mid-stream
interruptions, in-process with exponential backoff while preserving completed
tool outputs. This does not change the stream contract: TaroCub still waits for
the authoritative successful `result`, deduplicates repeated tool snapshots by
step index, and fails closed if the CLI ultimately cannot complete the turn.

TaroCub maps the stream as follows:

| Antigravity event | TaroCub event |
|---|---|
| `init.conversation_id` | session binding |
| agent-response `text_delta` | answer stream |
| active tool step | `tool_use` |
| terminal tool step | correlated `tool_result` |
| successful `result` | authoritative final answer |
| per-step usage | current-turn token accounting |

The result-level usage of a resumed conversation is cumulative. TaroCub does
not record that value directly; it sums the latest usage for each step in the
current turn so resumed turns are not billed twice.

`/goal` is the one deliberate protocol exception. Antigravity does not accept
CLI slash commands through NDJSON stream input, so TaroBot first recycles the idle
persistent worker, then uses one-shot print mode with `--input-format text` and
the complete `/goal` prompt on stdin while still parsing structured output. The
prompt is absent from process arguments. Private bridge
guidance and attachments follow the goal text and are not allowed to hide the
slash command inside an XML wrapper. The next ordinary turn starts a new stream
worker attached to the same conversation.

Native acceptance on AGY 1.4.1 compared direct `-p` with text stdin: both logged
native system `/goal` expansion and completed a single, tool-free goal with the
native completion marker. The updated TaroBot adapter also completed this path.
The checks used a separate workspace and denied writes to the user's home,
preserving existing settings and conversations; they do not cover persistent
resume or other installed AGY versions.

## Model, Effort, and Sessions

- `/model <id>` persists a single-token model ID and passes it as `--model` when
  the next worker starts. Changing it recycles an idle worker while preserving
  the conversation. Use `agy models` to discover the current IDs. `/model off`
  restores the CLI default.
- `/effort` supports `low`, `medium`, `high`, `xhigh`, and `max`; `off` clears the override. The native
  startup flag. Incompatible persisted values are removed before startup.
- A new turn binds the `conversation_id` from the structured stream. A resumed
  turn passes `--conversation <uuid>`. `/resume` can still scan recent CLI logs
  because `agy` does not expose a structured conversation-list command.
- The normal runtime policy is a six-hour hard cap plus a 30-minute inactivity
  watchdog. `/timeout off` removes both bridge watchdogs but explicitly passes
  a seven-day native ceiling; omitting the native flag would silently restore
  `agy`'s five-minute default.

## Capability Matrix

This matrix describes the print runtime (`stream-json`). The ACP runtime is
described in the next section.

| Capability | Status | Boundary |
|---|---|---|
| Structured answer streaming | Supported | Native `stream-json` |
| Structured tool lifecycle | Supported | Tool input/output is correlated by step index |
| Conversation resume | Supported | Explicit UUID binding; log scan for discovery |
| Model and effort selection | Supported | Applied at process startup |
| Token usage | Supported | Per-turn step usage; no USD cost |
| Native `/goal` | Supported | Direct `-p` prompt mode, structured output |
| Files, media ASR, delivery tags | Supported | Shared TaroCub channel/delivery layers |
| Native MCP/plugins | Supported | Managed by Antigravity's own configuration |
| Per-tool remote approval | Not exposed | Headless stream input has no interactive control-response protocol |
| Structured questions | Not exposed | Turn-level approval is the safe bridge fallback |
| Mid-turn steering | Not exposed | Follow-ups queue as another turn |
| Post-result background lifecycle | Not exposed | A result ends the turn; the worker stays warm but emits no background-task lifecycle |
| Manual `/compact` or context telemetry | Not exposed | No official headless API currently available |

For approval mode `normal`, TaroCub asks once before the turn and then grants
the whole headless process inside Antigravity's sandbox. `full-auto` combines
the skip-permissions flag with `--sandbox`; only explicit `bypass` omits the
sandbox. This is not equivalent to the per-tool approval flows available from
Claude Code, Kimi ACP, or DeepSeek Harness.

## ACP Runtime (`agy acp`)

A Bot's `config.json` key `antigravityRuntime` selects the runtime: `"acp"` runs
the Bot through the official ACP server `agy acp`; absent (or `"print"`) keeps
the print runtime above. A new ordinary Antigravity Bot is created with `"acp"`
when the installed `agy --version` is 1.5.10 or newer (the adapter relies on two
1.5.10 fixes: output pushed after a turn reaches the client, and session/close
ends the session's background work). A dispatcher and the workers it starts stay
on print, and a saved Bot keeps the runtime it has. Neither the App nor the CLI
has a setting for it: to switch an existing Bot, edit that key in the Bot's
`config.json` and restart the Bot.

- One `agy acp` process serves one conversation. A new conversation uses
  `session/new`; a saved one uses `session/resume` (never `session/load`, which
  would replay history). Before any process is ended, its session is closed with
  `session/close` (bounded), then stdin is ended and the process tree is killed.
  If a CLI does not advertise `session/close`, only the last two steps run, and
  background commands that the session started may keep running.
- Model and effort are applied per session with `session/set_config_option`; a
  plan or other non-default native mode is reset to `default`. A session config
  that fails on a new conversation, or a config write that gets no answer in
  time, ends the process; the next message starts a new one (a saved
  conversation is resumed).
- Approval: `normal` starts `agy acp` without permission flags and bridges each
  `session/request_permission` to the chat (allow once or reject once). There is
  no terminal sandbox in this mode, unlike the print runtime's whole-turn
  approval. `full-auto` passes `--dangerously-skip-permissions --sandbox`;
  `bypass` passes `--dangerously-skip-permissions`.
- A message sent during a reply joins it as another `session/prompt` (steering).
  agy refuses one while an approval is unanswered; that refusal is reported, not
  queued.
- Context usage comes from `usage_update`; native `/compact` and the native
  commands agy advertises are available.
- Background commands still running after the model moved on are listed as
  tasks that cannot be stopped one by one (ACP has only session cancel and
  close). Output agy pushes to an idle session is delivered as a follow-up
  message. An idle process is closed after two hours unless one of its
  background commands still runs.
- The account quota is read with the same one-shot `agy -p /usage` as print.
- **Swarm mode (`/swarm`, Preview & Quota Heavy)**: Supported on the ACP runtime
  when `agy` is 1.5.5+ (ACP requires 1.5.10+) and `agy acp` advertises `/swarm`.
  Rejected locally without forwarding to the model on the print runtime, older
  `agy` versions, or sessions without `/swarm`. While swarm workers are
  genuinely executing (`working` primary workers, tracked via
  `brain/<sessionId>/.system_generated/swarm/{members.json,board.jsonl}` merged
  with ACP updates), inactivity timeout and idle-worker reaping are paused up to
  the hard total ceiling (6 hours by default, aligned with `turnTimeoutMs` and
  enforced unconditionally by both the turn total timer and the swarm ceiling
  timer). Permanently `paused` (quota-exhausted) or all-`waiting` idle swarms do
  not bypass inactivity timeout or idle-worker reaping. `listTasks` exposes
  workers, models, states, helper roles (`monitor`/`narrator`), and the
  read-only Swarm Board to callers that opt in via `?swarmTasks=1` (Hub/Gateway
  negotiation `conversations.tasks.swarm.v1`), while stripping post-1.6.0 Swarm
  fields for strict 1.6.0 clients and Hubs; active-turn worker approvals and
  `AskUserQuestion` (`elicitation/create`) remain interactive and attributed to
  the requesting worker, while orphan requests with no live owning turn are
  declined/rejected cleanly instead of borrowing a previous turn's handler;
  `@worker <message>` is forwarded unwrapped; and Stop cancels the swarm by
  closing the ACP session so all workers exit. Swarm lifecycle behavior in
  TaroBird is verified against fake ACP harnesses and temporary
  `brain/<sessionId>/.system_generated/swarm/` fixtures rather than live
  quota-heavy swarm runs.

## 中文摘要

TaroCub 已按 Antigravity 1.2.2 的原生结构化协议接入：每个活跃 conversation
维持一个 `stream-json` worker，后续轮次复用同一进程；回答、工具、终态和
token 分开处理，恢复会话只统计本轮 step，避免累计 token 重复记账。空闲
两小时、进程崩溃或启动参数变化时会安全回收，并用权威 conversation ID
重建。`/goal` 因上游限制仍使用一次性直接 `-p`，执行前会回收持久 worker，
下一轮再恢复同一会话。`full-auto` 会同时启用 `--sandbox`；只有显式
`bypass` 才跳过沙箱。

1.2.2 保留了进程内重试 502、503、504、分钟级 429 和中途断流的能力，并保留已经
完成的工具结果；TaroCub 无需改变协议，仍以最终成功 `result` 为准，并按
step index 去重重复工具快照。

对会输出 `user` echo 的 CLI 版本，TaroCub 以“与当前 prompt 完全匹配的 echo”
作为持久 worker 的轮次边界：新一轮 echo 之前迟到的 `step_update` 会被隔离，
不会污染下一轮文本、进度或 token；缺少预期 echo 的结果会 fail closed。

尚未对齐 Codex/Claude 的部分来自当前上游边界，而不是 bridge 伪装支持：
Antigravity headless 暂无单工具远程审批、运行中 steer、结果后的后台任务生命
周期，以及手动 compact/context API。TaroCub 对这些能力明确显示为不支持。

以上是 print 运行时。Bot 的 `config.json` 里 `antigravityRuntime: "acp"` 时改走
官方 ACP 服务 `agy acp`：逐次审批（普通审批不带终端沙箱）、运行中引导、上下文
用量、原生 `/compact`、后台命令列表和 `/swarm`（Preview & Quota Heavy）都可用。
print 运行时与未开放 `/swarm` 的版本/会话会在本地明确拒绝 `/swarm` 而不送入模型；
Swarm 真正执行期间（存在 `working` 主 worker）在 6 小时总时长硬上限内暂停空闲超时与
idle 回收（总轮次超时与 Swarm 硬上限不会无限顺延，且全员 `paused`/`waiting` 的空闲
Swarm 不再无限保活）；`/tasks` 对声明 `?swarmTasks=1` 的新客户端展示只读 Swarm 看板
与 worker 状态/辅助角色，对 1.6.0 客户端和旧 Hub 自动剥离新增字段以保持严格 schema 兼容；
当前活跃轮次中的审批与提问保留 worker 名称归属，无活跃轮次归属的孤儿审批/提问请求直接
拒绝，不借用上一轮处理器；Stop 通过关闭 ACP 会话彻底终止 worker。
agy 1.5.10 及以上时，新建的普通 Antigravity Bot 默认用 ACP；幕僚长及其派出的 Bot、
已有 Bot 保持原运行时。App 和 CLI 没有切换入口，需手改该 Bot 的 `config.json`
后重启 Bot。
