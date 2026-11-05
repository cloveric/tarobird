# Android, macOS and Windows 1.0.64 — 2026-10-13

[Download the three installers](https://github.com/cloveric/tarobot/releases/tag/v0.1.415-test.5).

The phone inbox and desktop conversation layout now expose **排序** beside
**新建分组**. Drag the handle or use the arrows, then Save. Unfiled can move too.
The order syncs across the same user's devices on one Hub and survives restart;
Cancel leaves the saved order intact. See [folder behavior and concurrency](conversation-folders-2026-10-13.md).

Update both the client and the computer running its Hub (for example example-mac).
The macOS and Windows packages contain the updated standalone host. Separately
managed Hubs require the corresponding source update. Older Hubs keep their
existing folder operations but cannot accept order changes.

This cumulative release also includes Windows local Hub/Bot hosting and the
compressed whole-window QR-image repair. The user confirmed that their imported
QR image was a whole screenshot. The synthetic JPEG whole-window regression was
rerun and passed in Chromium and WebKit; the original imported image was not
supplied, so its exact pixels are not claimed as verified.

## Packages

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.64-android.apk` | 35,244,256 | `9a57edc416f085cfa0ca2001141152884f06813f1bc7d153e7d3281bde607c15` |
| `TaroBot-1.0.64-macos-arm64.dmg` | 127,908,116 | `15a8d64ffa68122eef423ee6339bee166b78dd1f76735a259d268559e0ee0ba8` |
| `TaroBot-1.0.64-windows-x64-setup.exe` | 94,815,940 | `9d9dd8199fb6d8823ef6fb7bb3e2e5fb8d4caadfb11884d391aaeacc0954fb3b` |

Android uses the existing application ID `com.tarocub.client`, versionCode
`2026101318`, and private-test certificate SHA-256
`9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
The Apple Silicon Mac App is ad-hoc signed, not notarized. Windows x64 is unsigned.

## Verification

- 40 focused Hub/protocol checks passed. Browser regression: **30 Chromium +
  30 WebKit** journeys passed, plus the expanded host-switch cleanup check at
  both widths in each browser. Chromium uses actual injected touch input;
  WebKit drag checks use mouse input. Captured phone/desktop layouts were reviewed.
- Root/client production builds passed. Full source suite: **231 files,
  2943 passed, 1 skipped**, with `--maxWorkers=4`. The first default-concurrency
  run overlapped native packaging and had six failures in the existing polling
  suite; its separate 172-test rerun and the complete bounded-concurrency rerun
  passed without changing or weakening those tests.
- Android release assembly, 27 JVM checks (up-to-date task), and lint passed
  (zero errors, 22 existing warnings). APK version, ID, v2/v3 signature, 16 KB ZIP
  alignment and launcher icons were checked. All **380** native public assets
  match the signed APK; all **377** non-index frontend assets match the native
  copy (index keeps the existing mobile CSP transformation).
- Mac DMG checksum verified. Its read-only mounted App passed strict deep
  signature checks; all **4834** files match the sealed build. Prepared host
  content matches, allowing native binaries to be re-sealed during bundling.
  Desktop and Node binaries are arm64. The mounted package's own Node passed
  the isolated authenticated HTTP/WebSocket, supervised fixture-Bot reply,
  stop/resume and identity-retention smoke test.
- Windows MSVC x64 cross-build and NSIS succeeded. The installer was extracted;
  all **4831** prepared host files match. Desktop/Node EXEs are AMD64 PE, the
  host advertises the new ordering capability, and no Mac Node is included.
- Published installer digests are checked against the local SHA-256 manifest.

This release does not replace installed apps or restart the user's live Hub,
Bot processes or legacy fleet. Physical Android/Windows interaction, real model
logins and production push were not revalidated. Windows native CI remains
blocked by GitHub account billing/spending limits; cross-compilation and browser
checks are not a Windows-native acceptance pass.
