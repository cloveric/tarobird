# Architecture Notes

This document describes TaroBot's standalone App and headless host architecture.
Use [Entrypoint Map](entrypoint-map.md) for current code ownership and regression
requirements, and [Standalone Core](standalone-core.md) for package boundaries.

## Purpose

TaroBot is a local-first AI workspace with desktop/mobile clients and a headless
CLI controlling the same host core. Each host owns its Bots, engine processes,
workspace and durable state. Hosts can join a private network; phones retain
independent device membership. Neither a second UI nor joining a network creates
a second owner for an existing host's runtime or moves its Bots to another host.

The host delegates execution to native Codex, Claude, Kimi, DeepSeek and
Antigravity adapters. Provider authentication and supported capabilities remain
engine-specific. The old Feishu/Lark and Telegram Bot transports are retired;
see [retirement boundaries](adapter-retirement-2026-10-21.md).

## System Model

```text
Desktop / mobile client
  -> authenticated Hub connection (direct or optional VPS relay)
  -> HubServer: durable messages, device access, network and pending queue
  -> App Gateway worker for the conversation's Bot
  -> core/message-handler + runtime/bridge + session-manager
  -> engine adapter and native CLI
  -> structured events, replies and file receipts back through Hub
```

```text
bin/tarobot.mjs -> src/index.ts
  -> host-cli (default, or explicit host)
  -> desktop-host / hub -> the same Hub core
  -> gateway -> Bot worker
  -> relay / gdocs / search-mcp -> dedicated subcommand
```

If bus is enabled, another local path exists:

```text
Instance A
  -> src/bus/bus-client.ts
  -> HTTP POST 127.0.0.1:<port>/api/talk
  -> src/bus/bus-server.ts on Instance B
  -> src/runtime/bridge.ts on Instance B
  -> local engine on Instance B
  -> response back to Instance A
```

The important architectural fact is that the system has multiple request entry points but only one real execution core: `Bridge.handleAuthorizedMessage()`.

That is the main seam we should preserve and strengthen.

## Main Runtime Layers

### 1. Boot and Process Lifecycle

The standalone dispatcher is [src/index.ts](../src/index.ts). It selects the
headless CLI, desktop host, Hub, Gateway worker or an auxiliary subcommand; it
does not start a Telegram polling loop. [src/host-cli](../src/host-cli),
[src/hub](../src/hub) and [src/gateway/worker.ts](../src/gateway/worker.ts) own
host lifecycle, supervision, recovery and per-Bot process startup.

The former polling/WebSocket transport bootstrap and fleet lifecycle are removed.
Only the Host owns App/CLI process startup and recovery.

### 2. Delivery Layer

The App delivery path is owned by [src/gateway/channel.ts](../src/gateway/channel.ts),
[src/gateway/app-tools.ts](../src/gateway/app-tools.ts),
[src/gateway/app-batch.ts](../src/gateway/app-batch.ts) and shared core delivery
helpers. Host receipts distinguish accepted publication, definite failure and
unknown outcomes; unknown side effects must not be blindly replayed.

Shared fallback attachment delivery lives in
[src/core/shared/artifact-delivery.ts](../src/core/shared/artifact-delivery.ts).
It receives explicit reply ports and contains no network client or SDK.

### 3. Bridge Layer

[src/runtime/bridge.ts](../src/runtime/bridge.ts) is the narrow execution core.

It is responsible for:

- access checks
- session lookup / creation
- bridge-specific system instructions
- adapter invocation
- rebinding session IDs when the engine returns a new persisted session

This layer should stay small. When behavior must be shared across App, CLI, bus and optional integrations, it should usually live here or just below here.

### 4. Adapter Layer

Engine-specific behavior lives under [src/codex](../src/codex).

Current adapters:

- `ProcessCodexAdapter`
- `CodexAppServerAdapter`
- `ProcessClaudeAdapter`
- `ClaudeStreamAdapter` for streaming-oriented Claude behavior
- `KimiAcpAdapter` for persistent Kimi ACP sessions and detached-task hooks
- `DeepSeekHarnessAdapter` over a private, supervised `dsh web` host
- `ProcessAntigravityAdapter`

The base adapter interface stays channel-neutral while exposing optional native
capabilities:

- send a message
- return text, session identity, and optional usage
- expose bridge instruction mode differences
- stop/steer active work where the engine supports it
- validate and list resumable external sessions
- read context pressure and structured Goals where available

This boundary keeps clients, host state and optional transports independent of provider-specific CLI quirks.

### 5. State Layer

Persistent state lives under [src/state](../src/state).

Important stores:

