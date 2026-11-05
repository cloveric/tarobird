# TaroBot 1.0.90 / host CLI 0.1.438

This release adds three terminal-family themes and improves phone composer sizing.

## Changes

- Settings → General → Color palette → Expressive themes now includes Terminal
  TTY, Paper and Agent Terminal. Each supports light, dark and system appearance.
- ADHD panes retain their independent reading size and drafts. Prompt glyphs
  follow the pane's input size when the ordinary window uses a different size.
- On phones, the composer expands when text actually wraps onto multiple lines,
  using the available width more effectively.
- The README presents four ADHD conversations in one row, selected from a larger
  Bot list. Release downloads stay on the stable Releases page.
- Two image-recovery fixtures now use a documentation-only IP address, and one
  development note uses a generic home-relative path. This cleans the current
  source; it does not erase earlier Git history.

CLI impact: these changes affect client presentation and documentation. They do
not add host APIs, permissions, queue semantics or CLI commands. The matching
standalone package includes the same updated web client as the desktop host.

## Compatibility

App 1.0.90; host/CLI 0.1.438; bundled Node 24.14.0; protocol 1; network membership
2; Hub schema 17, accepting input schemas 1–17. Android versionCode 2026101708
retains the existing package ID and signer. Existing update-signing keys remain
pinned. This release does not migrate host identity, pairing or conversations.

## Verification and distribution

Executable source: [7404554](https://github.com/cloveric/tarobot/commit/74045541e47461eb2f9188b5e9bc0f67c0e6185a).
The source/theme review is documented in [terminal themes](terminal-themes-2026-10-17.md).

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | 325 files; 4,310 passed, 1 existing skip; standalone build/graph passed | Local source checks |
| Client | Clean dependency install, translations, TypeScript and Vite passed | Shared web client |
| Focused browsers | Chromium 9 and WebKit 9 passed | Themes, independent ADHD fonts/drafts, phone composer and image recovery |
| Mac native unit tests | 64 passed | Native policies/lifecycle; no repeated production OAuth flow |
| Android APK | Original signer, 38 JVM tests, lint 0 errors/19 warnings, 410 matching web files | No physical phone connected |
| Final Mac DMG | Read-only mount, strict deep seal, icons/version and embedded renderer verified; 772 CLI/host files match | Apple Silicon, ad-hoc seal, not Apple notarization |
| Final Windows installer | Extracted NSIS, embedded renderer and runtime dependency checks; 772 CLI/host files match | Cross-built x64; no native Windows execution or Authenticode signature |
| Desktop update packages | Pinned key, signed version and updater configuration verified | Mac and Windows channels |
| Standalone CLI | Two clean production installs, pack/extract, dependency and startup checks passed | No external registry publication |
| CLI upgrade | 0.1.437 → 0.1.438; identity/controller/network/workspace retained | Disposable host, no production OS service change |
| Real Codex | Text/two-client sync, original-file roundtrip, local ASR, native question and stop/resume passed | Paired client protocol → isolated packaged Hub/Gateway → real engine |

The unchanged native updater installation flow, Android emulator upgrade,
other providers and physical multi-host collaboration were not repeated.
GitHub [Source checks 39043728246](https://github.com/cloveric/tarobot/actions/runs/39043728246)
executed zero steps because of account billing/spending limits. Local test success
does not represent a successful cloud run.

- [Mac Apple Silicon and matching CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.90)
- [Windows x64 and matching CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.90)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.90)
- [Verification and artifact hashes](evidence/release-1.0.90-2026-10-17.json)

The published assets are downloaded again and compared with local verified bytes,
GitHub asset digests and SHA256SUMS; desktop signatures/manifests are also checked.

## Local Mac activation

The old App is backed up on the external disk and the verified 1.0.90 App is
staged for replacement. A detached helper waits for this Bot turn and other
active work, takes a private offline state snapshot, then replaces the App and
resumes the same host. It verifies the App/host versions, identity, retained
record counts, authenticated local reconnection and new GUI process.

At publication, activation is **staged/waiting**, not already installed. The
private external-disk `activation.json` records the eventual result. Actual
desktop window interaction remains a separate unchecked surface. No unrelated
transport fleet is restarted, and current Git history is not rewritten.
