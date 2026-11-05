# TaroBot 1.0.118 release verification

Published source: [`05a50abdc994bf61d0f776754056fd1d5455e0ce`](https://github.com/cloveric/tarobot/commit/05a50abdc994bf61d0f776754056fd1d5455e0ce).
App 1.0.118 / Host and standalone CLI 0.1.463; wire protocol 1;
Hub schema 22, supported upgrade input range 1–22. Android versionCode
2026102801; iOS build 1. Every package below is bound to this source.
The [independent review and changes](release-1.0.118-review-2026-10-28.md)
cover the revisions since 1.0.117 and the fixes found with Claude Opus 5.5.

## Publication

| Platform | Verified availability |
|---|---|
| macOS arm64 | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.118), Developer ID signed, notarized/stapled DMG and signed updater archive |
| Windows x64 | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.118), installer plus signed updater manifest |
| Android | [GitHub Release](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.118), release APK with continuous signing certificate |
| iOS | TestFlight 1.0.118 (1), Apple VALID, internal group assigned and IN_BETA_TESTING; Chinese and English test notes read back |
| Headless CLI | `tarobot-0.1.463.tgz`, identical archive attached to the three GitHub releases |

All GitHub assets were downloaded again and compared with verified local bytes.
Release tags resolve to the frozen source commit; updater signatures and manifest
asset references were checked. The final IPA passed signing, profile, version,
share-extension, privacy-manifest, device-binary and frontend checks before upload.
The App Store listing and external beta review were not submitted or changed.

## Validation

- Required pre-complete hook: 513 test files, 6979 tests
  passed and 5 skipped; Host/client builds, git identity and
  secret-history checks passed. Native Rust targets passed 79
  tests, including integration targets.
- Browser validation: Initial candidate run: 170 passed, one overall-timeout failure. That case passed at its original deadline on the final build; 17 supplemental Chromium checks, 10 targeted WebKit checks and six compiled-UI label geometry checks passed. Detailed run boundaries and any failed/retried
  attempts are retained in the local release receipts; browser evidence does not
  establish native-device behavior.
- The settings host label was checked in the actual compiled UI at 1360 and
  390 pixels across default, White and Mono palettes; computed spacing and
  screenshots are recorded separately.
- Clean standalone installation, archive extraction and reinstall, dependency
  inspection and previous 0.1.462 Host upgrade passed. Identity, controller,
  network, workspace, messages, attachments, reads/hidden state and idempotency
  were preserved. The standalone and bundled Host business/frontend bytes match.
- Canonical CLI: ten real Codex/Claude paired-client round trips passed across
  text/two-client synchronization, files, local voice transcription, question
  submission/resume, and streaming stop/context resume. Final Developer ID signed
  Mac Node loaded the foreign native addon and received `DEEPSEEK_RECOVERED_OK`
  from a real isolated DeepSeek session. Antigravity/Kimi remain covered by
  capability/adapter regressions; no new live provider run is claimed for them.
- Final DMG and updater archive contain the same sealed App. Gatekeeper, final
  package icons, embedded frontend, hardened Node entitlements and updater
  signatures passed. Windows extraction checked embedded frontend, PE runtime
  imports and icons. Android passed 44
  native unit tests; lint completed with 16
  warnings and no errors. Its signature continuity, version and launcher passed.
  iOS passed 6 release-plan tests and
  24 native keyboard checks, with Simulator
  and distribution outputs verified separately. Android/iOS packaged frontend
  assets match each other and the canonical CLI web UI.

## Remaining acceptance boundaries

GitHub Actions did not start for the source commit because of the account's
payment/spending limit: [source checks](https://github.com/cloveric/tarobot/actions/runs/40620665164)
and [secret scanning](https://github.com/cloveric/tarobot/actions/runs/40620665106)
each ran zero steps. These failures are infrastructure blockers, not CI passes.
Local required checks above were completed independently.

This release did not install or restart the production Mac Host. Native Windows
installation/startup, physical iPhone/Android upgrades and APNs/FCM delivery were
not performed. Cross-compilation, Simulator, package inspection and TestFlight
availability do not prove those device results. Windows lacks Authenticode
signing. Daily Bot configurations and model effort were unchanged.

Update paired Apps before clearing a large history: older clients understand
the events but can process them slowly. Active tasks and actionable cards pause
clearing. An older Host without notification customization cannot provide the
new in-App preview switch. Tool attachments can still precede subsequently
generated model text; no ordering-gap fix is claimed.

## SHA-256

| Artifact | SHA-256 |
|---|---|
| TaroBot-1.0.118-macos-arm64.dmg | `9dad59a9771631b7182ef8a437e8bd5618b7aa654d12e339e7b5e0d1fcd61b50` |
| TaroBot.app.tar.gz | `3a799277a6f0b0a6e857336ea304f10581bce376c1f0029aa2ec3e618456b8b2` |
| TaroBot-1.0.118-windows-x64-setup.exe | `a152513e94960544378fbd81e3f3a05e24384d3b85c9b737bb0dc031f6561f45` |
| TaroBot-1.0.118-android.apk | `d93d04abf182527f16fdc5351a17bd8485254f0d37b268ee6eba88ca953a5b9c` |
| tarobot-0.1.463.tgz | `cb1ced5251fb5d17a4ef9eeefaa2d135e7ea5758d2b2839fb6eab4a2d76a0774` |
| iOS 1.0.118 (1) IPA | `1e22c96677632acffc19243faa9f794ee085c6eba8da1ea639dc64a83e74e215` |

## Local Mac installation — 2026-10-28

After publication, the owner requested installation of the latest Mac release.
The installed `/Applications/TaroBot.app` is now **1.0.118**, with bundled Host
**0.1.463**, bound to `05a50abdc994bf61d0f776754056fd1d5455e0ce`. The signed
App tree matches the published candidate. The guarded handoff changed Host PID
42013 → 35038 and preserved its identity, all 9 Bot IDs, 158 conversation IDs,
6,868 message IDs, 10 device IDs and 2,049 attachment IDs. A stopped-state SQLite
backup passed `quick_check`; schema 22 and the backup policy were preserved.

The installed Node passed authenticated runtime readback, all seven managed
Bots were online, and the relay reported all online. An isolated real DeepSeek
request using that installed Node returned `DEEPSEEK_INSTALLED_OK`; no existing
conversation or daily model setting was used. CUA then confirmed the visible
native TaroBot window, `工作台：macmini，已连接`, and `TaroBot 1.0.118` in Settings.
Settings were closed after inspection; the existing black-and-white / light warm
gray appearance was preserved. No other Bot forwarded the installation result.

Receipts: `/Volumes/gdrive/taro-tmp/install-mac-1.0.118-20261028/activation.json`,
`installed-runtime-readback.json`, `installed-model-verification.json`, and
`installed-gui-verification.json`. The old App and external state snapshot are
retained for deliberate recovery. The separately installed terminal CLI remains
0.1.462; this operation updated the Mac App and its bundled Host. Physical phone
and native Windows installation remain outside this acceptance. The subsequent
Messages-icon and sidebar-highlight commits are not part of published 1.0.118.
