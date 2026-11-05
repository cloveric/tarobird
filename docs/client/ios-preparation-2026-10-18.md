# iOS preparation · 2026-10-18

This is the first current-version iOS build preparation, not a TestFlight release.
Client version: **1.0.90**, initial iOS build number: **1**. Host/CLI behavior and
versions are unchanged; the phone uses the existing shared client protocol.

## Changes

- Main App, share extension and Face ID permission prompt display TaroBot.
- Added the local-network permission explanation for authorized LAN hosts.
- Added `ios:doctor`, `ios:build` and release-plan regression checks. Simulator
  builds need no signing account. TestFlight export requires an explicit team
  and build number and verifies the exported IPA before writing a receipt.
- Kept bundle IDs, App Group, keychain identity and URL scheme compatible.
- Both targets receive the client marketing version and the same build number.
  Swift dependency revisions are locked. Builds use fresh frontend/mobile CSP
  assets and refuse a development server URL or a wrong-platform bundle.
- Fixed a real iOS compilation failure in `AttachmentSaverPlugin`: Swift
  inferred `[CAPPluginMethod?]` for an untyped method array, which did not conform
  to `CAPBridgedPlugin`. The explicit `[CAPPluginMethod]` type now compiles.
- Fixed simulator startup being blocked by `device_storage_unavailable`.
  `CODE_SIGNING_ALLOWED=NO` omitted the simulated application identity, and
  securityd rejected the first Keychain read with `errSecMissingEntitlement`
  (`-34018`). Simulator builds now use Xcode's local ad-hoc signing, without an
  Apple account. Distribution signing and the fail-closed Keychain code remain
  unchanged.
- The iOS CI job uses the same build/validation path. This record describes
  local verification, not a new successful GitHub Actions run.

## Verified

- Release-plan tests: **6 passed**, including version/identity/platform mismatch,
  invalid arguments, debug/sandbox distribution entitlements and share-extension
  signing-team rejection.
- Client build and Capacitor iOS sync: passed.
- Full pre-complete gate: **325 files, 4310 passed, 1 skipped**; standalone graph
  and rewritten-history/secret checks passed. An initial run used Homebrew Node
  and correctly hit the frozen-runtime external-library guard. A second run
  with official Node 24 encountered three subprocess timeouts during toolchain
  setup; the 40-test update suite and a subsequent full run both passed.
- iOS core transport on macOS Foundation/Security: passed, including certificate
  binding, real temporary-Hub proof/HTTP, WebSocket, bounded file transfer,
  cancellation and no automatic replay checks. This is not an iPhone receipt.
- Device identity: **73 native core checks**, **3 Node signature cross-checks**
  and Capacitor protocol type-check passed with synthetic stores.
- Swift shared inbox checks: passed (copy/persistence, destination/mentions,
  chunk limits, deletion and retry boundaries).
- Full **Xcode 27.1 (27A9275), iOS Simulator SDK 27.1, Release** compile passed,
  including the main App and share extension. Rebuilding with locked Swift
  package resolution also passed. Packaged App metadata, privacy manifests and
  mobile CSP checks passed. No paid account was required for this compile.
- The complete `ios:build` pipeline passed again after the simulator-signing
  correction. Both final App and share-extension signatures passed local
  `codesign --verify --deep --strict`; the final App was installed and launched
  in the simulator. The six release-plan checks passed again.

## Simulator smoke checks

After explicit approval, the test device used temporary internal storage.
Creating it on the external drive had failed with `NSCocoaErrorDomain 513` /
`Operation not permitted`. The installed test runtime was iOS 27.1 (24A94232),
with an iPhone Duo simulator; this is not a physical iPhone or iPad receipt.

The original unsigned bundle reproduced the Keychain error above. After the
ad-hoc-signing correction, the installed Release App passed these observed
native-interface checks:

- First launch reaches the white/purple host-connection screen.
- QR-image import panel opens and closes.
- Manual connection fields expand and the page scrolls to the submit button.
- Empty submission shows the missing-route validation message.
- The layout renders in the simulator's closed and open configurations.
- Terminating and cold-launching the App returns to the connection screen.

No real host was paired, and no production host state was changed. The runtime
registry reported Ready/Verified and booted, but the separate `runtime verify`
command emitted a sealed-resource error. That environment warning remains
unresolved; the observations above do not certify the simulator installation.
The task's test device and runtime were removed after verification. Xcode,
source, build output and the retained runtime download remain on external
storage.

## Remaining release gates

- GitHub source/secret-check jobs for this change did not start: Actions
  reported an account payment/spending-limit blocker. Local regression and
  secret/history checks passed; they are not a remote CI pass.
- A paid Apple Developer Program membership and a matching developer team are
  not configured. No valid local signing identity was present at preparation.
- Signed device archive/export, App Store Connect processing and TestFlight
  delivery have not been verified. There is no installable iPhone IPA receipt.
- Physical iPhone/iPad pairing, permissions, share/save, background/locked-screen
  production APNs, notification routing and upgrade acceptance remain required.
- Swift 6.4 emits existing nested weak-capture warnings in transport code; these
  are warnings in Swift 5 mode and were not changed without a reproduced defect.

See [build instructions and device checklist](ios-build.md). Never describe a
simulator compile or an exported archive as a physical-device or TestFlight pass.

## Independent-audit rebuild

After the [DeepSeek/Opus audit repairs](../independent-audit-2026-10-18.md), the
complete simulator build passed again with Xcode/SDK 27.1, including the updated
client and visible share-extension labels. Strict signature verification passed
for the main App and embedded extension. Both final arm64 and x86_64 binaries
contain the expected matching App Group and simulated application identities in
their Mach-O `__TEXT/__entitlements` sections. Simulator rights are embedded there;
an empty device-signature entitlement dictionary alone does not indicate failure.

This rebuild used external build storage and did not create or launch a new
simulator device. The current signing doctor reports zero valid local signing
identities. No distribution archive, iPhone installation or TestFlight upload was
performed; those still require the appropriate account, team and provisioning.
