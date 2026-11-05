# TaroBot Instructions

Read [AGENTS.md](AGENTS.md) first. It owns the storage, shared App/CLI,
verification, GitHub checkpoint and release rules. Read
[docs/entrypoint-map.md](docs/entrypoint-map.md) before changing behavior and
[docs/neutral-naming.md](docs/neutral-naming.md) before changing historical names.

## Product and architecture

TaroBot is a desktop/mobile AI workspace with a self-hosted Hub and a headless
CLI. Bots use Codex, Claude Code, Kimi, DeepSeek or Antigravity through their
engine adapters. Shared behavior belongs in `src/core`, `src/runtime` and the
Hub/Gateway, not in an optional transport directory.

Telegram and Feishu/Lark adapters and their entrypoints have been retired from
this repository. The standalone build verifies that retired services and the Feishu SDK cannot
enter the App/CLI dependency graph. Do not remove persisted session identifiers,
protocol domains, application IDs or old-state read aliases by global renaming.
New shared prompts, environment variables and output paths use neutral/TaroBot
names. Adapter-only names remain inside the explicit compatibility boundary.

## Implementation and verification

Reproduce reported failures and verify independent audit suggestions before
changing behavior. Preserve unrelated local changes. Add focused regression
coverage for correctness/security fixes, then run the relevant build and broader
checks from the entrypoint map. Green unit tests do not prove native UI behavior,
a real-device round trip, a published release or an installed App update.
Record those acceptance boundaries separately and report remaining gaps.

App host features and CLI commands use the same identity, permissions, durable
queue and APIs. Do not start a second Hub for a one-shot CLI command. UI-only
changes may be CLI-not-applicable; explain that in the change notes.

## Delivery and capabilities

Use the active surface's advertised tools. In the App, `app_send_file` and
`app_send_batch` publish artifacts and return delivery receipts. Consult
`app_capability` for the current file/document/media/browser instructions.
A successful generation, local pathname or rendered Markdown link is not proof
of attachment delivery. Keep fallback delivery syntax only for engines that
lack native App tools and test it separately.

Keep approval, question and cancellation behavior scoped to the owning engine
turn. Child-agent requests must not borrow another turn's host capabilities.
Follow each engine's actual protocol; do not invent unsupported controls or
usage/cost information. See the entrypoint map for engine-specific tests.

## Release and operations

Follow [docs/release-checklist.md](docs/release-checklist.md). Commit and push
verified requested changes to `main` as AGENTS.md requires. An App/CLI release
does not authorize restarting Telegram/Lark fleets or migrating their state.
Do not publish to an external package registry as a side effect.

App transport instructions are host-owned in `src/gateway/agent-instructions.ts`.
Per-Bot persona files are user-owned and must not be overwritten with transport
rules or turn-scoped paths. Historical transport documentation is not an
instruction to restore retired services; see `docs/adapter-retirement-2026-10-21.md`.

## Privacy

Keep credentials, tokens, pairing codes, real host/user identifiers, private
server addresses and personal filesystem paths out of code, fixtures, docs and
commits. Use synthetic fixtures and placeholder hosts. Before pushing, run the
repository secret/privacy checks on the intended changes; never display secret
values in logs or reports. Do not treat a filename denylist as a content DLP
system or claim that an unrun scan passed.
