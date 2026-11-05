# TaroBot 1.0.70 / host and CLI 0.1.423

[Mac and Windows release](https://github.com/cloveric/tarobot/releases/tag/v0.1.423-test.1)
· [Standalone CLI](https://github.com/cloveric/tarobot/releases/tag/cli-v0.1.423)

App and standalone CLI executable sources are revision
`c71f277f685b3196b599df060c064c1c6915b7e2`, including the comprehensive audit fixes
in `05b7d3aa7220e5f88596e911bd5c293ee2d1412c`. Both desktop installers bundle host
**0.1.423** and client **1.0.70**. Wire protocol remains **1**;
`private-network.v2`, Hub schema read range **1–15**, and write schema **15**
remain unchanged. Follow the [host update guide](../host-cli-update.md).

## Included fixes

See the [full audit repair record](../comprehensive-audit-fixes-2026-10-15.md).
This release includes turn/session isolation, late and canceled approval handling,
queue and concurrent-run cleanup, structured Claude process/result handling,
streaming and client connection fixes, Windows downloaded-file safeguards,
headless host update recovery, Kimi startup serialization, and atomic Bot-file
writes. Optional legacy-adapter repairs remain separate from the standalone App
package; no Feishu SDK is shipped in the App or CLI.

Host behavior is shared by desktop and headless CLI; host identity, Bot ownership,
phone membership, network membership and default permissions are retained.
The production App, host and Bots were not stopped or replaced during packaging.

## Artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.70-macos-arm64.dmg` | 128,449,175 | `a2804965c6b02dbfab6a13db9739f5e5d8a50191c9f586768891375229a16885` |
| `TaroBot-1.0.70-windows-x64-setup.exe` | 95,197,426 | `95f347f03bfc30c5e68678bf38a62e47bc6347501c37a775dbee025050deec9b` |
| `tarobot-0.1.423.tgz` | 24,615,930 | `2edaf5c91e2dbb533f76d0d47e17c6eadc7601fa7400c9eeb5773aff406cb2f6` |

## Verification

- Final local source gate: **282 test files, 3,744 passed, one skipped**; optional
  legacy gate: **57 files, 1,228 passed**. Total **4,972 passed**.
- Clean client dependency install, translation check, TypeScript and production
  build passed. Standalone build contains 339 modules without legacy transport.
- Archive-extracted CLI installed its production dependencies in an independent
  directory and passed isolated Hub startup, helper-entrypoint and served-client
  checks. Its production dependency install reported zero known vulnerabilities.
- Actual previously published CLI 0.1.422 upgraded to 0.1.423 in disposable state.
  Host/controller identities, network identity, host name and workspace were
  retained; the upgraded host started. No OS service was installed. The verifier
  now uses macOS's short temporary path to keep staged control sockets within
  the OS path limit; this is a test-fixture correction, not a host-data migration.
- Final Mac DMG passed integrity verification, read-only mounting, deep strict
  ad-hoc signature verification, icon/version checks and all **4,895** App-file
  comparisons. Its mounted bundled Node passed argument/pipes, authenticated
  pairing, Bot creation, synthetic engine reply, restart and identity/name
  retention in disposable state. This is not live acceptance of all five CLIs.
- Final Windows NSIS installer extracted successfully. **4,892** bundled host
  files matched; 12 npm symlinks were materialized with identical bytes. The
  executable differed from the compiler output only by Tauri's documented
  `__TAURI_BUNDLE_TYPE_VAR_UNK` → `NSS` installer marker. Desktop, Node, launcher
  and native addons were verified as Windows x64 PE files.
- Both desktop host bundles match **758** runtime/client/helper files from the
  independent CLI archive. All six published assets across the App and CLI
  releases were downloaded again and their SHA-256 digests matched exactly.
  This repository is private: release downloads require an authorized GitHub
  account; an unauthenticated 404 does not mean an asset is missing.

## Platform and delivery limits

**Android is not updated by this release.** The latest published Android APK is
still **1.0.67**. Source version 1.0.70 / versionCode 2026101501 is prepared, but
reading the original signing key and Android toolchain on the external volume
still times out pending macOS disk authorization. No replacement key, uninstall
or data reset is used. iOS is not packaged in this release.

Background notifications remain unverified: production FCM sender configuration,
Android configuration availability and a real phone delivery receipt are still
outstanding. This release does not claim to fix background notification delivery.

Mac is Apple Silicon only and uses an ad-hoc seal, **not Developer ID or Apple
notarization**. Windows x64 is unsigned and cross-compiled; native Windows
installation/run acceptance remains pending. Installed-Mac update/Keychain and
real Android/iOS/VPS operation were not revalidated. Prior Chromium checks are
recorded in the audit report; WebKit remained blocked before product interaction.

GitHub source/legacy checks on the release source commit did not start because of
account billing/spending limits (run `38705759273`). Local verification does not
mean GitHub CI passed. Docker image validation and remaining hardware checks in
the audit report remain open.
