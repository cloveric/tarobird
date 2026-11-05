# TaroBot 1.0.123 publication and local Mac acceptance

Publication checked 2026-10-31T10:46:23.097306+00:00.

All artifacts bind to `8ca8f06ade38e9e8e6d524b8f812247a520c56c6`: App **1.0.123**, Host/standalone CLI **0.1.468**, protocol **1**, Hub schemas **1–22**. Later documentation commits do not change those bytes. **Local Mac installation, installed runtime/model and native GUI acceptance passed** on 2026-10-31T10:51:42.012976+00:00. Publication and installation evidence remain separate.

## Changes and preflight

This release includes the [post-1.0.122 audit fixes](post-1.0.122-audit-2026-10-31.md), workbench Design, explicit selection of up to four split tabs, browser page tools/preferences, the independent ADHD browser side panel, panel geometry and menu repairs, and remote-screen registration/permission entry repairs. It does not automatically grant device viewing/control rights or claim real remote-input acceptance.

[Preflight and regression details](release-1.0.123-preflight-2026-10-31.md) and [dependency inventory](release-1.0.123-dependency-inventory.md) distinguish full-suite baselines from subsequent affected regressions:

- Fresh root/client dependency installs and builds/translations passed. Baseline: **7,602 Vitest passed, 6 skipped (565 files)**; **284 Electron unit checks**; artifact-path checks **6**; privacy guards **5** and reachable-history scan passed.
- After the upstream changes: **107 affected unit checks**, Design browser checks **8 Chromium + 8 WebKit**, actual isolated Electron Design checks **15**, font WebKit checks **2**. These are separate suites, not cumulative unique coverage claims.
- A real pointer-focus bug was reproduced: cancelling a paused entry animation moved a clicked form control before pointerup. Radio/checkbox/text regressions went from **3 red** to passing. Final motion checks **6 Chromium + 6 WebKit**, plus **7 Chromium typography/mobile-navigation checks**, passed with animations enabled.
- Native legacy exporter **104**, core **62 passed / 2 ignored**, addon **33**, updater **71**. The core suite was serialized after shared Keychain fixture contention; no busy-path assertions or product gate were removed.
- CLI clean/extracted installation and an existing 0.1.467 Host upgrade passed with retained identity/history/idempotency. Its embedded client matches all **992** final Mac renderer files. The canonical CLI package is attached to the Mac and Android GitHub releases; no npm registry publication.

Integrated upstreams: Excalidraw **0.18.1** and Vditor **4.0.1** remain current stable; baoyu-design upgraded to **2.4.1** at `5a1a6f2ca2606108fc08050a78c4731adc6a2351`; full Sarasa Term SC fonts upgraded to **1.0.43**. JetBrains Mono files match the recorded upstream HEAD, which is newer than the latest stable tag; they were not downgraded. Direct manifest lookup covered 68 entries; ordinary dependency differences are explicitly retained in the inventory.

Design's original project materials are MIT-licensed; its LICENSE/NOTICE explicitly excludes the reconstructed Anthropic editors, Artifact reference materials and Anthropicons and grants no license for those parts. The owner requested retaining Design and proceeding after this explanation. Full notices ship with the App; that decision does not establish additional rights.

## Mac and CLI publication

