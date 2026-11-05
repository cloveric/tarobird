# Standalone App runtime boundary

TaroBot installs and runs without a Feishu account, app, credentials, SDK or CLI.
A configured engine still needs its own provider login. Optional user tools are
not platform dependencies.

Current retirement scope and verification are recorded in
[adapter retirement](adapter-retirement-2026-10-21.md). Historical acceptance
records below describe the earlier adapter-isolation work.

## Module ownership

```text
React client → Tauri / Capacitor shell → Hub → App Gateway
                                               ↓
                          core + runtime + state + engine adapters
```

- `src/core/engine-factory.ts` constructs Bridge, sessions and engine adapters.
  Gateway no longer constructs a Lark service or imports `src/service.ts`.
- `core/message-handler`, `runtime`, `card-actions`, `bus` and `cron` own shared
  queueing, cancellation, approvals, scheduled execution and turn delivery.
- `core/files`, `delivery`, `app-delivery`, `voice` and `asr-watchdog` own shared
  file/receipt and transcription behavior. They use explicit channel capabilities.
- `core/managed-card`, `image-upload`, `mention-resolver` and `platform-policy`
  define ports, not SDK discovery. Empty defaults never authenticate or call
  Feishu. Optional document/chat integrations require an injected implementation.
- `gateway/channel.ts` implements Hub transport directly; its old SDK-shaped
  `rawClient` facade was removed. Resource downloads still verify that the
  attachment belongs to the message or its quoted parent in the same conversation.
- `gateway/platform-profile.ts` supplies App instructions, commands and group
  policy. Retired SDK operation/tenant-scope adapters have been removed.
- `src/index.ts` is the standalone entrypoint. The old service, legacy entrypoint,
  transport facades and SDK package are retired. Shared implementation remains
  in Core/Runtime/State; no alternate shared-core fork was introduced.

Shared interfaces and helpers now use `Core*` names. Bot configuration lives in
`src/state/instance-config.ts`, conversation keys and language types in
`src/runtime`, and shared commands/directive parsing in `src/core/shared`.
Tool dispatch lives in `src/tools/tool-*`. Shared reply types/rendering are in
`src/runtime`; artifact delivery uses injected ports in `core/shared/artifact-delivery`.
The build rejects runtime, type-only and test imports into retired transports.
The portable card grammar and persisted callback fields stay compatible.
See [the naming contract](neutral-naming.md) for new names and retained aliases.

App user prompts contain the user's message and any attachment/quote context,
without the legacy `<lark_context>` routing prefix. The per-dispatch channel
profile controls both formatting and body extraction, including queued messages
and attachment bursts; literal tags in App user text remain ordinary content.
Routing and reply IDs remain structured runtime fields, and native App tools are
bound to the current conversation. Existing
`lark:*` session keys are not renamed, and previously saved native titles/history
are not rewritten by this change.

## Installation and release

Root `npm ci` has no `@larksuiteoapi/node-sdk` dependency or SDK postinstall hook.
The old SDK manifest, lockfile, patch and adapter CI job have been removed.
Shared and compatible-schema tests now belong to the default suite.

`npm run build` removes stale host outputs, compiles the App dependency closure
and checks all entrypoints using an esbuild dependency graph. Claude's approval
MCP helper and DeepSeek's App plugin are explicit build roots because engines
load those files by path. The graph rejects reverse imports into `src/lark`, the
retired adapter paths, the legacy service/entrypoint and the SDK. Source checks also cover erased
types, literal dynamic imports and test mocks; negative-guard fixtures are explicit.

After the client build, `npm run pack:standalone` creates
`dist/standalone-package`. Only compiled runtime graph files, client assets,
relay runtime, documentation and the production manifest/lock are included.
`npm-shrinkwrap.json` preserves locked production versions inside `npm pack`
archives (npm intentionally excludes ordinary `package-lock.json`). An explicit
files allowlist excludes old archives, source, tests and adapters.

```sh
npm ci
npm ci --prefix client
npm run build --prefix client
npm run pack:standalone
cd dist/standalone-package
npm ci --omit=dev
npm start -- init --name "My host" --state-dir /absolute/path/to/new-hub-state
npm start -- hub run --state-dir /absolute/path/to/new-hub-state
```

`verify-standalone-package.mjs /path/to/installed-package` starts only a temporary
Hub with an empty HOME, no Feishu credentials and a minimal PATH; it checks real
CLI startup, health, packaged client serving and dynamic helper presence.

## Compatibility contract

No persisted session, workspace, memory or conversation identity migration occurs.

| Retained data/name | Reason |
| --- | --- |
| `lark:<chatId>[:<threadId>]` session/queue keys | Existing session bindings, memory isolation, resume and turn locks use them. |
| `lark-chat-id-map.json`, `lark-user-id-map.json`, `lark-group-mode.json` | Read fallbacks for `chat-id-map.json`, `user-id-map.json`, `group-mode.json`; original files are retained. |
| Existing `.lark-files` and `.lark-out` directories | Historical attachment/output paths stay readable; new App work uses the TaroBot names below. |
| `cctb_lark` card actions and `lark*` historical fields | Existing cards, cron records, receipts and logs must remain interpretable. |
| Explicit Bot-state `lark.env` fallback | Existing ASR/model/business-tool configuration continues to load; no fleet discovery occurs. |
| `CCTB_LARK_*`, `TAROCUB_*`, `CODEX_TELEGRAM_*` identity variables | Old inputs remain readable; new App workers and engine children use `TAROBOT_INSTANCE` / `TAROBOT_STATE_DIR`. |
| Native IDs, URL schemes and old state directory names | Existing native pairing and local caches remain addressable. |

