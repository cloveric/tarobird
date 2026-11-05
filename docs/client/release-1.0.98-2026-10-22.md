# TaroBot 1.0.98 release evidence — 2026-10-22

## Source and compatibility

Source: `1d31656aa1f7f52b3e3345445f2717f4de275e66` on `main`.
App 1.0.98, Host/CLI 0.1.446, wire protocol 1, Hub schema 21; update input schema range 1–21. Android versionCode 2026102201. iOS App and share extension both 1.0.98, build 1.

This release includes the previously merged queue, composer, pinned folders, parallel group replies, voice settings/cache, visual replies/switch, fixed JSON reports, Worker containment and capacity-message fixes. The headless CLI shares the Host APIs and runtime; composer layout is presentation-only. No retired Telegram/Lark SDK is included.

## Local gates

- Root and client clean dependency installation passed.
- Standalone build: 414 modules; no retired transport or Feishu SDK.
- Vitest: 426 files; 5,846 passed, 5 skipped.
- Client production build passed.
- Initial full pre-complete invocation reached Rust but stopped because the fresh worktree had no `client/src-tauri/host` resource. After the normal `prepare-desktop-host` step, `cargo test --locked` passed 71 unit and 6 integration tests. The original all-in-one invocation is not recorded as a clean pass.
- CLI clean directory install and reinstalled `.tgz` both started an isolated Hub and served client assets. Host upgrade 0.1.445 → 0.1.446 preserved host identity, controller identity, network membership and workspace content; no OS service or production Host was replaced.
- Final extracted CLI package completed six real Codex paths: paired protocol sync, recorded immutable file changes, byte-preserving file return, real local ASR, question-card submit/resume, stream stop/resume and context retention. These are protocol/engine checks, not physical phone acceptance. Other live providers were not rerun for this version-only release.
- Windows final NSIS extraction: 863 compiled Host/CLI files match the canonical standalone package; exact embedded renderer, PE runtime dependencies, selected icons and pinned updater signature pass. No Authenticode signature and no native Windows execution claim.
- Android: build, 39 unit tests and lint (0 errors, 19 warnings) passed. Final APK retains the 1.0.97 signer, is not debuggable, passes alignment/icons and matches all 446 frontend files after the intentional mobile CSP transform. No physical phone installation claim.
- iOS: six release-plan tests and the Xcode 27.1 ad-hoc-signed Simulator build passed. Main App/share metadata, privacy files and mobile CSP verified. All 446 frontend files match the canonical client build; Capacitor only rewrote equivalent local SPM dependency paths in the isolated build copy.
- iPhoneOS device-SDK Release compilation also passed for App/share version 1.0.98, build 1, with distribution signing disabled. Both native bundle metadata records, privacy manifests, mobile CSP and all 448 generated public assets match the prepared Capacitor source. This is compilation/artifact evidence, not an IPA export or physical iPhone acceptance.
- The subsequent Apple Distribution archive and App Store Connect IPA export passed. Both exported bundles pass strict signature checks, match the intended distribution certificate and carry the exact shared App Group; the main App has production APNs and neither target allows debugging. Embedded profiles, metadata, privacy manifests, mobile CSP and all 448 public assets were checked in the actual IPA. Apple `altool` upload validation returned `VERIFY SUCCEEDED` with no errors. These checks do not establish physical iPhone acceptance.
- macOS: the complete App, bundled Node and both native addons are now Developer ID signed with secure timestamps and hardened runtime. Strict recursive signature verification passes. Node receives the JIT entitlement; the App receives camera/audio-input entitlements; debugging and library-validation exceptions are absent. The signed bundled Node passes SQLite, Canvas PNG, JIT and WebAssembly execution checks and reports Host/CLI 0.1.446. Canonical Host/CLI files, embedded renderer and selected release icons match. These headless checks do not establish visible-window or permission-dialog acceptance.
- Native macOS updater acceptance passed on an external-volume App copy with synthetic state: rejects a tampered archive, installs the signed 1.0.98 bundle, restarts Host 0.1.446 and preserves identity, pairing, chat and files. The first manually produced BSD tar archive contained AppleDouble metadata and failed extraction; rollback restored the test Host and data. Repacking with `COPYFILE_DISABLE=1` and `tar --no-xattrs --no-acls` passed. An intermediate fixture path exceeded the local-control socket length limit; the successful fixture uses a short path. This test used the signed App before notarization/stapling; the final distribution archives were verified separately below.
- Final macOS package verification subsequently passed after Apple accepted both the App and DMG notarization submissions. Both tickets are stapled and validated; Gatekeeper accepts the DMG and the App from both the mounted DMG and extracted updater archive. All 5,030 file/link entries, including file bytes and modes, match the signed source App. The final updater has no AppleDouble entries and passes the pinned updater signature/version check. Icons, App 1.0.98, Host 0.1.446 and the Applications link pass. The first verification mount under the external build directory was denied by macOS; a read-only randomized mount under the supported `/Volumes` location succeeded and was detached. No installed App was changed.

