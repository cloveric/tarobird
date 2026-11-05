# TaroBot 1.0.91 / host CLI 0.1.439

This release brings the independent audit repairs and process-history fixes into
the Mac, Windows, Android and standalone CLI packages.

## Changes

- Codex child-agent activity is retained in the App process history. Long child
  reports remain readable, with explicit bounds instead of broken partial JSON.
- The process reader opens recent activity and can load earlier pages. Reading
  an older page is no longer interrupted by incoming updates. Desktop, phone and
  ADHD views share the repaired reader. The static forwarding excerpt remains a
  separate, bounded representation; it is not the process reader's storage limit.
- ADHD windows can be reordered with native-safe pointer dragging. Forwarded
  sources stay inside their message bubble. Queued question follow-ups show their
  own run and can be cancelled before execution without stopping unrelated work.
- Shared runtime timeout preferences reach card, command and collaboration entry
  points. Private-network enrollment and directory reconciliation, large history
  and replay pages, attachment retirement and managed-update recovery are fixed.
- Android discovers updates at startup and allows a progressing APK download to
  continue beyond five minutes. Playing audio survives virtual scrolling, and
  undecodable media offers recovery of the original file.
- Desktop private-update downloads expose cancellation before installation.
  Storage failures receive appropriate guidance, and preparation subprocesses
  no longer inherit updater signing secrets.
- iOS build/export preparation and simulator signing fixes are included in source.
  This release does not distribute an iPhone IPA or publish to TestFlight.

See the [independent audit](../independent-audit-2026-10-18.md) and
[process-history repair](codex-process-visibility-2026-10-18.md) for reproduced
defects, excluded findings and remaining verification boundaries.

## Compatibility and CLI

App 1.0.91; host/CLI 0.1.439; bundled Node 24.14.0; protocol 1; private-network
membership 2; Hub schema 17, accepting input schemas 1–17. Android versionCode
2026101801 retains the package ID and original signer. Desktop updater keys stay
unchanged. Existing host identity, pairing and conversations are preserved.

Host repairs apply to both desktop and headless CLI. No new CLI command or schema
migration is needed. Client-only layout/media controls have no headless UI
equivalent. The standalone archive and App-bundled hosts are built from the same
release revision and include the same shared web client.

## Verification and distribution

Executable source: [f7d4f5d](https://github.com/cloveric/tarobot/commit/f7d4f5da392f1905c89fa7533ed9ce79ad9565e8).

| Surface | Result | Boundary |
| --- | --- | --- |
| Source gate | 331 files; 4,411 passed, 1 skip; secret scan and standalone build passed | Local; 362-module import graph |
| Optional adapter regressions | 57 files; 1,230 passed | Isolated fixtures; no fleet operation |
| Build-plan and privacy guards | 16 passed | Local Node tests |
| Shared client | Clean dependency install, translations, TypeScript and Vite passed | Source build |
| Browser checks | Chromium 55, WebKit 55 passed | ADHD, queued answers, child reports, forwarding, queue and process reader |
| Mac native tests | 64 passed | Native policy/lifecycle unit tests |
| Android APK | Original signer; 39 JVM tests; lint 0 errors/19 warnings; 410 web files matched | No physical phone connected |
| Final Mac DMG | Strict deep seal, icons, version and embedded renderer verified; 775 Host/CLI files match | Apple Silicon; ad-hoc, not Apple notarization |
| Mac updater equivalence | All 4,938 file/link entries match the final DMG | Same App in signed updater archive and DMG |
| Final Windows installer | NSIS extraction, embedded renderer and runtime checks; 775 Host/CLI files match | Cross-built x64; no native Windows execution or Authenticode |
| Update channels | Pinned keys, signatures, signed versions and embedded configuration verified | Separate Mac/Windows manifests |
| Standalone CLI | Two clean production installs, pack/extract, dependency tree and startup verified | No public npm publication |
| CLI upgrade | 0.1.438 to 0.1.439 preserves identity, controller, network and workspace | Disposable host |
| Real Codex | Text/two-client sync, original-file roundtrip, ASR, question card and stop/resume passed | Paired protocol through packaged Hub/Gateway |

All published assets were downloaded again. Sizes, SHA-256, GitHub digests,
SHA256SUMS and desktop signatures/manifests match the verified local files.
[Artifact evidence](evidence/release-1.0.91-2026-10-18.json).

- [Mac and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.91)
- [Windows and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.91)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.91)

GitHub [Source checks](https://github.com/cloveric/tarobot/actions/runs/39087474939)
executed zero steps because of account billing/spending limits. Local success
does not represent a successful cloud run. The production OAuth/install UI,
Android emulator update, other live engines and physical two-host journeys were
not repeated. iOS source versions were synchronized; no iPhone distribution
signing, TestFlight upload or simulator rebuild was performed for this version
bump. Earlier iOS compilation and remaining native work are in the audit report.

## Local Mac activation

The local update preserves a verified copy of the previous App on the external
disk and takes a private offline state snapshot before replacement. Activation
uses the App-owned host drain/restart path. At publication the automatic
activation is staged and waits for this Bot turn and other active work to finish. Its private receipt checks App/host versions,
host identity, retained record counts and authenticated reconnection after
replacement. This is not an already-completed installation or native-window
interaction claim. No unrelated service or transport fleet is restarted.
