# Android, macOS and Windows 1.0.65 — 2026-10-13

[Download the three installers](https://github.com/cloveric/tarobot/releases/tag/v0.1.416-test.1).

This release packages the private host network, independent phone membership,
and optional sidebar host grouping. Each computer brings its own Bots and data;
authorized desktop and phone controllers discover the network's hosts. New Bot
creation selects an online host. A member's departure preserves the phone's
access to the remaining network, even if it originally paired through that
member. Desktop lists combine hosts by default; **Group by host** is optional.
The English and Chinese homepages now explain this with network and departure
diagrams. See [setup, ownership and departure rules](private-network.md).

Update every participating desktop and phone to 1.0.65. The macOS and Windows
installers include standalone host **0.1.416**, Node and local Bot execution.
Separately managed Hubs need the corresponding host update. All hosts must
support `private-network.v2` before membership changes. Existing individual
pairings and data are retained; they are not silently merged into a network.
Hosts still need reachable HTTPS routes; pairing does not configure a VPS.

## Packages

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.65-android.apk` | 35,278,131 | `19971e76317c97bb976795629d66a2e59a45a658ba7d5fb82cc05466d57be305` |
| `TaroBot-1.0.65-macos-arm64.dmg` | 127,991,474 | `5832c7561e1767173b6e5dfda4197d57aaa6a031f65037b274c3b4aef99c4831` |
| `TaroBot-1.0.65-windows-x64-setup.exe` | 94,882,500 | `b241c75bcb6ed6d15a546e021a23c6733377b39012a8cd520a0ce0c1625c442c` |

Android retains `com.tarocub.client`, versionCode `2026101319`, and certificate
SHA-256 `9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
The Apple Silicon Mac App is ad-hoc signed, not Apple-notarized. Windows x64 is
unsigned and includes its own verified Windows Node/SQLite runtime.

## Verification

- Implementation baseline: the latest network/sidebar changes passed the full
  root suite (**240 files, 3,052 tests passed, one skipped**) and 30 Rust
  main-binary tests. Chromium and WebKit each passed four disposable real-TLS-Hub
  network journeys, including C departure with phone access retained on A/B.
  Native startup/cache recovery, onboarding and sidebar checks are recorded in
  the [network guide](private-network.md) and [sidebar refinement](sidebar-layout-2026-10-13.md).
- Root/client production builds, translation checks and TypeScript passed for
  this release. Both desktop packages carry the new network capability and host
  version; the shipped web assets match the built UI.
- Android release assembly, 27 JVM tests and lint passed (zero errors, 22
  existing warnings). Checked the original signing certificate, v2/v3 signatures,
  16 KB ZIP alignment, version and launcher resources. All 392 native public
  files match the APK, and all 389 non-index frontend files match the native copy.
  The index retains the existing mobile CSP transformation.
- Mac DMG checksum and strict deep signature verification passed. All 4,851 mounted
  files match the sealed build, and both desktop and bundled Node are arm64.
  The mounted package's own Node passed isolated authenticated HTTP/WebSocket,
  synthetic Bot reply, stop/resume and identity/name-retention checks.
  The smoke verifier was updated for the new `hostName` field, with explicit
  named-host creation and restart assertions; its former exact response shape
  rejected the valid extra field before any Hub was started.
- Windows MSVC x64 cross-build and NSIS succeeded. All 4,848 extracted host files match
  the prepared bundle; desktop, Node and SQLite native binaries are AMD64 PE.
  No Mac Node is included. Cross-build warnings do not constitute a native
  Windows execution check.
- All six Mermaid blocks in the two READMEs parsed with Mermaid 11; the four new
  network/departure diagrams were rendered and visually inspected.
- Published GitHub asset sizes and SHA-256 digests are checked against the
  local manifest.

This installer-only publication does not install over the user's apps or
restart live user Hubs, Bots or legacy transports. Physical Android/Windows/Mac
cross-machine operation, real model logins and the user's production VPS route
were not revalidated. Implementation/browser/package checks are not a claim of
those acceptance surfaces.
