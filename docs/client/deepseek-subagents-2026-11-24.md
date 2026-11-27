# DeepSeek Harness subagents protocol probe — 2026-11-24

## Environment

- CLI: `dsh 0.2.2-rc.5`
- Transport: private `dsh web --no-open --host 127.0.0.1 --port 0` started through `DeepSeekHarnessHost` with an isolated temporary workspace and state directory.
- Tests executed against live `dsh`:
  1. Parent dispatches a subagent (`reader`, description `Read hello file` / `Read note.txt`), waits for completion, and replies.
  2. Parent dispatches a long-running subagent (`sleeper`, description `Sleep 30s`) and the Host directly invokes `subagents/interruptByUser`.
  3. Parent dispatches a subagent (`sleeper2`) and inspects cancellation and child session addressing.

## Conclusions

1. **Subagent start, progress, and end events on the parent session**:
   - **Start**: The parent emits a `tool/call` for `name: "subagent"` (arguments: `{ name, description, prompt, cwd? }`). Immediately before the `tool/result`, DSH appends a durable `subagent/catalog` event onto the parent's `session/event` stream containing the exact `childId`, `childCreatedAt`, `mode` (`"continuable"` / `"one-shot"` / `"external"`), `label`, and `name`. The `tool/result` immediately returns `"started subagent <name>"` (`isError: false`).
   - **Control tools**: DSH also exposes `list_agents`, `send_message`, `wait_agent`, and `interrupt_agent` as ordinary `tool/call` / `tool/result` pairs on the parent.
   - **End & result report**: When a subagent finishes (or is interrupted), DSH delivers a `user/message` event on the parent session with `source.kind === "subagent-settled"`, carrying `senderSessionId` (`childId`), `stopReason` (`"completed"`, `"aborted"`, `"error"`, `"max-tokens"`, or `"refusal"`), `summary`, and the child's closing report text in `content`. When the child agent unloads, the downlink emits `api-session/removed` (`host/session-removed`) for `childId`.

2. **Subagent internal text and tool events**:
   - Child internal events are **not** pushed onto the parent's `session/follow` stream automatically.
   - Attempting to follow a child with `{ kind: "session", sessionId: childId }` is rejected with `session/agent-busy`: `"subagent Sessions require their durable parent address"`.
   - Opening `session/follow` with the durable subagent address `{ kind: "subagent", parentSessionId, childSessionId, mode }` streams the child's own `snapshot`, `assistant-stream`, and `session/event` frames (`turn/start`, `assistant/message`, `tool/call`, `tool/result`, `turn/end`, and any nested `subagent/catalog`), each tagged with `sessionId: childSessionId` so they can be cleanly isolated from the parent's reply.
   - Separately, `dsh 0.2.2-rc.5` broadcasts `session/control` projection updates as `{ type: "projection", sessionId, seq, changes: Record<string, unknown> }` rather than `{ key, value }`.

3. **Direct Host interruption (`interrupt_agent` / `subagents/interruptByUser`)**:
   - `@deepseek-ai/dsh-subagent` exposes the remote RPC `subagents/interruptByUser` accepting `{ childSessionId }` directly from the Host (no parent model turn needed).
   - Live probe verified `POST /api/subagents/interruptByUser` returns `{ "accepted": true }`, immediately cancels the running child (`sleeper`), and delivers a `subagent-settled` notice with `stopReason: "aborted"` to the parent.
   - Cancelling the parent session (`agent.cancel`) does **not** automatically cancel running child subagents (DSH only cancels children on `workspace/session-stop` for archive admission). Therefore, when stopping the parent foreground turn, the adapter must also interrupt turn-owned running subagents via `subagents/interruptByUser` so no orphans remain.

## Sanitized raw event excerpts

### 1. Subagent dispatch (`tool/call` → `subagent/catalog` → `tool/result`)

```json
{"type":"tool/call","seq":20,"data":{"turn":1,"step":1,"callId":"call_00_subagent_1","name":"subagent","arguments":"{\"name\":\"reader\",\"description\":\"Read note.txt\",\"prompt\":\"Read note.txt and return its content.\"}"}}
{"type":"subagent/catalog","seq":21,"data":{"version":3,"childId":"f9ce631b-fc08-4762-9572-fb920b41da3d","childCreatedAt":1795493579821,"mode":"continuable","label":"Read note.txt","name":"reader"}}
{"type":"tool/result","seq":22,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_00_subagent_1"},"toolCallId":"call_00_subagent_1","content":[{"type":"text","text":"started subagent reader"}],"isError":false}}}
```

### 2. Parent completion notice (`subagent-settled`)

```json
{
  "type": "user/message",
  "seq": 31,
  "data": {
    "content": [
      {"type": "text", "text": "Background subagent reader finished and will do no further work unless you send it more."},
      {"type": "text", "text": "Its closing message:"},
      {"type": "text", "text": "Secret-free probe text: 42"}
    ],
    "source": {
      "kind": "subagent-settled",
      "form": "notice",
      "summary": "Background subagent reader finished and will do no further work unless you send it more.",
      "stopReason": "completed",
      "senderSessionId": "f9ce631b-fc08-4762-9572-fb920b41da3d"
    }
  }
}
```

### 3. Direct Host interrupt (`subagents/interruptByUser`) and aborted settlement

Request:

```json
{"method": "subagents/interruptByUser", "args": {"childSessionId": "93ddc30a-2541-40c1-b5a2-b4719ca74279"}}
```

Response:

```json
{"accepted": true}
```

Resulting parent settlement event:

```json
{
  "type": "user/message",
  "seq": 72,
  "data": {
    "content": [
      {"type": "text", "text": "Background subagent sleeper was stopped before it finished."},
      {"type": "text", "text": "Its closing message:"},
      {"type": "text", "text": "I'll run the exact command as requested."}
    ],
    "source": {
      "kind": "subagent-settled",
      "form": "notice",
      "summary": "Background subagent sleeper was stopped before it finished.",
      "stopReason": "aborted",
      "senderSessionId": "93ddc30a-2541-40c1-b5a2-b4719ca74279"
    }
  }
}
```
