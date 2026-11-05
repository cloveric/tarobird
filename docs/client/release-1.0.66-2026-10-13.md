# Android, macOS and Windows 1.0.66 — 2026-10-13

[Download all three installers](https://github.com/cloveric/tarobot/releases/tag/v0.1.417-test.1).

Packages all changes after 1.0.65: independent conversation avatars and a visible
phone editor, whole-folder reordering, file-type icons, file-manager reveal,
desktop region capture, safe full-screen phone previews/settings, stable chat
scrolling/composer geometry, clearer computer selection and CLI prerequisites,
desktop title hierarchy, device-local interface density and the duplicate
Skills/MCP search-focus fix.

Choose **Compact / Standard / Spacious** in **Me → Settings → General → Layout
density**. Standard retains the existing layout; reading size is independent.
Both desktop packages include standalone host **0.1.417**, Node 24.14.0 and local
Bot execution. Each Bot's computer still needs its supported AI CLI installed and
signed in. Existing identifiers, pairings and local data are retained on upgrade.

## Packages

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.66-android.apk` | 35,286,323 | `7abb8e510e3b15b7c04bfc24524c7f05ea508e310f9a6cc06198dd96ebd4dc49` |
| `TaroBot-1.0.66-macos-arm64.dmg` | 128,071,896 | `c03cc99e4b3c04a7c3f5e78a39dc7cce82c0d7c4188e8f68114de401426a38fe` |
| `TaroBot-1.0.66-windows-x64-setup.exe` | 94,889,206 | `b3969ee339cd7a5875b41bf1948adf50e2555cb090bf5115b963c0319a5fe786` |

Android retains `com.tarocub.client`, versionCode `2026101320`, and certificate
SHA-256 `9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
The Apple Silicon Mac App is ad-hoc signed, not Apple-notarized. Windows x64 is
unsigned; the x64 desktop executable, Node and SQLite addon were verified.

## Verification

- Complete source gate: 240 files, 3,053 tests passed and one skipped, plus the
  standalone build. The first run used a dotted version directory as TMPDIR,
  which exposed five existing session-path decoder fixture failures. Repeating
  the complete gate with a short neutral temporary directory passed, without
  changing or excluding tests. This release does not add embedded-dot decoding.
- Fresh client dependency install, translation checks, TypeScript and production
  build passed. Fourteen Chromium release journeys passed for density,
  conversation avatars, safe full-screen previews and desktop capture. The
  preceding focus fix passed ten focused Chromium/WebKit journeys; density and
  font/sidebar compatibility also have their own recorded browser checks.
- Thirty-three macOS Rust tests passed. Independently installed standalone
  directory and extracted npm archive passed the no-Feishu dependency check,
  credential-free isolated Hub startup and frontend/helper resource checks.
- Android release assembly, 27 JVM tests and lint passed (zero errors, 22 existing
  warnings). Checked v2/v3 signatures, original signing certificate, 16 KB ZIP
  alignment, application ID, version and launcher resources. All 392 native
  public files match the APK; every non-index frontend file matches the copied
  assets. The index retains the mobile CSP transformation.
- Final Mac DMG checksum and strict deep ad-hoc signature passed after a read-only
  mount. All 4,851 mounted files match the sealed App, and 4,847 host files match
  the prepared bundle. Desktop and bundled Node are arm64. The mounted package's
  own Node passed isolated authenticated pairing, HTTP/WebSocket and synthetic
  Bot reply, private-pipe/engine-argument transport, stop/resume, and identity/name
  retention checks. Both final Mac and Android launcher icons were inspected by
  the package icon verifier.
- Windows MSVC x64 cross-build and NSIS packaging passed. All 4,848 extracted host
  files match the prepared Windows bundle. The executable reports 1.0.66.0;
  desktop, Node and SQLite native binaries are AMD64 PE. No Mac Node is included.
- GitHub Actions did not start because of the account billing/spending-limit
  restriction. The checks above ran locally; a failed-to-start CI job is not a
  passing CI run. Windows cross-build evidence is not native Windows execution.

This installer publication does not replace the user's installed apps or restart
live Hubs, Bots or legacy transports. Physical Android/Windows/Mac cross-machine
operation, real-model logins and the production VPS route were not revalidated.
The release assets are accompanied by `SHA256SUMS.txt`; upload receipts and
independent downloads are checked against the manifest before publication.
