# TaroBot 1.0.88 / host CLI 0.1.436

This release packages the fixes since 1.0.87, including the independent
Opus 5.5 / xhigh background-task and attachment-reader review.

## Changes

- Background reports use compact expandable summaries. Full reports, files,
  source and task state remain available in ordinary chat, phone and ADHD panes.
  Running, unknown, failed, stopped and unconfirmed delivery are distinguished.
- ADHD restores the resizable sidebar and workspace controls; pane headers and
  composer actions align consistently. Read receipts, scroll containment and
  typing during streamed replies are corrected; redundant copy is removed.
- Attachment readers stay open when their message scrolls out of the virtual
  list. Loaded originals survive a brief disconnect, failed downloads recover,
  and disabled readers release their resources. Native transfers resume after
  interruptions instead of remaining stuck.
- Dollar amounts no longer turn adjacent prose into mathematical typography.
  Archived conversations can be opened and restored. New installations default
  to Porcelain violet; existing appearance preferences remain unchanged.
- Phone notifications show the conversation and meaningful reply context.
  Phone spacing and process search controls are more compact.
- Run files respect personal message deletion and conservative ownership for
  overlapping/background runs. Claude background-review admission is displayed
  as waiting; stop confirmation explains shared-process impact and expires when
  the original context changes.

Shared Core/Hub fixes also ship in CLI 0.1.436. Presentation changes need no new
CLI commands. Agent Bus routing and cross-host message commands are unchanged.
No new schema migration, permission grant or queue policy is introduced.

## Compatibility and verification

App **1.0.88**, host/CLI **0.1.436**, Node **24.14.0**, protocol **1**,
membership **2**, Hub schema **17** (accepted **1–17**). Android version code
**2026101706** retains the application ID and original signing certificate.
Mac distribution is ad-hoc sealed, without Apple notarization; Windows uses
the existing updater key, without Authenticode signing.

The release source gate passed again: **325 files, 4,300 tests passed**, one
Windows-only Codex shim test skipped on macOS. The standalone dependency graph
contains 359 modules without optional transport SDKs. Client clean installation,
translation checks, TypeScript and Vite passed. The
[joint audit](background-reader-audit-2026-10-17.md) additionally records 1,230
passing optional-adapter tests, 85 Chromium and 85 WebKit cases, and 21 additional
lifecycle cases per browser. Those browser checks were performed during the
feature audit; they are not physical-phone or native-Windows acceptance.

| Surface | Verified result | Boundary |
| --- | --- | --- |
| Mac native regression | 64 tests passed | Native lifecycle and policy tests |
| Android APK | Original signer retained; 32 unit tests; lint 0 errors / 24 warnings; all 410 frontend files match | No physical-phone execution |
| Final Mac DMG | Read-only mount, deep/strict seal, version, icons and embedded renderer passed; 772 bundled host/CLI files match | Apple Silicon, ad-hoc seal |
| Final Windows installer | NSIS extraction, embedded renderer and native dependencies passed; 772 host/CLI files match | Cross-built x64, no native Windows execution |
| Both desktop update channels | Executables contain the configured private repository, client ID and existing pinned key; signatures bind version 1.0.88 | Separate from GitHub OAuth UI acceptance |
| Native Mac updater | Tampered archive rejected; signed archive installed; Hub resumed with identity, pairing, history and file retained | Disposable external App and synthetic host state |
| Standalone CLI | Clean production install, pack/extract, second clean install, startup and served client assets passed | No optional platform SDK or registry publication |
| CLI upgrade | 0.1.435 to 0.1.436; identity, controller, network, workspace and new-host startup retained | Disposable external host; no OS service installation |
| Real Codex | Two-client text sync, original-file return, local ASR, question submit/resume and streamed stop/resume passed | Client protocol through Hub and supervised Gateway to real engine |

Claude/Kimi/DeepSeek/Antigravity live acceptance and physical two-host collaboration
were not repeated in this packaging pass. Their source regressions are distinct
from real-device verification. No tests were weakened for the release.

- [Mac Apple Silicon / CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.88).
- [Windows x64 / CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.88).
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.88).
- [Executable source a7f50f3](https://github.com/cloveric/tarobot/commit/a7f50f39c84b886b7364fa72b4c9017fdbfd7303).
- [Artifact hashes and publication receipts](evidence/release-1.0.88-2026-10-17.json).

All three releases were published and downloaded again. Each downloaded file
matches both GitHub's asset digest and the verified local source bytes. Both
desktop manifests, pinned signatures and signed versions match; the Mac channel
includes the archive, signature, manifest, bootstrap DMG and matching CLI.

Claude still uses a shared session process. The stop confirmation does not add
independent background-process cancellation or server-side run-ID atomic stop.
Old files without reliable run ownership stay accessible in their original
messages and File Center rather than being guessed into a background report.

[GitHub Source checks 39033555895](https://github.com/cloveric/tarobot/actions/runs/39033555895)
did not start either job (zero executed steps), because GitHub reported failed
account payments or a spending limit. Local verification is recorded separately
and is not GitHub CI success.
No external package-registry publication or optional adapter-fleet restart is
part of this release.

## Local Mac update

Installation is separate from publishing the update. The previous sealed App is
backed up on the external disk and the verified 1.0.88 App is staged for atomic
replacement. The detached local activation helper waits for the current Bot turn
and other active work, snapshots state, replaces the App, resumes the same host,
checks version/identity/history and its authenticated local connection, then
opens the new GUI and checks its process and window. It does not force-stop
work or treat a waiting helper as a completed installation.

At publication local activation was staged/waiting. The detached helper completed
at **2026-10-17 12:57:01 UTC**: installed App 1.0.88 / host 0.1.436, preserved
identity and history, authenticated the resumed host, and verified the new GUI
process and window. A subsequent read of the installed bundle confirms 1.0.88.
The private external-disk `activation.json` is the installation receipt.
GitHub OAuth through the production settings UI and interaction with the newly
installed GUI remain separate verification boundaries.
