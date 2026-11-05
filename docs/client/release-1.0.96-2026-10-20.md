# TaroBot 1.0.96 / host CLI 0.1.444

This release changes the reply's Diff entry to show saved edit receipts from that
reply. It lists the affected files and opens the recorded additions/deletions,
including when the Bot's default workspace is not a Git repository. A separate
Current workspace (live) entry retains the previous HEAD comparison. Desktop
review notes keep their message/run/operation origin and survive restart; mobile
remains read-only. Counts are cumulative recorded edit steps, not a net Git diff.
Missing or clipped evidence is labeled rather than reconstructed from current files.

Qwen3-ASR now decodes audio through a bounded ffmpeg PCM path, including
Opus-in-M4A voice notes unsupported by libsndfile. Validation, loopback-only
service access, concurrency guards and watchdog behavior are retained.

## Compatibility and CLI

App 1.0.96; host/CLI 0.1.444; Node 24.14.0; protocol 1; private-network membership
2; Hub schema 19, accepting schemas 1–19. Recorded changes use the additive
`runs.changes.v1` capability. Old hosts show an update prompt. Existing host identity,
pairings, conversations and Bot data are retained; no automatic historical backfill.

`tarobot changes list/show --message MESSAGE_ID` uses the same authenticated Hub
API as the App. Commands without `--message` retain live workspace semantics.
Matching CLI and desktop packages must use the same source revision. Android
versionCode is 2026102001; original package/signing identity and desktop updater
keys are retained. iOS source versions are synchronized, without TestFlight release.

## Verification and review

The [recorded Diff design and review](run-diff-2026-10-20.md) separates Codex tests
from three independent Claude Code Opus 5.5 reviews and documents all dispositions.
Feature validation passed 5,127 unit tests (5 conditional skips), focused real HTTP
and CLI authorization tests, and Chromium/WebKit Diff/draft interaction tests.
Release packaging, downloaded artifact and local installation checks are recorded
separately below; those source tests alone do not prove an installed App.

Known existing issue: expanding an ADHD pane and reordering with Alt+arrow can
occasionally change its history scroll position. The same failure was reproduced
on the pre-Diff baseline; this release does not claim to fix it.

Physical Windows/Android/iPhone acceptance is distinct from cross-compilation,
JVM tests and browser checks. macOS uses an ad-hoc sealed bundle and the existing
signed update channel, without Apple notarization. GitHub Actions have previously
been blocked by account billing; any local pass must not be described as cloud CI.
No npm publication, optional transport fleet restart or unrelated data migration.

## Release gate investigation

The first release-gate run exposed three test timeouts: an 8 MiB attachment
round-trip used object deep-equality on every Buffer index, and Python ASR tests
had a default 5-second outer timeout shorter than their existing 15-second child
process bound. Exact `Buffer.equals` verification replaced the expensive object
comparison; Python wrappers now allow 20 seconds while retaining the 15-second
child timeout. The 18 focused tests passed. A subsequent full run passed 5,125
tests but exposed the same object-comparison cost in two database backup checks.
Those two assertions now use exact byte equality without increasing their
5-second test limit; all 23 backup tests passed. These are test-harness changes;
product transfer, backup and ASR deadlines are unchanged. The failing runs remain
in the private release evidence and are not counted as passing gates.

Production dependency audit: the host has zero advisories. The client reports
three moderate dependency-chain entries for the same existing `sprintf-js`
precision-format advisory through `argparse`/`mammoth`, as documented in the
[previous independent audit](../independent-audit-2026-10-18.md). Document preview
does not invoke that CLI argument-parser path; this release does not claim a
zero-advisory client or adopt the suggested breaking downgrade.

## Final local gates

Executable source: `621bacecbcea846a2d63deeab3cee32c4637cffc`.

- Final `pre-complete-hook.sh`: passed, including Git identity/history-secret
  checks, standalone build, 5,127 tests with 5 conditional skips, clean-dependency
  client build, and 76 native desktop tests. The native TLS test transferred and
  verified 512 MiB and checked key rotation and WebSocket identity boundaries.