## Apple distribution and remaining device checks

The Computer Use bridge returned `Native pipe startup failed`; Apple account setup continued through owner-supplied signing files, portal actions on another computer and the authenticated API. The Developer ID Application certificate matches the prepared private key. Apple accepted the signed Mac App and the final signed DMG on 2026-10-22; final stapling, packaging and Gatekeeper checks passed. The DMG, signed updater and matching CLI have been published to GitHub and downloaded again for verification.

The original Developer team API key could read lists but received HTTP 403 when creating signing assets. The subsequently supplied Admin team API key successfully created an Apple Distribution certificate and both existing native Bundle IDs (`com.tarocub.client`, `com.tarocub.client.share`); the certificate matches its prepared private key and passes local trust verification. App Groups is enabled for both IDs, and Push Notifications for the main App.

The owner created the App Store Connect record and associated `group.com.tarocub.client` with both Bundle IDs. API read-back confirmed the App record. The old profiles became invalid after the capability change; new active App Store profiles were generated and decoded, and both contain the exact shared group, matching certificate and correct distribution entitlements. Manual signing settings were applied only in the isolated packaging copy, preserving the frozen release source. Private keys, account identifiers, profiles and raw signing/API logs remain outside the repository.

Apple accepted the complete verified IPA upload with no errors. Processing completed with `VALID`; after the encryption declaration and Chinese test notes were supplied, build 1.0.98 (1) was added to the internal TestFlight group. API read-back at 2026-10-22 07:21 UTC confirmed `IN_BETA_TESTING`, one invited owner account and no public testing link. The tester's state is `INVITED`, not installed or tested. No public App Store submission has been made.

The build's non-exempt-encryption flag is false, based on the shipped client using OS TLS/Keychain/CryptoKit, signature verification and hashes, and document-preview decryption. This does not mean the App uses no cryptography. References: [Apple encryption declaration guidance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations) and [BIS authentication/signature distinctions](https://media.bis.gov/learn-support/encryption-controls/cryptography-for-data-confidentiality).

The installed local Mac App and production Host were not updated, replaced or restarted. After publication, the installed App still reports 1.0.97. Native visible-window widget containment remains open in [#60](https://github.com/cloveric/tarobot/issues/60), now also tracking default report templates and later page collaboration. Physical Windows/phone and Tailscale network checks remain separate.

## CI

Both [Source checks](https://github.com/cloveric/tarobot/actions/runs/39728564833) and [Secret scanning](https://github.com/cloveric/tarobot/actions/runs/39728564843) did not start because GitHub reports failed account payments or the spending limit. Local checks do not make these CI jobs green.

## Artifacts

| File | Bytes | SHA-256 |
|---|---:|---|
| TaroBot-1.0.98-windows-x64-setup.exe | 98136233 | b6861ef014aeb55f3fd9773dfd65a7eb0d2116a4a0395fe94fe00addb073ae0e |
| TaroBot-1.0.98-android.apk | 36680078 | f637e1bad4622191c8f0b6799d33e9981005e109b2e75904644ec48978faf055 |
| tarobot-0.1.446.tgz | 26245031 | 05698a5186647d5c9e44c57f6a4b3d07bcbe0994f2a3608b6ff65576b4db9b23 |
| App.ipa (iOS 1.0.98, build 1) | 28604157 | 461f7f1fe2a0b3e236ab78a3b887217d8ded087812b880a4a9efe5c7ab50f6dc |
| TaroBot-1.0.98-macos-arm64.dmg | 130718695 | a0ff1dc5057d7749ad9b999e4d045efd41879814edd65de20737cd4f9ffbfa00 |
| TaroBot.app.tar.gz | 129454887 | ff2ee31ec91003183a950756f940927dfd8da31d6c238f67fe4f4a5c9513e14f |
| TaroBot.app.tar.gz.sig | 424 | 45fcc2f1838396df831c210e4f8e519fd8b683a5e71cc24fb46166e24b59f585 |

Published [Windows 1.0.98](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.98) and [Android 1.0.98](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.98), each with CLI 0.1.446. All uploaded assets were downloaded again and matched local bytes, GitHub digests and `SHA256SUMS`. The downloaded Windows installer also passed pinned updater signature/version and manifest asset-URL checks. Both tags target the source commit above. These releases do not install or update the local Mac App.

Published [macOS 1.0.98](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.98), including the notarized ARM64 DMG, signed updater archive/signature, `macos-latest.json`, `SHA256SUMS` and CLI 0.1.446. All six published files were downloaded again and matched local bytes, GitHub digests and the checksum manifest. The downloaded updater passes the pinned signature/version check, its manifest points to the verified GitHub asset, and the release tag identifies the source commit above.

iOS 1.0.98 (1) is available to the invited internal TestFlight tester as recorded above. No public App Store submission or physical iPhone acceptance is claimed.
