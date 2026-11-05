# TaroBot 1.0.68 — macOS published; mobile and Windows pending

[macOS installer](https://github.com/cloveric/tarobot/releases/tag/v0.1.419-test.1).

This is a **partial platform release**, not a completed three-platform update.
The Mac Apple Silicon installer contains standalone host 0.1.419 and the current
client. Android and Windows installers remain at
[1.0.67](https://github.com/cloveric/tarobot/releases/tag/v0.1.418-test.1).

## Included changes

- Owner-controlled deletion of managed Bots, with confirmation, worker and task
  shutdown, retained history/files and archived direct conversations.
- Long elapsed times use days/hours/minutes; run timers stay current while online,
  narration preserves paragraph breaks, and remote routes tolerate normal jitter.
- Claude native session IDs can be located with bounded metadata reads for resume.
  This changes session lookup, not the native context retained by Claude.
- Connection feedback names the affected host instead of a generic Hub.
- Live replies stop taking over manual scrolling. Process-detail refreshes retain
  the reader's position without writing scrollTop on every update.
- Shared client changes also prepare phone creation-dialog spacing, question
  deduplication and the attachment button beside the microphone. A new phone APK
  is still required to install those phone-side changes.

## Package verification

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `TaroBot-1.0.68-macos-arm64.dmg` | 128,116,991 | `e55af59bf583fca0a2d4422625161dffa85868f8398c26f6c1f8575ae1650387` |

- Final standalone build and complete test gate: **245 files, 3,156 tests passed,
  one skipped**. The authentication lifecycle fixture was updated for the new
  deleted-Bot filter. An inherited production instance override was removed only
  from the test process. A CPU-contention archive timeout passed on focused rerun
  and the final complete gate; no timeout or assertion was relaxed.
- Client translation, TypeScript and production build passed. The preceding
  focused Chromium/WebKit reading, entry and process-refresh regressions are
  documented in [touch reading](touch-reading-2026-10-14.md).
- Both an independent production directory and its extracted npm archive passed
  standalone dependency, Hub startup and served-client checks without a Feishu
  SDK or production credentials. The archive contains 720 files.
- Four isolated native runtime packaging tests passed. The prepared arm64 runtime
  passed the target guard and an authenticated synthetic Bot round trip.
- The final DMG passed hdiutil integrity checks, read-only mounting and strict deep
  signature verification. All **4,857** App files and **4,853** bundled host files
  matched the verified inputs. The mounted package's own Node passed pairing,
  private pipes, Bot creation/reply and restart/name retention in disposable state.
  The final packaged version and launcher icon were verified. The DMG uses the
  normal Applications link without Finder layout automation.
- macOS uses the existing application identifier. The bundle is ad-hoc sealed,
  **not Developer ID signed or Apple-notarized**. No production App was replaced
  or restarted during this publication.

## Unfinished platforms and acceptance

Android version 1.0.68 / versionCode 2026101402 is prepared. Capacitor sync passed;
all 390 non-index frontend assets match the 391-file approved client build.
The HTML index has the established mobile CSP transformation. **No new APK has
been compiled or signed:** the existing Android signer and SDK on the external
volume are inaccessible from the current host until macOS authorization finishes.
Retain the original signer so an update can preserve existing App data.

Windows 1.0.68 is not built or published. Its local cross-build toolchain is on the
same unavailable volume. GitHub Actions cannot provide the alternative build:
[source checks](https://github.com/cloveric/tarobot/actions/runs/38494853937)
were rejected before startup by the account billing/spending limit. No CI success
is claimed.

Physical Android/Windows operation, installed Mac upgrade/Keychain behavior,
production VPS round trips, real Claude continuation and background FCM delivery
were not revalidated by the package smoke test. Phone background notification
configuration remains absent. Update the Bot's host for new server capabilities;
pure phone UI changes require the phone installer, independently of host version.

The release provides SHA256SUMS.txt. Uploaded asset size/state/digest and a fresh
GitHub download are checked against the local DMG before publication.
