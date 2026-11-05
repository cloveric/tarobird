# Android, macOS and Windows 1.0.61 — 2026-10-13

[Download all three installers](https://github.com/cloveric/tarobot/releases/tag/v0.1.415-test.3).
All clients are version **1.0.61**, built from source `d4f7b32`; the Mac's bundled
standalone host is **0.1.415**. Subsequent release-checkpoint changes are documentation only.

This checkpoint includes the phone primary-action label repair, long-press folder
renaming, the flat macOS template tray icon, desktop conversation folder moves,
and Windows companion pairing. It supersedes the older per-platform downloads.

## Installers

| File | Platform | SHA-256 |
| --- | --- | --- |
| `TaroBot-1.0.61-android.apk` | Android, `com.tarocub.client`, versionCode `2026101316` | `46a9d042cace0ab2a9a07b77755aad30aeef812d51144c456efdb67c54877ee8` |
| `TaroBot-1.0.61-macos-arm64.dmg` | macOS 13+, Apple Silicon | `a3e1859edf90df4982f44707e491968f76b61f2c4f1aab84de9d49d7fc413f26` |
| `TaroBot-1.0.61-windows-x64-setup.exe` | Windows 10/11, Intel/AMD x64 | `6f9e23a53b7202cbbdd4dc27a937f4faf0e0c4539796f49434f6833a311ed6d2` |

Android retains the certificate used by the freshly downloaded 1.0.59 APK, so it
can update the same application without uninstalling. The Mac App is ad-hoc
sealed, not Apple-notarized; it bundles an arm64 host and is not an Intel build.
Windows is unsigned and connects to an existing host; it does not run a local
Hub or Bot engine. No Windows ARM64 installer is included.

## Package checks

- The completion hook passes the standalone build and 230 test files: 2,935
  tests pass, one is skipped. Fresh locked client dependencies, translations,
  TypeScript and production builds pass.
- Android release compilation and lint pass (zero errors, 22 existing warnings).
  Gradle reuses the unchanged successful 27-test JVM task. Version, application
  ID, non-debuggable build, 16 KB ZIP alignment and v2/v3 signatures are checked.
  All 378 frontend files match the native copy, including the intended CSP
  transformation; all 380 public assets match the signed APK. All 15 launcher
  PNG variants, two adaptive launchers and manifest references pass inspection.
- The final Mac DMG passes image verification. Its read-only mounted App passes
  strict deep signature verification; all 4,795 bundle files match the sealed
  build. Main binary, Node and native addons are arm64. The 296 host files and
  378 web files match the inputs. Actual Mach-O dependency/search-path commands
  contain no Homebrew or developer-home dependency. Bundled canvas and SQLite
  load using the bundled Node.
- Independent production installation and extracted npm archive both pass
  isolated Hub startup and client serving without the Feishu SDK. The mounted
  DMG passes the same startup check with its own Node 24.14.0 and temporary state.
- The Windows x64 MSVC release and NSIS installer rebuild successfully through
  `desktop:windows`. Archive integrity and extraction pass. The installed EXE
  matches the build except Tauri's bundle-type patch; PE architecture/version,
  all six ICO payloads and absence of Mac host resources are checked.
- `SHA256SUMS` and a sanitized `TaroBot-1.0.61-verification.json` accompany the
  installers. Published assets are downloaded again and compared with local
  checked files before handoff.

## Acceptance limits

This is a private test release, not store distribution. It does not replace the
user's installed Mac App or install onto a phone. Windows installation and
runtime, physical Android behavior, live provider conversations and production
push were not revalidated in this packaging run. No live host or legacy fleet
was restarted. GitHub Actions remains blocked before job startup by account
billing/spending limits; local checks do not constitute a remote CI pass.
