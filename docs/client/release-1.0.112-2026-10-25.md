# TaroBot 1.0.112 release verification — 2026-10-25

Source: `9b37b50c36d3518dc6f0871dcdfe6b187e1ddd97`. App 1.0.112 / Host and standalone CLI 0.1.457; protocol 1, Hub schema 21 (upgrade range 1–21).

## Published artifacts

| Platform | Result | SHA-256 |
| --- | --- | --- |
| [macOS arm64](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.112) | Developer ID signed, App and DMG notarized/stapled, Gatekeeper accepted; published and downloaded again | `9577d59115e46237ff4a93b2fb55cfb55a16999c7b7121c97d24246a7022085c` (DMG) |
| [Windows x64](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.112) | NSIS package, embedded frontend, runtime imports, icons and updater signature verified; published/downloaded | `3b47689e37e3a3707966548eaedd3afec81bbd6f33284928b709ce3d7674c9d3` |
| [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.112) | versionCode 2026102501; release lint/build and 39 unit tests; continuous signer, icons and downloaded bytes verified | `7a060fe377d8dadc22a400cd03d153223ceb0b1a5fd7cbb02c92517244a810cc` |
| iOS TestFlight | 1.0.112 (1), VALID / IN_BETA_TESTING; internal group assigned; Chinese and English notes read back | `7565a489e628c61ed8e2e5a06c6e332b94ce4f8346414f11e10caf41185bae55` (IPA) |
| Standalone CLI | 0.1.457, one canonical archive shared by all release pipelines | `f405d9d3c704f18d97e84316b05e55afd35ded448eeed6284f67affcce6380b1` |

The Mac updater archive, signature and feed are published together. Mac, Windows and Android downloads, GitHub asset digests and release tag → source checks match the local verified artifacts. iOS was not submitted for App Store or external beta review. App Store public metadata and existing TestFlight review/test information were preserved.

## Changes and CLI impact

This release includes the interactive widget/report work, mobile interaction and state restoration, Porcelain UI polish, avatar additions and selection-modal fix, compact send/task controls, image touch-highlight fix, and the [performance/stability audit](performance-stability-audit-2026-10-25.md).

Host/CLI changed because widget capability guidance and validation live in the shared Host. UI-only layout, avatar and touch changes do not require new CLI commands. Android, iPhone and desktop retain their separate visual sizing boundaries. Both desktop and phone packages embed the intended frontend bytes; native widget guards and keyboard-inset code are present.

Fresh root dependency installation exposed compatible security updates. Zod 4.6.7, Undici 6.29.1 and Vitest 4.1.12 replaced the vulnerable versions; root and client npm audit reported zero known findings. The unbuilt `e85aa956` candidate was superseded before packaging; every published artifact uses the source above.

## Verification

- 492 test files: 6,700 tests passed, 5 conditional skips. Host build, history-secret scan, Git identity and client translation/type/build checks passed.
- The initial full hook reached native testing, then failed because the fresh checkout lacked generated `host` resources. `desktop:prepare` generated those resources; the unchanged complete native test command then passed all 77 tests. No assertions were removed or weakened.
- Canonical CLI clean install, archive extraction/install and upgrade from published 0.1.456 passed, preserving test Host identity, controller, network and workspace.
- Ten real Codex/Claude checks passed: text/two-client synchronization, exact file round trip, local ASR, question submit/resume and stop/context recovery.
- Final signed Mac Node loaded a separately installed native addon and returned `DEEPSEEK_RECOVERED_OK` from the real model.
- iOS release-plan 6/6 and keyboard-native 24 checks, Simulator build, distribution archive/export, App/share-extension profiles and metadata, IPA signing and asset parity passed.
- Independent Opus 5.5 xhigh prepared/reviewed the platform and Mac wrappers. Publication and local activation remain separate gates.

GitHub Actions did not start any source/secret-scanning steps because of the account billing/spending gate. Local full checks are the evidence above; cloud CI is not claimed green.

## Local Mac acceptance

Local installation and acceptance are complete: App 1.0.112, Host 0.1.457 and terminal CLI 0.1.457. The installed App executable and bundled Node match the signed published package. The guarded updater replaced the old Host process, and the new Host is running without a pending drain; its production temporary directory is unchanged.

All seven managed Bots and the relay are online. Authenticated reconnection and required Host capabilities passed. Host identity and every pre-update Bot, conversation, message, device and attachment ID were retained; the previous App and state backup remain available.

The installed signed Node loaded the external DeepSeek native addon and obtained the exact real-model reply `DEEPSEEK_INSTALLED_OK` in an isolated test session. Opening `/Applications/TaroBot.app` through LaunchServices produced a visible native TaroBot window; its accessibility tree and screenshot showed the connected `macmini`, conversation history, current streamed response and composer. This verifies window rendering and connection, not a new full interaction regression.

Separate immutable receipts record installed runtime read-back, the real model response and visible GUI acceptance; `local-mac-acceptance.json` combines their verified results and hashes. The original activation receipt remains unchanged: its GUI-launch request alone did not establish these later checks.

The old CC1 Gateway had two active counters despite no pending deliveries or model children, and native task reads timed out. After the owner explicitly authorized restarting only CC1, SIGTERM to that verified Gateway let the Hub relaunch it. Counters returned to zero and task reads recovered. No other Bot or Host was targeted. The underlying cause of those old in-memory counters is not established by a restart.

A release-helper-only preflight refinement avoids repeating a failed task RPC for all of a Bot's historical conversations. Every skipped read is recorded as unknown and still blocks activation; healthy Bots are checked and the next inspection retries anew. Product source and published artifacts were not changed by this operational refinement.

## Limits

No real Windows installation/startup or Authenticode signing. No release-specific Android/iPhone physical-device upgrade, APNs or FCM end-to-end acceptance. TestFlight tester account status is not proof this build was installed. Prior feature browser/device evidence remains in its own reports; release package checks do not replace it.
