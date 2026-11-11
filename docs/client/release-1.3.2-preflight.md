# TaroBird 1.3.2 plan — cancelled before publication

The owner subsequently selected a corrected 1.3.1 release and Android asset
replacement. No 1.3.2 package was published. See the current
[1.3.1 plan](release-1.3.1-preflight.md); the text below is historical planning.

The owner authorized a unified macOS, Windows, Android and iOS 1.3.2 release on
2026-11-11 after a build-provenance error was identified during 1.3.1 packaging.
The standalone and bundled Host/CLI also use 1.3.2.

## Scope and correction

The product changes are the mobile composer, iOS keyboard-following pacing and
navigation spacing described in the [1.3.1 plan](release-1.3.1-preflight.md).
No new feature, dependency upgrade, schema/protocol change or identity migration
is included. The dependency locks retain the resolutions of 1.3.0; product
version fields alone advance. Android uses build code 2026110408 and iOS build 1.

The initial 1.3.1 build reused an installed dependency directory that did not
match the frozen lockfiles. Comparing the lockfiles against the baseline did
not catch installed-tree drift. Native mobile UI checks passed, but did not
validate this separate provenance requirement. Android 1.3.1 was already
published and iOS 1.3.1 (1) uploaded; neither is replaced with different bytes.
Desktop 1.3.1 candidates are not published.

For 1.3.2, install root and client dependencies afresh with npm ci from the exact
frozen manifests and locks, with Electron binary download disabled during npm
installation. Verify installed package versions against the lock; packaging
uses the separately checksum-verified pinned Electron runtime. Retain receipts
for the exact source, input lock hashes and final signed package bytes.

## Validation and publication boundaries

Rerun the affected viewport/composer/layout tests using the verified dependency
tree. Build all four platforms, launch the corrected mobile packages in native
simulator/emulator environments, and verify connection, queue and keyboard/draft
flows. Physical-device acceptance remains separate. Do not claim that this
retrospectively validates the Android 1.3.0 dependency upgrade.

Fresh package checks, signatures, notarization, unpacked privacy scans and
public download readback are required. Verify 1.3.0 to 1.3.2 update selection and
signed version binding. Preserve the owner's installed Mac for their own
in-app upgrade test. Existing releases retain their original bytes.

Check security advisories for shipped dependencies without upgrading them.
Inherited evidence applies only to unchanged Host, integrated skills and native
behavior, and must be labelled as inherited. GitHub release notes are English;
iOS delivery uses the existing TestFlight groups, with no App Store submission.
