# TaroBird naming and compatibility

The product display name is TaroBird. App desktop/mobile and the headless CLI
use the same host implementation; `tarobird` and the retained `tarobot` command
are aliases. New installers and App bundles use TaroBird, including
`TaroBird.app` and the Windows default install folder and shortcuts. Existing
installation paths stay in place on upgrade. Internal npm package names, App
IDs, keychain services, native plugin names, QR filename validators, stored
paths, notification payload literals and updater channels remain compatibility
contracts. Do not mass-replace them. Existing bot names/content are user-owned.
The active repository is `cloveric/tarobird`; the former repository is a private
historical archive. See [repository migration](repository-migration.md).
New product names do not imply a connection to Feishu or Telegram.

The owner limited this naming change to installers, application names and new
installation directories. Data directories and Bot workspaces are deferred.
See [artifact naming and verification](client/artifact-branding-2026-11-05.md).

| Surface | Canonical name | Historical input retained |
| --- | --- | --- |
| Incoming / generated working files | `.tarobot-files` / `.tarobot-out` | Existing `.lark-files` / `.lark-out` and stored archive `.telegram-files` paths remain readable |
| Per-Bot environment | `bot.env` | `lark.env` fallback |
| Bot process identity | `TAROBOT_INSTANCE`, `TAROBOT_STATE_DIR` | Legacy input variables accepted; App children emit neutral identity |
| Active App turn | `TAROBOT_ACTIVE_TURN`, `TAROBOT_ACTIVE_INSTANCE`, `TAROBOT_ACTIVE_STATE_DIR` | Feishu restart guards retain their own namespace |
| File-send policy | `TAROBOT_ALLOW_ANY_FILE_PATH` | `CCTB_LARK_ALLOW_ANY_FILE_PATH` |
| Attachment retention | `TAROBOT_INBOUND_FILE_RETENTION_DAYS` | `LARK_INBOUND_FILE_RETENTION_DAYS` |
| Streaming override | `TAROBOT_ELEMENT_STREAM` | `CCTB_LARK_ELEMENT_STREAM` |
| Concurrency limit | `TAROBOT_MAX_CONCURRENT_TURNS` | `TAROCUB_MAX_CONCURRENT_TURNS`, `CODEX_TELEGRAM_MAX_CONCURRENT_TURNS` |
| Bot config keys | `elementStream`, `steerEnabled`, `steerWindowSeconds` | Corresponding `lark*` keys are read and normalized on explicit update |
| Numeric identity maps | `chat-id-map.json`, `user-id-map.json` | `lark-chat-id-map.json`, `lark-user-id-map.json` |
| Shared group policy for App | `group-mode.json` | `lark-group-mode.json`; App-specific overrides remain in `gateway-group-mode.json` |
| Fresh synthetic engine sessions | `tarobot-*` | All engines still recognize `telegram-*`; existing native bindings are returned unchanged |
| App fallback question directive | `send.choice` | `lark.choice` remains accepted for resumed output |
| New App timeline channel | `gateway` | Recovery reads both `gateway` and old `lark` records |
| Shared interfaces / functions | `Core*` / neutral names | Historical schema identifiers remain unchanged; retired facades are removed |

Environment precedence is explicit process settings, `bot.env`, old `lark.env`,
then allowed shared extras. Aliases are normalized at each level, so an explicit
old-name setting still outranks a lower-priority new-name file setting. Within
one source, the canonical spelling wins. Zero and false are real values.
Only named runtime settings can pass through Bot env files; the entire
`TAROBOT_` namespace is reserved against identity/active-turn injection.
Full-access App/CLI-host Bots now default to allowing external artifact paths;
an explicit `TAROBOT_ALLOW_ANY_FILE_PATH=0` retains the workspace boundary.
The shared sender rechecks effective Bot permissions rather than inferring them
from a resumed thread's old Lark instructions. See [permissions](permissions.md#文件发送路径).

State fallback is **missing-file only**. Invalid JSON, unreadable files and newer
schemas do not fall back to an older copy. New App writes are atomic and use the
canonical filename; retired adapter data is not migrated. Existing original files remain as compatibility evidence;
there is no live filesystem move, destructive cleanup or background rewrite.
Once a canonical file exists it is authoritative, including an explicitly empty
policy. An older binary that does not understand these names must be restored
with its corresponding state backup rather than pointed at newly updated state.

## Names that must remain

- User-invoked third-party integrations, their credentials/scopes and historical
  scratch-directory readers retain accurate platform names. The retired Bot
  transport SDKs and fleet CLI are removed; user tools and stored files are not.
- Stored routing hashes, `lark:<chat>[:<thread>]` keys, `telegramChatId` fields,
  cron/delivery schema fields, the bus health fingerprint and `cctb_lark` callbacks remain compatibility data.
  Rewriting those strings would break old queues, cards, authorization and resume.
  Historical cards are still handled by the same validation and permission checks.
  `client-protocol/queue-notice.ts` also validates these historical task bindings
  when presenting compact Gateway queue notices (including already stored cards).
  This compatibility reader does not rename routing keys or operate a transport.
  New queue notices carry versioned `appQueue` state and a stable neutral
  `queued_turn_cancel` element ID; the action continues using the existing
  task-scoped authorization path.
- Native App IDs now use `com.tarobot.client`, with fresh client vault namespaces.
  Existing Host roots, service labels, executable names and `tarocub://` protocol
  links retain compatibility. Desktop App and CLI resolve the same existing
  Host without moving databases/workspace paths; mobile clients pair afresh.
  See [native identity transition](client/native-app-identity-2026-10-28.md) for
  migration tests and the separate signing, update and physical-device gates.
- Third-party source names, links and historical release/audit records describe
  their original sources. They are not product labels.

## Source ownership and checks

Shared Bot settings are in `src/state/instance-config.ts`, conversation helpers
and language types in `src/runtime`, shared command/directive handlers in
`src/core/shared`, and tool dispatch in `src/tools/tool-*`. The retired transport facades are removed. The standalone
graph and source-import checks reject dependencies on their old locations.

Agent Bus shared commands use Core-owned message/reply interfaces and
`runtime/markdown-chunks`; App replies are not pre-split by Telegram's limit.
Shared artifact delivery retains its existing chunking contract in
`runtime/message-renderer`; the former Telegram export is removed.
The [Bus transport residue audit](client/agent-bus-transport-audit-2026-10-18.md)
records the reproduced defects and the health/state names retained deliberately.

Validation includes canonical/legacy config precedence, numeric-ID collision
preservation, clearing legacy group rules, corrupt-state refusal, engine identity
isolation, new and old logical session IDs, App directives for all five engines,
and restart recovery from the new timeline channel. Full host tests and both
standalone builds cover imported-name changes; the client
build validates the shared protocol. No new CLI command is required: these are
shared implementation/configuration names, not a new capability. App installers
and the standalone CLI distribution must be built from the same revision at the
next release.

## Adapter retirement (2026-10-21)

The transport implementations, SDK package and old service/CLI entries are removed.
`lark:` routing keys, `telegramChatId` and `cctb_lark` callbacks remain **current
persistent/protocol schema**, not merely old-data fallbacks. Owner-selected tools
and their explicitly configured credentials remain available. See
[retirement scope and coverage](adapter-retirement-2026-10-21.md).
