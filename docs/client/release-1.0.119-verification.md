# TaroBot 1.0.119 release verification

Frozen source: [`022868b5baea02bafbb90e8b061e68b79fcf8e3a`](https://github.com/cloveric/tarobot/commit/022868b5baea02bafbb90e8b061e68b79fcf8e3a).
App 1.0.119; Host and standalone CLI 0.1.464; protocol 1;
Hub schema 22, supported upgrade input range 1–22. Android versionCode
2026102901; iOS build 1. All native Apps use `com.tarobot.client`.

## Publication

| Platform | Verified availability |
|---|---|
| macOS arm64 | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/macos-tarobot-v1.0.119), Developer ID signed, App and DMG notarized/stapled; signed updater archive |
| Windows x64 | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/windows-tarobot-v1.0.119), installer and signed updater manifest |
| Android | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/android-tarobot-v1.0.119), signed new-package APK |
| iOS | New TaroBot TestFlight record, 1.0.119 (1), VALID and IN_BETA_TESTING, original internal owner only |
| CLI | Identical `tarobot-0.1.464.tgz` attached to all three GitHub releases; no npm publication |

Published GitHub assets were downloaded and compared with verified local bytes.
Tags resolve to the frozen source. Chinese and English TestFlight notes and
internal group assignment were read back. No App Store or external beta review
submission was made. Old releases and TaroBot Legacy builds remain available.

## Validation

- Full required hook: 524 files, 7112 tests passed,
  5 skipped; Host/client builds, identity and secret-history
  checks passed. Native Rust targets passed 92 tests.
- Frozen-source browser checks: 75 unique browser scenarios verified: initial WebKit 46 passed and one timing-harness failure; all 8 side-window scenarios passed with a clock-controlled copy of the test against unchanged frozen application code; Chromium 28 passed. These are isolated
  browser fixtures, not native operating-system notification or device proof.
- Canonical CLI clean installation, extracted reinstall and previous published
  0.1.463 Host upgrade passed, including identity, permissions and history
  preservation. Bundled Host and standalone business/frontend bytes match.
- Ten real Codex/Claude paired-client round trips passed for text, files,
  voice, questions and stop/resume. The final signed Mac Node loaded the
  third-party native addon and received `DEEPSEEK_RECOVERED_OK` from an isolated
  real DeepSeek session. No new live Antigravity or Kimi run is claimed.
- Final Mac archive and DMG contain the same sealed App; Gatekeeper, updater
  signatures, embedded frontend, icons and bundled Node entitlements passed.
- Windows installer extraction verified embedded renderer, runtime imports,
  versions and icons. This is cross-compilation and package verification.
- Android native tests: 45;
  lint warnings: 15,
  no lint errors. Signing certificate, Firebase package and launcher were checked.
- iOS release-plan tests: 6; native
  keyboard checks: 24. Simulator and
  signed distribution outputs were verified separately, including share
  extension, profiles, entitlements and frontend parity.

The [post-audit review](../post-audit-updates-2026-10-29.md) records the
Opus 5.5 review. The [release-gate follow-up](release-1.0.119-followup-2026-10-29.md)
records the failed first candidate and subsequent LAN/test repairs. Failed
attempts remain archived; their results are not counted as passes.

## Remote CI

- [Secret scanning](https://github.com/cloveric/tarobot/actions/runs/40754349321): completed, success.
- [Source checks](https://github.com/cloveric/tarobot/actions/runs/40754349144): completed, success.

## Local Mac installation

The installed App reports 1.0.119, identifier `com.tarobot.client`,
with Host and terminal CLI 0.1.464. Its signed bytes match the published
package; the Host restarted, authenticated reconnection passed, and the prior
identity and retained Bot/conversation/message/device/attachment IDs were preserved.
Installed Node real DeepSeek response: passed.
Native CUA window, connection and version acceptance: passed.
The legacy Host directory remains in use; this installation did not replace
production APNs configuration (none was configured).

Native CUA observed the installed window, connected local workspace, existing
Bot/conversation list and message composer. General settings visibly displayed
`TaroBot 1.0.119`, and network settings showed the existing Host as connected.
The new native identity initially opened the welcome page. Selecting the local
Host entry reused the existing Host and restored the desktop connection; it did
not create a replacement Host or reset its data. The window was returned to the
owner's existing conversation. The already-passing installed runtime and model
checks were read back, not repeated. The activation receipt is now
`installed_verified`; the earlier pending-GUI receipt remains archived. The previous App was moved out of Applications only after
GUI acceptance; its rollback copy on the external disk passed a full file/link/
mode hash comparison and code-signature verification. Installation staging is
retired, and the pre-update state and CLI backups remain available.

## Transition and remaining device acceptance

The new App identity uses separate `macos-tarobot-v*`, `windows-tarobot-v*` and
`android-tarobot-v*` channels. Android/iOS are independent new installations and
need fresh pairing. A desktop serving its own Host retains the legacy Host
directory and identity; remote-only clients, notification permissions and
private-update authorization may need setup again. Old updater validation and
old assets remain intact. Self-hosted APNs must keep the legacy default topic
and explicitly allow the new topic with compatible credentials.

Physical iPhone/Android pairing, push and sharing; native Windows custom-path
upgrade/uninstall/reset; the old native updater ignoring the new channel during
a live update check; and all new-identity macOS TCC/automation grants have not
been fully verified. Windows has no Authenticode certificate. Simulator,
browser, extraction and TestFlight availability do not prove those results.
Daily Bot settings/model effort were not changed. Attachment-before-final-text
ordering is not described as a latency fix.

## SHA-256

| Artifact | SHA-256 |
|---|---|
| TaroBot-1.0.119-macos-arm64.dmg | `eaf3a2cb0c969ad0f2689ec3f5ab0a41762fa76ade3b5a727c6daeaa7036d1c5` |
| TaroBot.app.tar.gz | `b6d77070af3bfa4997f3cb60f5a2491d918435a0e7f2d3a0796d02c411d677b6` |
| TaroBot-1.0.119-windows-x64-setup.exe | `67dc626fbf9513d33b56662b5eeb3fe4bc6dd12913eae3c11025d54c184db821` |
| TaroBot-1.0.119-android.apk | `ef5412d04a8cecbdb343214aac05035781a30905cd771192abbc507e88f3a5de` |
| tarobot-0.1.464.tgz | `47302f500ff3bb830383fe0cd68df746cdee8d400f8a4a27395c779b179d036a` |
| iOS 1.0.119 (1) IPA | `b0a317b84ed1211c342615b63b54c112147fc8291c8d025e544f2536119baa4c` |
