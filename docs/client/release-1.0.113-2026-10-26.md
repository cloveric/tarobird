# TaroBot 1.0.113 release verification — 2026-10-26

Source: `55e96bc6acc93cc33520bad81491e7673a154bc8`. App 1.0.113 / Host and standalone CLI 0.1.458; protocol 1, Hub schema 22 (upgrade range 1–22).

## Published artifacts

| Platform | Result | SHA-256 |
| --- | --- | --- |
| [macOS arm64](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.113) | Developer ID signed; App and DMG notarized/stapled; Gatekeeper accepted; downloaded again | `071fabcd6826004fbcd887efacf11b950e126d712a504f1677b580975e00cad1` (DMG) |
| [Windows x64](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.113) | NSIS extraction, runtime imports, embedded frontend, icons and updater signature verified; downloaded again | `8bcbac25d5d6ecc4d9ffc5b5084b303e7b1c2038c870938ff71015872741e462` |
| [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.113) | versionCode 2026102601; release lint/build and 39 unit tests; continuous signer, packaged icons and downloaded bytes verified | `7d6ea7782e8b8ab90ffe4026f66349b9834b6a839c3441a14980fbcd679b32b0` |
| iOS TestFlight | 1.0.113 (1), VALID / IN_BETA_TESTING; internal group assigned; Chinese and English notes read back | `3d72078cb50e9061108c7dd951ade0fb0d040563150aca55deff2c400fe937ca` (IPA) |
| Standalone CLI | 0.1.458, one canonical archive shared by the platform pipelines | `7b47422da582c0c195916bfb49492a024c5dd85966630bb87cffc0e862ed596e` |

All release tags resolve to the source above. Mac, Windows and Android read-back bytes and asset digests match their verified packages. The Mac updater archive, signature and feed were published and verified together. iOS was not submitted for App Store or external beta review; public metadata and existing review/test information were preserved. A tester's account status is not proof that this build has been installed.

## Changes and independent review

This release includes the fox App icons and rounded cat-head Mac tray, full-library persistent default avatars, promotional/wordmark updates, the merged UI improvements, search highlighting, neutral-grey monochrome self bubbles, removal of the desktop chat fade, and suppression of native mobile tap overlays across App controls. The App's default theme and the separate iPhone, Android and desktop sizing policies remain unchanged.

The shared Host adds bounded message-update replay history, schema-22 synchronization recovery, and native ordinary-input admission while Claude handles background results. The standalone CLI ships the same Host implementation. Presentation-only changes need no separate CLI command; history policy and offline compaction retain their documented CLI entry points.

Root and actual Opus 5.5 xhigh independently reviewed the changes since 1.0.112. The [audit report](../release-audit-2026-10-26.md) records findings, rejected hypotheses and regression boundaries. Confirmed corrections include:

- A history-maintenance failure could prevent the day's backup/cleanup. Best-effort history cleanup now fails independently, preserving backup settings and retry behavior.
- Claude cancellation could leave a stop fence waiting on an input that was already terminal. Ownership remains tracked while only nonterminal inputs enter the wait set.
- Cancelling a not-yet-consumed native review input could kill the worker handling the preceding background review. Negotiated withdrawal preserves that work.
- Gateway receipt waiting could outlast the Hub request deadline. Its bounded wait now leaves deadline headroom and preserves uncertain-result and idempotency behavior.

WebKit collection now includes the brand and Claude review-input suites. The browser fixture waits for the new review target before sending a second input, preserving coverage of the actual ownership boundary rather than racing the old foreground target.

## Verification

