# Codex 6.1 model presets and effort

The creation picker used the shared, static Codex presets in
`src/codex/model-capabilities.ts`. It omitted `gpt-6.1-sol`, `gpt-6-sol` and
`gpt-6-luna`. The same missing capability entries also rejected these models'
`max` / `ultra` settings when an exact model ID was entered manually.

The fix adds the three exact IDs to that shared catalog and effort validator.
Their advertised capabilities were checked against the installed Codex CLI
0.163.0 model catalog fetched on 2026-10-20:

| Model | Explicit effort levels |
| --- | --- |
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |

Each also permits following the engine default without an explicit override.
No unadvertised 6.1 variants are inferred from their names. Older presets,
unknown/custom model handling, the current new-Bot default (`gpt-6-astra`) and
existing saved model/effort selections remain unchanged.

## Shared entry points and CLI

Creation, existing-Bot model settings, the effort picker, and `/model` commands
all consume the shared host catalog/validator. The existing authenticated CLI
`tarobot bots model <id> --json` returns the new choices, and a revision-checked
update accepts `--model gpt-6.1-sol --effort ultra`. No new command, protocol,
permissions, session migration or client presentation code is needed.

This remains a curated catalog, not automatic provider model discovery. A
preset is not proof that every account or older Codex installation can run it;
the engine remains authoritative for execution. The target host and its Bot
workers must run the updated code before its connected clients see the change.
The already-published 1.0.96 artifacts do not include this subsequent fix.

## Verification

Before the fix, nine new regression cases failed: missing creation choices,
missing extended effort choices and rejected supported model/effort saves.
Verification uses isolated Hub/Gateway workers and browser fixtures; no
production Bot configuration or session is changed, and no new model turn is
charged by these tests. The earlier local run passed 331 tests across `effort-settings`, `model-settings`,
`hub-bot-manager`, `host-cli-model`, `model-brand`, `client-model-selection`,
`telegram-instance-config`, `telegram-simple-commands` and `app-server-adapter`.
The client build, including translation and TypeScript checks, also passed.

At the original draft handoff, macOS removable-volume authorization currently blocks the
original checkout and test dependencies. The host build was interrupted and
Chromium/WebKit creation, model-settings and effort journeys have not run.
The PR files were reconstructed from the recorded patch against unchanged main;
the earlier full test/build results have not been rerun on the PR snapshot.
Complete those checks before marking the PR ready. No release or installed App
has been changed by this PR.

## Integration verification (2026-10-21)

External storage access was restored. The merged source passed the standalone
host build, client build, 5,786 unit/regression tests (five platform-specific
skips), 76 native Rust checks, and the creation/model-settings/effort journeys
in both Chromium and WebKit. Removed transport suites are represented by their
Core replacements, including an ordered model catalog check and rejection of
Luna with unsupported ultra effort. Release/install receipts are tracked in
[the integration report](integration-release-2026-10-21.md); earlier draft limits
above describe the original handoff, not the current integration result.
