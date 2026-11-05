# TaroBot 1.0.87 / host CLI 0.1.435

This release packages the desktop ADHD density and selection redesign, compact
phone capability controls, removal of the persistent hidden-Bot banner, and
Android notification alert defaults and settings access.

## Changes

- Desktop ADHD is beside By Bot and By conversation. Select conversations in
  the existing list. Choose automatic or 2–6 columns, with up to 12 panes.
  Compact pane headers and independent 11–16 px text (12 px by default) leave
  more room for messages without changing the ordinary chat font.
- Phone Skills/MCP controls use compact visual dimensions while retaining
  touch targets. The persistent hidden-Bot explanation is removed; the preference
  and empty-list guidance remain available.
- A newly created Android message notification channel explicitly enables the
  system notification sound and vibration. Existing channel preferences are
  preserved. Notification readiness shows sound/vibration status and provides
  a direct route to Android's notification settings. An upgrade cannot silently
  override an existing muted channel, system silent mode or Do Not Disturb.

These are renderer and Android presentation/notification changes. They require
no new headless command or engine-specific behavior. CLI 0.1.435 packages the
same shared host and updated web client; Agent Bus routing is unchanged.

## Compatibility and verification

App **1.0.87**, host/CLI **0.1.435**, Node **24.14.0**, protocol **1**,
membership **2**, Hub schema **17** (accepted **1–17**). Android version code
**2026101705** retains the application ID, Firebase configuration and original
signing certificate. Mac is ad-hoc sealed, without Apple notarization; Windows
has a pinned-key updater signature, without Authenticode signing.

- [Mac Apple Silicon / CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.87).
- [Windows x64 / CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.87).
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.87).
- [Executable source 4901caf](https://github.com/cloveric/tarobot/commit/4901cafa17805fde7f683db9ee23c57c2b8892ff).
- [Artifact hashes and publication receipt](evidence/release-1.0.87-2026-10-17.json).

| Surface | Verified result | Boundary |
| --- | --- | --- |
| Complete source gate | 322 files; 4,230 passed, 1 Windows-only skipped; standalone build passed | Pinned Node 24.14.0, four workers |
| Client build | Clean dependency install, translations, TypeScript and Vite passed | Shared renderer |
| Mac native tests | 64 passed | Policy, lifecycle and recovery |
| Android release | Original signer, 30 unit tests, lint 0 errors / 24 warnings; 394 frontend files matched | No physical-phone execution |
| Final Mac DMG | Read-only mount, deep/strict seal, version and icons passed; embedded renderer and 755 host/CLI files matched | Apple Silicon, ad-hoc seal |
| Final Windows installer | NSIS extraction, exact embedded renderer, 755 host/CLI files and native dependency checks passed | Cross-built x64, no native Windows execution |
| Native Mac updater | Tampered archive rejected; signed archive installed and Hub resumed; identity, pairing, chat and file retained | Disposable App and synthetic state on external disk |
| Clean CLI | Production dependency tree, local pack/extract, second clean install and startup passed | No Feishu SDK or external registry publication |
| CLI upgrade | 0.1.434 → 0.1.435; identity, controller, network and workspace retained | Disposable external host |
| Real Codex chain | Text/two-client sync, original-file round trip, local ASR, question submission and stop/resume passed | Client protocol → Hub → supervised Gateway → real engine |

Both final desktop executables contain the configured private GitHub provider
and pinned updater key. Their signed versions and downloaded release artifacts
are verified separately from compilation. The Mac signed archive, signature,
manifest and bootstrap DMG are published together; a DMG alone is insufficient
for application updates.

The feature commits also passed the previously recorded Chromium/WebKit
[ADHD checks](adhd-board-2026-10-17.md), phone control/banner checks, and
[Android alert verification](android-notification-alerts-2026-10-17.md).
The latter includes three native emulator cases covering new defaults, existing
silent-channel preservation, and read-only status/settings behavior. These are
prior feature results, not new physical-phone acceptance. Other providers were
covered by source regressions; live Claude/Kimi/DeepSeek/Antigravity and two
physical-host collaboration were not rerun.

An initial source-gate invocation inherited system Node 26 rather than the
release's pinned Node 24 and was stopped. The complete rerun used the pinned
release environment without weakening tests. A custom external mountpoint was
rejected by macOS; the final DMG mounted read-only at the standard volume path
and passed all checks. Windows extraction initially ran before its installer
copy finished; it was rerun on the complete file. These build-preparation
failures were not product fixes.

[GitHub Source checks 39016886250](https://github.com/cloveric/tarobot/actions/runs/39016886250)
never started: GitHub reported failed account payments or a spending limit.
Local passing checks are not GitHub CI success.

## Local Mac update

Publication and installation are separate operations. The local updater waits
for active Bot work to finish, snapshots state, replaces the sealed App and
checks the resumed host's version, identity and history. Keep the activation
receipt separate from the isolated updater test; do not claim installation
complete while the helper is still waiting.