App desktop hosts and standalone CLI hosts write incoming working copies to
`workspace/.tarobot-files/<messageId>/input/` and generated files to
`workspace/.tarobot-out/<requestId>/`. Ordinary turns, card continuations and
scheduled tasks share the same paths for all engines. File Center labels these
groups “Received attachments” and “Generated files”; physical paths remain in
details, and old groups are marked as legacy folders. Existing IDs and labels
stay unchanged.

Old files are not moved or renamed behind a resumed session. Existing inbound
retention settings still apply to both old and new working-copy directories;
instance backups exclude both generations as before. The durable Hub attachment
library (`host/attachments`) is unchanged. No legacy adapter data migration or
old service operation is performed.

New per-Bot environment overrides can use `bot.env`. Precedence is explicit
worker environment, then `bot.env`, then historical `lark.env`, then filtered
shared extras. Old transport credentials are not imported from the legacy file.
Explicitly configured engine-tool credentials and owner-selected Skills/MCP stay
usable. No production blanket child-process or Feishu-tool blocker was added.

Hub-managed Bot restart still uses the owning supervisor's idle/restart receipt
flow. Externally registered Gateways need an explicit maintenance owner; the App
no longer falls back to `lark service restart` or a global legacy fleet command.

## Behavior fixes found during validation

- A late unavailable/failed managed-card send cannot revive a cancelled approval.
- A native asynchronous question response enters the originating live turn when
  the engine supports steering. Previously it could queue behind the same turn
  that was waiting for its answer. The run identity is rechecked, and duplicate
  taps remain deduplicated. Ordinary choice cards keep their queued semantics.
- Dynamically loaded Claude/DeepSeek helpers are present in the production graph
  and archive, rather than relying on source-tree files.

## Historical validation on 2026-10-11

Live acceptance used an external source directory with no optional adapter or
SDK installed, isolated Hub/Bot data, and an executable PATH without Lark CLI.
Two paired HTTP/WebSocket clients exercised the actual App protocol, compiled
Hub, separate compiled Gateway workers, and real Codex CLI 0.162.1 / Claude Code
2.1.296. Both engines passed:

- Text response and delivery to both protocol clients.
- Attachment plus caption, native App file return and exact byte comparison from
  the other client.
- Synthetic speech uploaded through the App, transcribed by the real local ASR
  service, then understood by the CLI.
- Native question creation, App card selection and resumed engine answer.
- Streaming text, stop, follow-up and preservation of a prior context marker.

An acceptance-only observer recorded no Feishu SDK, CLI or Node HTTP calls.
It observes rather than blocks subprocesses. Static graph and clean-install
checks separately establish the platform dependency boundary. It is not a
system-wide packet capture of arbitrary native binaries.

Engine authentication uses existing normal provider logins. Claude's acceptance
launcher retains normal HOME/USER/LOGNAME for macOS login lookup, and uses
`--strict-mcp-config --setting-sources ""` to omit unrelated user extensions in
this test only. Production does not add these restrictions. Initial launcher
login failure and an inherited user integration were not counted as passes.

The production directory was installed with production dependencies only and its
actual CLI served both health and packaged client assets with an empty HOME.
A macOS release-profile `.app` was also built successfully; its bundle contains
the Rust executable, Info.plist and icon, with embedded frontend assets and no
Node/Feishu package tree. Client npm and Cargo lockfiles contain no Feishu SDK.

Final gates: the clean standalone source installation (including separately
installed client development dependencies, with no optional Feishu package)
passed **197 test files: 2708 passed, 1 skipped**. The optional adapter passed
**56 test files: 1217 passed**. Full TypeScript checking, root/client builds and
diff whitespace checks passed. Earlier resource-contention failures were rerun;
a fixed-delay Kimi test now waits for its actual notification event.

The extracted production archive also passed the same real Codex and Claude
five-path acceptance above. The archive is approximately 5.3 MB; the macOS
release-profile application bundle is 13.24 MiB. Neither is a signed/notarized
public release.

### Evidence limits

- These live chat checks use protocol clients, not native-window automation or
  physical phones. Native App build/inspection is not native interaction signoff.
- Android/iOS/Windows installers, app-store signing/notarization, remote VPS/TLS,
  background push and real-device camera/microphone were not rerun here.
- DeepSeek, Kimi and Antigravity have adapter regression coverage; no new live
  provider acceptance was performed for those engines in this refactor.
- Legacy Feishu adapter testing is isolated with doubles; no real legacy service,
  account, data directory or fleet restart was used.
- Application-layer encryption, UI and message protocol were not redesigned.

Raw local acceptance reports and temporary runtime logs remain outside version
control. See the task delivery for their exact paths and final test results.

旧主机已有身份和数据库、但缺少 `config.json` 时，可在后台停止后用原名称和原状态目录显式执行 `tarobot init`。恢复只补回历史默认端口配置，不修改身份或数据库；旧 schema 的迁移仍由正常服务安装/升级流程负责。如果旧数据库从未保存主机名称，返回 `profileNamePending: true`，启动后再用 `tarobot host name` 设置名称。不要更换状态目录或生成新身份。