- `access-store.ts`
- `session-store.ts`
- `runtime-state.ts`
- `usage-store.ts`
- `file-workflow-store.ts`
- `audit-log.ts`
- `archive.ts`
- `instance-lock.ts`
- `json-store.ts`

Bot-level configuration, sessions and runtime state use file stores. Hub messages,
queues and membership use SQLite in `src/hub/database.ts`; Board state also uses
SQLite. Both storage forms require atomic updates, explicit ownership and recovery
that preserves uncertain outcomes.

## Instance State Model

The standalone host owns `hub.sqlite` and `bots/<botId>/` beneath its selected
state directory. Desktop and headless CLI use the same state contract and must
coordinate ownership before opening an existing host. See [Host CLI](host-cli.md)
and [Standalone Core](standalone-core.md).

The following directory layout belongs to retired legacy instances; it is not
the standalone host default. Existing paths and persisted routing IDs remain
compatible:


```text
~/.cctb/<instance>/
```

Typical contents include:

- `.env`
- `config.json`
- `access.json`
- `session.json`
- `runtime-state.json`
- `usage.json`
- `audit.log.jsonl`
- `workspace/`
- `inbox/`
- workflow and archive artifacts

This directory is the real unit of isolation.

For those retired legacy instances, isolation includes:

- separate Telegram bot token
- separate config and access state
- separate bridge/session state
- separate workspace and inbox

It does **not** fully mean separate engine-global state anymore. Claude and Codex auth/config homes may be shared with the user's main CLI, by design, to avoid auth-refresh races. DeepSeek uses a private per-instance writable `DSH_HOME`, but links the authenticated shared credentials/profiles while copying mutable settings; Kimi similarly retains its native user-level auth/plugins.

That trade-off should remain explicit whenever we discuss "isolation".

## Current Trust Boundaries

The standalone Hub authenticates devices, enforces conversation/Bot ownership,
and validates signed private-network membership. A relay forwards traffic; it
does not replace end-to-end host identity checks. Local controller credentials
and engine authentication remain separate. See [Security Boundaries](security-boundaries.md).

The additional boundaries below describe shared file/bus behavior and historical transport-era contracts. The retired transport paths below are
not current entrypoints and do not authorize running old fleet commands.

### Historical Telegram Boundary

This subsection applies only to the retired legacy adapter.

Telegram is an untrusted input source until access control passes.

For normal chats, authorization is enforced through the access store:

- `pairing`
- `allowlist`

For `chatType === "bus"`, bridge access is intentionally auto-allowed. This is correct only because bus requests are supposed to already be authenticated at the bus server layer.

### Local Bus Boundary

The Agent Bus is local HTTP on loopback.

Security currently depends on:

- per-instance registry entries
- shared secret authentication
- allowed-peer checks
- loopback binding
- health/fingerprint probing to avoid talking to the wrong local listener

This is a local trust boundary, not a public API boundary. We should keep treating it as privileged local control-plane traffic.

### File Delivery Boundary

File delivery is one of the highest-risk parts of the product because it crosses from model output into real filesystem reads and then into App or optional transport delivery.

The intended model is:

- inline fenced file blocks for small text/code files
- explicit `[tool:{"name":"send.file","payload":{"path":"/absolute/path"}}]`,
  `[tool:{"name":"send.image","payload":{"path":"/absolute/image.png"}}]`, or
  `send.batch` tags for existing files
- native App delivery tools are preferred when the engine exposes them
- `[send-file:/absolute/path]` / `[send-image:/absolute/path]` tags remain an
  explicit compatibility path for engines without native App delivery tools;
  only those capability-gated instructions teach them. A successful native
  receipt must never be followed by a duplicate compatibility directive
- path restrictions for legacy tags, plus explicit receipt tracking for all tool
  deliveries

This boundary has already been a source of security bugs. Any new work here should default to conservative path validation and regression tests.

## Important Data Flows

### Historical Telegram Message Flow

This flow applies only to the retired legacy adapter.

1. Service polls Telegram updates.
2. Update is normalized.
3. Delivery layer handles commands, attachments, and workflow preparation.
4. Bridge checks access and resolves the chat session.
5. Adapter invokes the engine.
6. Delivery layer records usage, updates audit state, and sends Telegram responses.

### Delegated Bus Flow

1. A command in `delivery.ts` decides to delegate.
2. `bus-client.ts` resolves the peer through the registry.
3. The target instance receives `/api/talk`.
4. The target bus handler calls `bridge.handleAuthorizedMessage()` with `chatType: "bus"`.
5. The target instance returns plain text plus metadata.
6. The caller formats that response into the user-facing Telegram reply.

### Resume Flow

Resume is a specialized bridge between local provider session persistence and Telegram chat state.

The key pieces are:

