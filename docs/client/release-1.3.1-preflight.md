# TaroBird 1.3.1 mobile scoped patch

This initial plan was superseded by the owner-authorized
[1.3.2 corrected rebuild](release-1.3.2-preflight.md). Android 1.3.1 was published
and iOS 1.3.1 (1) was uploaded before a reused build dependency directory was
found to differ from its lockfile. Those artifacts are not overwritten; desktop
1.3.1 candidates were withheld. The native UI checks below do not establish
lockfile-consistent build provenance.

The owner authorized an iOS/Android-only small release on 2026-11-11.
The published baseline is `7765ef35a9b27edffa3556524bf06897cda456d8` (1.3.0);
the reviewed product revision is `79329747f057f819de4b104373c9e38a0ddd642a`.

## Scope

- Ordinary phone composer: share one row for the queued-message count and send
  mode, with theme accents, 44-pixel touch targets and Chinese/English layouts.
- iOS: improve keyboard-following pacing and bottom-navigation spacing.
- Keep Codex's default queued mode and existing send/stop/steer semantics.
- Publish Android 1.3.1, build code 2026110407, and iOS TestFlight 1.3.1 (1).
  macOS, Windows and standalone CLI channels remain unchanged. CLI is not
  applicable because the patch changes mobile presentation only.

Dependency resolution, vendor content, native implementation, Host behavior,
protocol/schema, updater and signing identities remain unchanged from 1.3.0.
Product-version fields are synchronized; lockfile changes only update the local
product version. No ordinary dependencies or integrated products are upgraded.
The pending Android 1.3.0 dependency decision remains documented in
[its release record](../releases/1.3.0-verification.md).

## Security review and inherited evidence

Before freeze, the client production npm audit reported zero matched advisories.
OSV checks of 138 resolved Maven runtime components and the two pinned Swift
packages reported no matched advisories on 2026-11-11. Capacitor 8.6.0 is outside
the affected versions in upstream advisory GHSA-rvm3-566m-v7fv. Electron is not
shipped in these mobile packages. This is a check-only advisory review, not a
claim that unknown vulnerabilities cannot exist.

Unchanged dependency and native behavior evidence is inherited from 1.3.0;
its previously recorded Android runtime gap is not relabelled as a pass.
[Phone composer validation](phone-send-mode-row-2026-11-11.md) and the
associated keyboard/navigation regression records describe the source changes.
Fresh package signatures, privacy scans and downloaded-byte checks are required.

## Validation boundary

Run the affected viewport, phone queue, keyboard-motion and layout-density
regressions; fresh client/native builds; native simulator/emulator startup and
relevant UI flows. Native push and updater code are unchanged. A browser viewport
check is separate from native runtime acceptance and physical-device testing.

Publication receipts must bind the final source, signed bytes and platform build
counters. TestFlight upload, Apple processing, external beta approval and a
physical iPhone installation are separate states. No App Store submission is
part of this release.
