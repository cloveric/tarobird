# TaroBot 1.0.122 release and local Mac verification

Verified 2026-10-30T22:16:59.297845+00:00.

Artifacts bind to `2aee119c15deec1917113ccff16db048a4d6bb65`: App **1.0.122**, Host/standalone CLI **0.1.467**, Electron **45.1.0**, protocol **1**, Hub schemas **1–22**. Later verification and corrective commits do not change the artifact source.

## Release contents and checks

This release includes the Electron migration and follow-up Kimi/DeepSeek/Opus reviews, workbench browser/whiteboard/Markdown support, queue and attachment interactions, and the [October 31 audit fixes](day-changes-audit-2026-10-31.md). Remote-screen policy/control remains disabled by default; native capture/input and external-network acceptance remain separate, explicitly unverified scopes. Mobile retains Capacitor.

- 557 Vitest files: **7,453 passed, 6 skipped**; Node artifact-path tests **6 passed**; Electron contracts **224 passed**.
- Retained native regressions **104 passed**; desktop core **62 passed, 2 ignored**, OS addon **33 passed**, updater **71 passed**. Ignored OS credential/cross-language fixtures are not counted as passed; signed disposable Keychain compatibility was additionally exercised through real Electron.
- Independent dependency installs, root/client builds and translation checks passed. The pre-complete hook initially lacked Cargo in PATH, then lacked the generated Host resource in the fresh checkout; its native step was completed after preparing the resource with the full build environment.
- Test-harness corrections: node:test artifact tests run under Node, crash-loop audit tests wait for the asynchronous DB receipt, and upgrade read-back normalizes only the expected additive null workbench-receipt column. Existing fields remain exact comparisons. The CLI package-start fixture uses a short disposable temp path for macOS socket limits.
- Standalone CLI clean and extracted installs and upgrade from **0.1.464** passed, preserving identity, controller, network, workspace, messages, read/hidden state, attachment bytes and retry idempotency. Schema remains22. No external npm registry publication.

## Mac publication