[Mac 1.0.123 release](https://github.com/cloveric/tarobot/releases/tag/macos-tarobot-v1.0.123). All six uploaded assets were downloaded again; file sizes/SHA-256, tag/source and update signature matched.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| TaroBot.app.tar.gz | 299118216 | `f2004a42093fda76122d9da1ad5d1b2cf2c77a5a4a90bdd17cfd1d4f2658db92` |
| TaroBot.app.tar.gz.sig | 428 | `b0a0260b79247bdc4ad366c0b5dfc3fadead9e41b77da3e2f98bc61ed27f570a` |
| TaroBot_1.0.123_aarch64.dmg | 349953404 | `dba4b403d661ad8153b09b4131e245d083b4209e581947c18b10104b26d7d534` |
| tarobot-0.1.468.tgz | 50466305 | `1e932e4e4888e0f241a964df84277178b0e8f6b1f5136cea97055c49458549e0` |
| macos-tarobot-latest.json | 3878 | `439bf8d3ad77c800a1b158e79b96e886d987633127590b773dd3721d5358f35e` |
| SHA256SUMS | 446 | `72ef9b2f248bc0e983fb42e54dad99e5030f25a3a162957155cd681ce7fa41a3` |

The final production renderer matches the freeze. All 30 nested executable signatures, hardened-runtime/role entitlements, Apple accepted notarization, staple/Gatekeeper checks, DMG icons and old/new updater readers passed. Bundled signed Node loads the external addon. Unauthorized production debugging/core/updater/exporter launches were refused.

The installed baseline is already Electron 1.0.122. Its designated signing requirement matches 1.0.123; this is signing continuity, not a repeated first-migration Keychain read/delete probe. Actual installed authentication, model response, Host reconnect and native GUI subsequently passed as recorded below.

## Other platforms

- [Android 1.0.123](https://github.com/cloveric/tarobot/releases/tag/android-tarobot-v1.0.123) is published, and all three assets were downloaded/hash checked. APK: 60799046 bytes, SHA-256 `76d811904d356435094db54e8864b3ab5a0fca57c32faed8e28aa146632db604`. Package/version, existing signer, non-debuggable release, Firebase, icons and final frontend bytes match. Native unit checks **45**, lint **0 errors / 15 warnings**. Physical phone installation is unverified.
- iOS **1.0.123 (1)**: signed App/share extension and profiles, simulator build, final icons and bundled frontend verified. Upload processed **VALID**, assigned to the existing internal group, and read back **IN_BETA_TESTING**. Chinese/English What to Test matched. Existing Test Information, review details, group settings and public store metadata are preserved. No external beta/App Store review submission or physical iPhone acceptance.
- Windows installer built and extracted: renderer/source, icons and **23 native binaries** checked; SHA-256 `2f8d1a55d294b56f2438fbf551cd48c0b6ed580596a4de2e13c61618c994a79b`. Full native install/upgrade/update/uninstall and migration acceptance remain owner-deferred; **Windows 1.0.123 is not published**.

## Installed Mac acceptance

The actual installed App is **1.0.123**, bundled Host and terminal CLI **0.1.468**, from the exact published source above. The previous version was Electron **1.0.122 / 0.1.467**. The update waited for active work, backed up the quiescent Host/client state, quit the GUI gracefully, replaced the App atomically and restarted the Host. The signed old App and state backups remain in physical `.noindex` storage; no data reset, forced GUI termination or re-pairing was used.

Host PID changed from **44349** to **71766**; native GUI PID is **71780**. Installed tree/binary/Node match the published artifact. Original identity, authenticated Host reconnect, relay and managed Bots passed runtime read-back. Terminal CLI wrapper remained unchanged.

| Retained table | Before | After | Missing IDs |
| --- | ---: | ---: | ---: |
| bots | 9 | 9 | 0 |
| conversations | 191 | 191 | 0 |
| messages | 8738 | 8738 | 0 |
| devices | 14 | 14 | 0 |
| attachments | 2457 | 2457 | 0 |

The installed Node loaded the external DeepSeek addon and produced the real isolated response `DEEPSEEK_INSTALLED_OK`. That passed check and runtime verification were read back after continuation, not repeated. No production conversation was used for the model probe.

CUA checked the actual native window and rendered settings page showing **TaroBot 1.0.123**. Existing conversations remained visible, and the original Host showed **connected / local direct**. Screen service is **registered**; the GUI device remains **not authorized** for viewing, with a visible disabled button and actionable explanation. The existing screen-recording/accessibility/input-monitoring permissions read back as granted; none were changed or exercised for production capture/input.

Installed workbench checks: opening/closing the panel worked; the new-content menu exposed Design, whiteboard, note and browser entries. A blank Design loaded its real toolbar, artboard and default text. Closing its tab retained it under recently closed content, alongside existing note/whiteboard/browser entries. Existing user content was not edited or deleted. The blank acceptance Design remains retained. The workbench was restored closed; CUA screenshot width was **1200 → 1600 → 1200**, verifying this open/close case, not every monitor/resize combination.

The detailed local GUI receipt is `installed-gui-verification.json`, bound to the frozen source and SHA-256 of the already-passed runtime/model receipts. Pre-package editor edit/save/quit regressions remain separate evidence; installed loading checks are not a substitute for those suites.

**Post-release defect, 2026-10-31:** a real DD1 request exposed a missing
`workbench.design.v1` capability in the Bot gateway handshake. The installed Host
is current, but Bot Design tools incorrectly return
`workbench_design_host_update_required` before dispatch. The model-response and
local-editor checks above did not cover that combined path. See the
[reproduction, fix and regression evidence](design-gateway-capability-2026-10-31.md).
The source fix is separate from these frozen release bytes; 1.0.123 remains
affected until a later containing build is installed.

## Cleanup and remaining limits

The automatic global cleanup hit its discovery bound before deleting anything. Publication succeeded; only the read-back stage was resumed, without republishing. A separate bounded guarded cleanup completed with status **complete**, retiring **8** eligible Apps through `/usr/bin/trash`. The newest 1.0.123 macos-ready backup is retained; active/recent/held or incompletely accepted tasks are protected. This does not assert that the historical global backlog was fully cleaned.

Spotlight read-back returned **2** App paths; no newly built 1.0.123 temporary App is indexed. They are the installed App and the historical 1.0.119 macos-ready backup, which remains outside this bounded cleanup. All new build/cache/rollback Apps use physical `.noindex` roots; the installed App is never a cleanup target.

GitHub CI for the freeze did not start because of account billing/spending limits. Local evidence does not turn those jobs green. Browser/simulator checks do not establish physical phone camera/push/microphone, Finder drag, production permission prompts or real external-network remote capture/control. No production capture/input or system permission change was performed during this release.