- Release-plan/privacy helper checks: 6 passed. No external package publication.
- CLI directory and extracted archive both installed with production dependencies
  only and passed package/startup checks. Upgrade from 0.1.443 to 0.1.444 retained
  host identity, controller credentials, network membership and workspace.
- Six real Codex checks passed through an isolated compiled Hub and supervised
  Gateway: paired-protocol text/sync, recorded Diff outside Git plus retained
  history after file overwrite, exact file round-trip, local ASR, question-card
  submit/resume, and streaming stop/resume with retained context. This is real
  engine/protocol acceptance, not physical App or multi-provider acceptance.
- Android: release build, 39 JVM tests and lint passed (0 errors, 19 warnings);
  original signer retained, versionCode 2026102001, 444 web assets matched, final
  launcher resources verified, and release is not debuggable. No physical phone
  was connected for this release.

The existing three Opus 5.5 reviews apply to the feature changes documented in
[the design record](run-diff-2026-10-20.md). The release test-harness maintenance
and package verification above were performed by Codex; no additional Opus
packaging review is claimed.

## Published artifact verification

All three published release tags resolve to the executable source commit above.
Every GitHub asset was downloaded and checked against the local artifact, GitHub
SHA-256 digest and release checksum list (13 assets across the three channels).
Both desktop update signatures, signed versions, pinned keys, release manifests
and exact numeric asset URLs were verified.

- Mac: final DMG integrity and strict bundle seal passed; embedded renderer
  matched. DMG and updater archive have the same 5,002 file/link entries, bytes,
  modes and targets. The local staged App also matches those 5,002 entries.
- Windows: the NSIS-extracted actual EXE's embedded HTML/JS/CSS and all six
  transparent icon frames passed. PE runtime/import checks passed. This is a
  cross-build with signed update artifacts, not Authenticode or physical Windows
  startup acceptance.
- Both desktop hosts match 836 canonical CLI files; all 18 integration assets
  match the source, including the ASR decoding fix, so packaged repair does not
  restore the older decoder.

Mac packaging used [Tauri's CI DMG mode](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)
after Finder appearance automation did not complete. This skips custom DMG icon
positioning; sealed App bytes and both distribution formats were fully verified.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.96-macos-arm64.dmg` | 131169468 | `4f40b0ed945f1981e27d92e3fc57d8282d291ca66dc93d93ca82eee37b9d54d1` |
| `TaroBot.app.tar.gz` | 131920780 | `204e42612cd097e69a94e1b40d5c869a7777fa83304aa431d64528600b685246` |
| `TaroBot-1.0.96-windows-x64-setup.exe` | 97836877 | `5b53287e10736e7579c6782277a0148cc4d4ba46d7b31b0f6c62b29c6607e115` |
| `TaroBot-1.0.96-android.apk` | 36532465 | `c9be59cf3494daff5e130def3c51aa0e585bdacf1c6edfec0504f68e51036d55` |
| `tarobot-0.1.444.tgz` | 26026471 | `c29aad2fabcd1416fa5fa3b670f5267650f7fd13bb3aa44025921c89902a35b7` |

Published channels: [macos](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.96), [windows](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.96), [android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.96).

GitHub Actions read-back: source and secret-scan jobs have zero executed steps
and were rejected by account billing/spending limits. They are not CI passes;
local secret scans, full source/client/native gates and package evidence above
are the release validation.

## Local Mac installation checkpoint

The previously installed 1.0.95 App is sealed and backed up on the external disk.
The downloaded-and-verified 1.0.96 App is staged on the application volume for
atomic replacement. The update helper is prepared to wait for all active work,
including the releasing conversation, before taking a private state snapshot,
replacing the App, restarting the host, and checking identity/history retention
and the authenticated `runs.changes.v1` capability. It does not force-cancel work.
At this documentation checkpoint, final post-restart installation receipt and
GUI interaction are not yet verified; publication and staging are not recorded
as completed installation.
