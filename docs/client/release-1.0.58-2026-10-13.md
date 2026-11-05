# Android and macOS 1.0.58 — 2026-10-13

Release tag: `v0.1.415-test.1`. Client version: **1.0.58**. Bundled standalone
host: **0.1.415**. The source includes `108fc96` conversation-entry stabilization
and `a8cadc7` joint audit repairs, together with the subsequent desktop/mobile
UX work since the previous published APK.

## Installers

| File | Platform | SHA-256 |
| --- | --- | --- |
| `TaroBot-0.1.415-test.1-android.apk` | Android, package `com.tarocub.client`, versionCode `2026101313` | `76b0de05f50c4af5a9011af20e74fb61a6aa08e7b6e56a8de974244b11a30384` |
| `TaroBot-0.1.415-test.1-macos-arm64.dmg` | macOS 13+, Apple Silicon arm64 | `8b9f7a645fdc27f74017c8c6f3c9f78a81c3a1dcc6c63462248a146e808513a3` |

Android retains the previous published APK's signing certificate and application
ID, enabling an in-place upgrade. The Mac App is ad-hoc sealed and **not Apple
notarized**. Its native executable, bundled Node and native addons are for
Apple Silicon; this is not an Intel/universal release.

## Packaging verification

- Standalone build and full suite: 230 files passed, 2,935 tests passed, one
  existing skip. The graph contains 295 modules and no legacy transport/Feishu SDK.
- Fresh client locked dependency install, translation validation, TypeScript
  validation and production build passed.
- Android release compilation, 27 JVM tests and release lint passed: zero
  errors, 22 existing warnings. APK alignment and v2/v3 signatures verified;
  certificate matched a freshly downloaded `v0.1.414-test.6` APK whose digest
  matched the GitHub release. The final APK is non-debuggable.
- All 378 production web files match the mobile copy (with the intentional
  native CSP transformation), and all 380 native public assets match the APK.
  Launcher checks cover all 15 PNG variants, both adaptive icons and manifest
  references.
- The optimized Mac release was bundled with the current standalone host and
  official arm64 Node runtime. Final DMG checksums passed; its read-only mounted
  App passed strict deep signature checks, bundle version/identity/icon checks
  and native architecture checks. Its executable matches the bundled App,
  all 378 web files and 296 host dist files match the validated build.
- The independently installed production directory and extracted npm archive
  both passed isolated Hub startup, static client serving and no-Feishu checks.
  The same startup check passed directly against the mounted DMG using its own
  bundled Node. No model/Feishu credentials were used.
- `git diff --check` passed. `SHA256SUMS` accompanies the release installers.

## Acceptance boundaries

The entry/layout source repair previously passed 64 Chromium and 64 WebKit
regressions, documented in [conversation entry](conversation-entry-2026-10-13.md).
The audit's separate native and browser results are recorded in
[joint audit](joint-opus-audit-2026-10-13.md). Those are not new physical-device
results for these installers. This packaging run did not install onto the user's
phone, replace the installed Mac App, exercise a real provider conversation,
validate production push, or restart live host/legacy services.

GitHub source checks at the source checkpoint were blocked before jobs started
by the account's billing/spending limit. Local results above are independent of
that infrastructure state; no remote CI pass is claimed.
