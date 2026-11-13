# TaroBird 1.4.1 patch preflight

The owner requested publication of the fixes made since 1.4.0, with one canonical
English download page and the existing platform updater channels. All platforms
are included. Windows publication may proceed after package/signature/privacy
checks without waiting for lengthy additional native acceptance. Record that
validation limit rather than treating it as a passed Windows runtime test.
No installed owner App replacement or App Store submission is authorized.

Baseline: 1.4.0, source `42f2fda9dd1b272847268d9b4e0757ba0b5dff7c`.
The delta is limited to first-launch system-language selection, mobile pairing
feedback and malformed-address recovery, video attachment visibility and clearer
local draft-save warnings in Chinese and English. The iOS native change adds
localized permission descriptions and Xcode resource registration. No native
library, dependency resolution, integrated editor/skill, protocol, updater,
signing identity or storage limit changes are included.

This patch retains unchanged dependency and editor pins. Installed dependency
versions are checked against both lockfiles, with the previous isolated npm-ci
provenance retained. A fresh advisory review covers npm production dependencies,
Electron and the shipped Cargo/vendor inventory; this check does not upgrade
packages. The previous three Rust informational unmaintained notices are
unchanged. Previously reviewed editor worker restrictions remain unchanged.

The delta's source and privacy CI passed before version preparation. Fresh
version-bound checks passed 13 language unit cases and 26 paired-browser UI
cases, plus Host/client builds, type checking and translation validation. Earlier
paired-browser and local storage regressions are recorded in the linked change
notes. Fresh release checks, signed-package inventories, simulator/emulator
observations, exact artifact privacy scans and downloaded-byte verification are
recorded separately in release receipts. Historical evidence does not certify
newly built artifacts. Physical-phone and Windows native acceptance must not be
inferred from Chromium or cross-platform packaging checks.

The CLI APIs and Host implementation are unchanged by these client-only fixes.
The bundled and standalone Host are still rebuilt from the same version/source;
clean installation and prior-package upgrade are checked without replacing a
production Host. The existing editor reentry/second-Send limitation and incomplete
paired WebKit acceptance remain disclosed; this patch does not claim to fix them.

Related changes: [pairing feedback](mobile-pairing-feedback-2026-11-13.md) and
[video draft feedback](mobile-video-draft-feedback-2026-11-13.md).