- Final complete source suite: 500 files, **6,783 passed and 5 conditional skips**, no failures. Host/client builds, translation/type checks, history-secret scan and Git identity checks passed. Fresh dependency installs reported no known vulnerabilities.
- Complete native command: **77 passed**. The initial fresh-checkout attempt lacked generated Host resources; `desktop:prepare` supplied them before the successful run.
- An intermediate full suite collided with a concurrent generated `dist` rebuild and failed one CLI ASR test. The focused recheck and then the entire suite passed after the build became stable. No assertion was removed.
- Canonical CLI clean install, archive extraction/install and upgrade from the actual published 0.1.457 package passed. Schema 21→22 preserved identity, canonical message/attachment/read/hidden/idempotency state; replay retirement forced the expected snapshot recovery, and old Host code refused schema 22 without changing it.
- **Ten real Codex/Claude checks passed:** text and two-device sync, byte-exact file return, local ASR, question submit/resume, and stop/context recovery. The first attempt timed out waiting for a Codex long response after its first four checks; the unmodified script and same package passed all ten on retry. Both attempts remain in the local evidence.
- Final signed Mac Node loaded an independently installed native addon and obtained the exact real-model response `DEEPSEEK_RECOVERED_OK`.
- Browser regression included 76 Chromium and 77 WebKit passes plus one unsupported forced-colors skip; separate wordmark checks passed in both browsers. The corrected review-input fixture passed 6 repeated WebKit and 2 Chromium cases.
- Android release lint had 15 warnings and no errors. iOS release-plan 6 and keyboard-native 24 checks, Simulator build, distribution archive/export, App/share-extension signing, IPA metadata and packaged 2×/3× launch assets passed.

GitHub source and secret-scanning jobs did not start any steps because of the account billing/spending gate. Local checks above are the evidence; cloud CI is not claimed green.

## Storage migration and local activation

The existing schema-21 backup was rehearsed on a disposable copy containing 242,904 update events. Copying took about 109 seconds and checking the copy about 89 seconds; opening/migrating took about 21 milliseconds. Canonical counts remained unchanged. Thirty bounded history-maintenance passes advanced backfill but did not finish it, so this rehearsal does **not** claim complete large-database retention or physical shrink verification. The temporary copy was removed.

Automatic backup preferences are unchanged. The running-Host upgrade does not execute `hub compact`; an existing database with `auto_vacuum=0` retains that storage mode. Reclaimed event pages can be reused internally, but this release does not promise an immediate reduction of the existing database file's size. Offline physical compaction is a separate explicit operation.

Local installation and post-install acceptance are complete: App **1.0.113**, Host **0.1.458** and terminal CLI **0.1.458**. The installed App executable and bundled Node match the signed published package. The guarded handoff completed on its first drain attempt without forced termination. The new Host is running without a pending drain, all seven managed Bots and the relay are online, authenticated reconnection and required capabilities passed, and the production temporary directory is unchanged.

Host identity and every pre-update Bot, conversation, message, device and attachment ID were retained: 5,542 pre-update messages and 1,571 attachments have no missing IDs. The schema-21 recovery copy passed `quick_check` before replacement; the live database is schema 22. The user's stored automatic-backup retention remains **0** (off), its policy digest is unchanged, and `auto_vacuum` remains 0. No `hub compact`, forced Bot restart or automatic database restore was executed. The previous App and schema-21 recovery copy remain available; an App-only downgrade cannot open schema 22.

The installed signed Node loaded the external DeepSeek native addon and obtained the exact real-model response `DEEPSEEK_INSTALLED_OK` in an isolated test session. The normally launched native App was raised and inspected through CUA: its visible window and accessibility tree showed the connected `macmini`, conversation history, the current streamed reply and the composer. This verifies window rendering and connection, not a fresh full interaction regression.

Separate immutable runtime, real-model and visible-GUI receipts are combined with their hashes in `local-mac-acceptance.json`. The original activation receipt remains unchanged: its initial GUI-launch request was followed by these actual acceptance checks. Native-window evidence is private and was not added to the public repository.

## Limits

No native Windows installation/startup or Authenticode signing. No release-specific Android/iPhone physical-device upgrade or APNs/FCM end-to-end acceptance. Browser, Simulator and package checks do not replace those tests.
