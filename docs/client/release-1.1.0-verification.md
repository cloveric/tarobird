# TaroBird 1.1.0 release verification

Published on 2026-11-04 from `f4e5b9e8e3b0803eb08eb0182a3e56e25d2fbc9f`. App, bundled Host and
standalone CLI are all **1.1.0**. Host protocol is 1; supported Hub schema is
1–25. Android version code is 2026110402; iOS build is 1.

## Published artifacts

- [macOS and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-tarobot-v1.1.0): Developer ID signed, Apple notarization
  accepted, stapled, with a signed update manifest.
- [Windows installation preview](https://github.com/cloveric/tarobot/releases/tag/windows-preview-v1.1.0): manual installation
  prerelease. Update signature verified; no automatic-update manifest and no
  Authenticode signature. Native installation, migration and uninstall are not
  claimed as accepted.
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-tarobot-v1.1.0): signed APK, same signer as the previous
  release, APK v2 signature and zip alignment verified.
- iOS 1.1.0 (1): Apple processing `VALID`, existing internal TestFlight group
  assigned, `IN_BETA_TESTING`, Chinese and English test notes read back. Existing
  group settings, App Test Information and public store metadata were preserved.
  No external beta review or App Store submission was made.

All 13 GitHub asset downloads matched the verified local files and API digests.
Both downloaded desktop update signatures and all three release tag targets
were verified. The same CLI archive is included in each GitHub release. There
was no npm registry publication or repository migration.

| Platform | Artifact | SHA-256 |
| --- | --- | --- |
| macOS | `TaroBot.app.tar.gz` | `584b037c6be4febc36f2119f2694517e999b3fbd34a0f9abd15d44fa0ee04ab6` |
| macOS | `TaroBot_1.1.0_aarch64.dmg` | `85f8ce9fafa95929fadbdc2a27f61985c59533ae4d0c96d397456379f6edce4e` |
| Standalone CLI | `tarobot-1.1.0.tgz` | `2b3189d2fd7a06dc324e0ec64154e2bebef0913b1c822a20d0e311dfde7f1f15` |
| Windows preview | `TaroBot-1.1.0-windows-x64-setup.exe` | `1b43e8cfbceeee16c617536a175710198114b825177dd496f17d37b757f25d79` |
| Android | `TaroBot-1.1.0-android.apk` | `6a8e37ae291271ef36a249276916f177ff826f867a0ee49ae042be63ac2ba80a` |
| iOS TestFlight | 1.1.0 (1) IPA | `e9d169ec1c8f9629dd606dc080e0df70ab4edcb74993140b3ec8533327486a8a` |

## Dependency and compatibility checks

All 31 available foundation dependency updates were applied, including the ACP
SDK, certificate library and scheduler major updates. The matching Capacitor
CLI and native dependency pins were updated too. See the
[dependency inventory](release-1.1.0-dependency-inventory.md) for versions,
upstream editor/skill checks and focused compatibility regressions.

Standalone CLI requires **Node 22.12 or newer**; official Node 24 is recommended.
Desktop packages include Node 24. The real old CLI staging parser accepted the
new manifest. Clean installation and an existing 0.1.475 Host upgrade retained
identity, network membership, conversations, attachments, workspace data and
idempotency. Existing identifiers, stored paths, updater channels, bundle and
artifact filenames remain compatibility contracts; the product display name is
TaroBird. The `tarobird` command and retained `tarobot` alias use the same Host.

## Test evidence and source boundaries

- 8,243 source tests passed; 6 existing skips. Also 18 release/privacy/version
  tests and 104 legacy native tests passed at `ae96cb9493a8ccf75f83a04a4893a0546267971a`.
- Final source passed **371 Electron checks** and **7 iOS release-plan checks**.
  Its only changes after that full source run normalize the copied macOS addon
  install name before signing, add a compiled-library regression, and document
  the result. Product runtime, native source and dependency pins are unchanged.
- The unchanged runtime had 127 Chromium/WebKit/browser dependency scenarios,
  core/addon/updater tests (63/33/71 passed), 15 updater-lab checks, and native
  canvas, PPT, browser and screen checks at
  `527765c2b31062de37b1a66da21626db56450f4a`. These retain their actual execution
  provenance; they are not represented as new physical-device runs.
- Every shipping package was rebuilt from the final source. Android's final
  build passed 45 unit tests and lint with no errors (15 warnings). iOS device
  and simulator frontend resources and launcher assets matched.
- Final standalone package passed ten real Codex/Claude flows: text/sync,
  file round-trip, ASR, native question and stream/stop/resume for each engine.
  The final signed macOS bundled Host also passed a real DeepSeek response.
- Fresh lockfile installation and production dependency audits passed with
  zero reported production vulnerabilities. Packaged and installed skill
  resources matched final source. Kimi real-model testing and Motion were
  excluded as requested.

GitHub Actions did **not run** because of billing/spending-limit restrictions:
[Source checks](https://github.com/cloveric/tarobot/actions/runs/41840467936),
[secret scanning](https://github.com/cloveric/tarobot/actions/runs/41840467960).
The three jobs had zero steps and billing annotations. This is not a CI pass.

## Release privacy and retention

Rejected candidates were never published. The pre-upload checks caught and
fixed tar owner metadata, optional iOS symbol files containing archive paths,
and the macOS addon's absolute Mach-O install name. Final tar entries use
root/wheel with UID/GID zero; addon normalization runs before signing. iOS
keeps local archive dSYMs without placing optional path-bearing symbols in the
IPA.

Final signed/unpacked artifacts passed owner-path and identifier scans including
UTF-16 strings and recursive archive metadata. Gitleaks 8.30.1 alerts were
reviewed against exact upstream public Firebase identifiers and JavaScript
syntax fingerprints; no unresolved findings remained and no broad source
allowlist was added. Publication text, outgoing commits, commit identities and
full-history secret checks passed the upload gates. This does not certify or
remediate historical repository privacy residue.

The signed final macOS backup was retained and verified. The default historical
cleanup scan reached its discovery bound and was preserved as deferred; a
narrowed scan of the three candidate workspaces and their build caches then
completed safely. Recent artifacts were retained; no installed App was a
cleanup target.

Physical phone acceptance and native Windows installation acceptance remain
separate. Source tests, browser fixtures, signed-package checks and model probes
do not substitute for those device checks.