[Mac release](https://github.com/cloveric/tarobot/releases/tag/macos-tarobot-v1.0.122). Every uploaded file was downloaded again; byte counts, SHA-256, tag/source and update signature matched.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| TaroBot.app.tar.gz | 290546189 | `9481b0a17b2e0298895838b57b193a0a590bee400f4f2f197b461995c6ff0a5e` |
| TaroBot.app.tar.gz.sig | 428 | `b0bc955ed88e3714a7691b9f8937753fda3bf49ebc35157f6a3ae88dbaae9ff2` |
| TaroBot_1.0.122_aarch64.dmg | 338223968 | `80e1994a9a117a004932b56cb4b130554fa431abdfedfc851e2da6d5ea7e154c` |
| tarobot-0.1.467.tgz | 46203674 | `bb79368e755ae408dd0275ffa0727d2062df43e0ff82d4c0084b5387683e5445` |
| macos-tarobot-latest.json | 1611 | `ce627f263639212efb1c6209dbf4827c0939e9f56b948194528243e0afc112ea` |
| SHA256SUMS | 446 | `094ba9766a4940b0fc9ee2dfd6d1fd3b1cd302158a8483b46dc72acfb26dd389` |

- Clean production metadata and complete desktop renderer inventory matched the frozen source.
- 30 nested executable signatures satisfy Developer ID, hardened-runtime and role-specific entitlement policy. Bundled Node loads the external DeepSeek addon.
- Apple notarization accepted; staple/Gatekeeper checks and final DMG/archive verification passed. Both old Tauri and new Electron update parsers accepted the archive.
- Production debugging and unauthorized core/updater/exporter launches were refused before credential/profile access.
- Actual signed Electron read/signed with/retired an isolated legacy Keychain fixture; production credentials and installed App were untouched by this test.

## Installed Mac

Upgraded the owner's actual **Tauri1.0.119 / Host0.1.464** to the exact published Electron1.0.122. Before replacement, stopped GUI/Host snapshots preserve the old signed App, SQLite data, native identity and WKWebView state. No data reset or re-pairing.

Host PID changed from `751` to `44349`. Installed App and Node hashes match publication; terminal CLI reads **0.1.467**. Original Host identity and authenticated connection remain intact.

| Table | Before | After | Missing |
| --- | ---: | ---: | ---: |
| bots | 9 | 9 | 0 |
| conversations | 182 | 182 | 0 |
| messages | 8302 | 8302 | 0 |
| devices | 14 | 14 | 0 |
| attachments | 2342 | 2342 | 0 |

CUA verified the actual native Electron window, settings version, original Host connection, existing Bots and conversations. Committed legacy data import was read back (9332 records). Installed bundled Node verified runtime and a real isolated DeepSeek response: `DEEPSEEK_INSTALLED_OK`. Passing model tests were not repeated after continuation.


### Existing-profile migration defect and one-time recovery

The first actual production launch failed with `migration_export_failed`; retry also failed. An isolated copy of the stopped legacy backup reproduced a Rust `migration_record_invalid`: an old message summary contained lone UTF-16 surrogate code units, which JavaScript preserves but the native JSON parser rejects. The reader also discarded native string error reasons.

The candidate fix preserves affected keys/values through the existing authenticated JSON-blob format and keeps bounded native error codes. It passed 18 focused tests, the client type check/build, and a real WKWebView export of 9,332 records (8,302 messages, 4 drafts, zero skipped entries and no re-pairing). The release's unchanged decoder verified all records and the triggering record's exact original code units. All SQLite table cells/types/schemas in the original source matched the backup; file differences were WAL checkpoints only.

For this Mac only, the verified export was admitted after installation-marker and live-source equivalence checks. No imported-profile marker or receipt was fabricated; CUA retried the normal gate, and the original installed importer wrote the durable import receipt. A full GUI quit/relaunch returned to the original connected workspace without restarting the Host. The published and installed 1.0.122 bytes remain bound to the frozen source above.

**This is successful local recovery, not proof that unassisted 1.0.122 upgrades handle the defect.** The general source correction is separate and is not retroactively included in these release assets. See [migration correction](desktop-migration-surrogate-2026-10-31.md).

## Other platforms and boundaries

- Android 1.0.122 published: [release](https://github.com/cloveric/tarobot/releases/tag/android-tarobot-v1.0.122). APK signer, package/version, Firebase configuration, final icons and frontend bytes verified; all published files downloaded and hashed. 45 native unit tests and release lint passed (15 warnings, zero errors). Physical phone acceptance is separate.
- iOS 1.0.122 (1) uploaded, Apple processing VALID, existing internal TestFlight group has the build and IN_BETA_TESTING is confirmed. Existing testers/group/public store metadata retained; no App Store or external beta submission. Signed App/share extension, profiles, assets and simulator build verified; physical iPhone acceptance is separate.
- Windows Electron installer was cross-built for inspection; native install/upgrade/update/uninstall and WebView2 data migration remain owner-deferred. No new Windows release is published until that acceptance is available.

GitHub hosted CI is billing/spending-limit blocked and is not counted as executed. Browser/simulator checks do not establish real phone camera, microphone, push, drag from Finder or external-network behavior. Remote screen physical capture/input remains separately gated. No finite audit proves zero undiscovered bugs.

The automatic global cleanup deferred safely at its discovery bound in an old Playwright cache; bounded cleanup results are recorded separately. Recent, held and active artifacts are retained. Spotlight still lists the installed App and the previous 1.0.119 macos-ready backup; no new temporary App is indexed. Cleanup of that old indexed backup remains deferred, and the 1.0.120/1.0.121 owner holds remain untouched.

Artifacts, rollback snapshots and private receipts remain in physical `.noindex` task directories. Cleanup uses the guarded trash helper and preserves recent/in-use/held Apps and the latest macos-ready backup. The installed App and unrelated Bot work are excluded.
