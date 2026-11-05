# Android, macOS and Windows 1.0.67 — 2026-10-14

[Download all three installers](https://github.com/cloveric/tarobot/releases/tag/v0.1.418-test.1).

This release packages the changes since 1.0.66 and the [daily joint audit](audit-2026-10-14.md): native run views across Codex, Claude, Antigravity, Kimi Code and DeepSeek; guided collaboration and task-specific members/order; unified file captions and attachment cards; full-width Bot-mode previews; compact phone defaults and a slimmer composer. It also fixes premature completion notifications, restart recovery, slow detail loading, bounded journal receipts, network join/synchronization races and an invisible collaboration confirmation button.

Both desktop installers include standalone host **0.1.418**, Node 24.14.0 and local Bot execution. The computer running a Bot still needs its supported AI CLI installed and signed in. Existing application IDs, pairings and local data are retained by the package configuration; this is not a claim of a new installed-upgrade acceptance run.

## Packages

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.67-android.apk` | 35,302,789 | `89767c94ac481601def3f2cea80c526802a9edb9a8f07409aecd27283db13e18` |
| `TaroBot-1.0.67-macos-arm64.dmg` | 128,097,476 | `a0e1a84c98e07dd0643c88ec7aeda440c68371c49360cfb0bad1311901df9722` |
| `TaroBot-1.0.67-windows-x64-setup.exe` | 95,004,867 | `723ed7c19aeafb15bf56fd1a25b7adcc88503e66977c399005d3a2075ec51404` |

Android retains `com.tarocub.client`, versionCode `2026101401`, and certificate SHA-256 `9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`. Mac targets Apple Silicon, is ad-hoc sealed and is not Apple-notarized. Windows targets x64 and is unsigned; native Windows ARM64 and Intel Mac packages are not published.

## Verification

- Final standalone source build and complete test gate: **244 files, 3,131 tests passed, one skipped**. Fixtures use isolated state. Five-engine protocol, network, push and restart cases are included; this is not live model-account validation.
- Final client translation, TypeScript and production build passed. The broad UI pass recorded Chromium 107 passes and one attachment-test timing failure, and WebKit 106 passes with two unsupported native-touch cases skipped. The persistence-wait correction then passed all seven attachment cases in both engines. Additional focused suites passed: network manager 14 per engine, concurrent native handshakes three per engine, and the final collaboration visual/interaction cases two per engine. The slow-detail regression has two cases in each engine. Screenshots were actually inspected; the collaboration button fix was verified failing-before/passing-after for contrast and pending states across six light/dark color combinations.
- macOS Rust regressions: 33 passed. The isolated desktop runtime gate's four fixtures passed, and the actual prepared Mac and Windows runtimes passed their respective platform/architecture checks.
- Independent production directory and extracted npm archive were separately installed and verified without the Feishu SDK, postinstall hooks or legacy transports. Both served the frontend and started an isolated Hub without model credentials; all 720 archive files matched the verified directory.
- Android release assembly, **30 JVM tests** and lint passed (zero errors, 22 warnings). Verified original certificate, v2/v3 signatures, 16 KiB alignment, package ID/version and launcher resources. All **393** APK public files match native assets; all **391** frontend files match the approved build, with only the exact mobile CSP transformation applied to the index.
- Final Mac DMG passed integrity verification and strict deep signature checks after a read-only mount. All **4,857** mounted files match the sealed App, and **4,853** host files match the prepared runtime. Desktop and bundled native binaries are arm64. The mounted package's own Node passed isolated authenticated pairing, HTTP/WebSocket, synthetic Bot creation/reply, private pipes, argument transport and host stop/restore/name retention. Mac and Android final launcher icons were checked from their packages.
- Windows MSVC x64 cross-build and NSIS archive checks passed. Every extracted host file and approved frontend file matches the prepared bundle; the desktop EXE differs from the fresh build only by Tauri's expected NSIS marker. Version is 1.0.67.0, and desktop, Node and native addons are AMD64 PE. No Mac Node is included. This is not native Windows execution or installed-upgrade validation.
- GitHub Actions was unable to start because of the account billing/spending-limit restriction. Local results above are recorded separately; a job that did not run is not passing CI.

## Remaining boundaries

The Android Firebase application configuration is absent. **Phone background/lock-screen notification delivery is not connected or verified by this release.** Push eligibility and native notification handling tests must not be presented as actual FCM delivery.

Physical Android/Windows/Mac cross-machine operation, real-model logins, the production VPS route, installed upgrades and Mac Keychain prompts were not revalidated. This publication does not replace installed Apps or restart live Hubs, Bots or optional legacy transports.

`SHA256SUMS.txt` accompanies the installers. Release asset upload state and independent downloaded bytes are checked against these hashes before publication.