- scanning provider session history
- mapping a Telegram chat onto an existing provider session
- storing that mapping in instance config + session state
- making sure file access and workspace assumptions follow the resumed workspace

This is one of the product's most useful features and one of its most state-sensitive ones.

## Design Strengths Worth Preserving

### Narrow bridge core

The project already has a good center of gravity in `Bridge.handleAuthorizedMessage()`.

That is worth preserving because it gives us one place to unify behavior that otherwise drifts between Telegram, bus, and future entry points.

### File-backed state with atomic primitives

`JsonStore` already gives us:

- atomic temp-file + rename writes
- file permissions
- schema version stamping
- downgrade protection

This is the right foundation for a small local tool.

### Explicit per-instance model

The system thinks in instances, not just chats. That is the right abstraction because configuration, token, access policy, workspace, and bus role all hang off the instance.

### Strong regression-testing habit

The repository already has a healthy test suite and recent fixes have repeatedly been locked in with regression tests. That habit is a real asset and should continue.

## Current Design Tensions

These are the places where the architecture is most likely to drift or regress.

### 1. Cross-entry consistency

The same engine invocation can currently be reached through:

- normal Telegram updates
- command subflows like `/fan`, `/verify`, `/btw`
- bus HTTP delegation

The biggest historical class of bugs has been "fixed in one path, missed in another".

### 2. Delivery layer breadth

`delivery.ts` is doing real product work, but it also concentrates:

- command parsing
- workflow control
- usage/budget handling
- file delivery
- delegation
- locale text
- retry logic

It is still manageable, but it is now clearly the broadest file in the system and the most likely place for new features to bypass existing invariants.

### 3. State policy is implicit

The code knows a lot about which files are authoritative and how they interact, but the repository did not previously have one place that explains:

- what each state file means
- which writes must be serialized
- which failures are recoverable
- which data is authoritative vs derived

That implicit knowledge slows down safe iteration.

### 4. Shared engine home vs instance isolation

The recent auth-race fix improved reliability by sharing real CLI config homes, but widened the blast radius of engine-global writes.

That is an acceptable trade-off for now, but it needs to stay explicit in docs and code comments.

## Improvement Priorities

These bridge-era design suggestions are historical context, not a current open
issue list. Check the entrypoint map, current code and audit records before
implementing one; several shared-core extractions are already complete.

These are the highest-value architectural improvements for the next phase of the project.

### 1. Create canonical cross-cutting helpers

Anything that should apply to every engine turn should not live only in one caller.

The likely candidates are:

- usage recording
- budget enforcement
- audit event emission
- retry / stale-session recovery policy
- progress / delivery lifecycle markers

Recommendation:

- keep Telegram-specific rendering in `delivery.ts`
- move shared "post-engine turn accounting" into a small common helper or a lower layer near `Bridge`

### 2. Document the state model formally

This document is the start, but the next useful step is a short per-file state model:

- file path
- owner module
- canonical schema
- recovery behavior
- security sensitivity

Recommendation:

- add a dedicated `docs/state-model.md`

### 3. Introduce a lightweight event/timeline model

The project already has audit logs, workflow state, runtime state, and message replies, but not one canonical event vocabulary.

Recommendation:

- define a compact internal event model for engine turns and delegated work
- use it first for observability and debugging, not for UI ambition

This should stay much smaller than Paseo's timeline system, but the direction is still right.

### 4. Split product orchestration from transport plumbing

`delivery.ts` would be healthier if command parsing and user-facing orchestration were gradually separated from lower-level helpers such as:

- usage/budget accounting
- file delivery policy
- delegation accounting
- resumed-session safety checks

Recommendation:

- extract a few narrow helpers instead of attempting a large refactor
- preserve current behavior while shrinking the surface area of the main delivery file

### 5. Make trust boundaries explicit in future features

Any feature touching:

- bus
- resumed sessions
- file delivery
- shared engine home

should be reviewed first as a trust-boundary change, not just as a UX feature.

That framing has already paid off in past fixes and should become standard practice.

## Working Rules For Future Changes

When adding or changing behavior, prefer these rules:

1. If the behavior should apply to all engine turns, do not implement it only in one Telegram command path.
2. If a change touches state files, specify which file is authoritative and whether writes must be serialized.
3. If a feature crosses from model output into filesystem reads or outbound delivery, treat it as a security-sensitive change.
4. If a new command internally triggers another engine turn, verify usage, budget, audit, and stop semantics explicitly.
5. If a design increases shared global state, document the blast radius in code comments and docs.

## Near-Term Next Docs

The next documentation steps that would materially help the project are:

- `docs/state-model.md`
- `docs/command-flow-notes.md`
- `docs/security-boundaries.md`

Those three would cover most of the architectural ambiguity that still slows safe iteration.
