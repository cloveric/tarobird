# macOS development bundles

Current full-host packages target `arm64` (Apple Silicon). They include a matching
Node runtime and SQLite addon; Intel/universal host runtimes have not been
prepared or validated. The universal results later in this document are
historical companion-client evidence, not current full-host build instructions.
The App is built in Cargo's optimized release profile; this is a compiler
profile, not permission to publish a product release. A local ad-hoc signature
seals the development bundle without an account or certificate. Developer ID signing,
notarization, update-feed signing and distribution remain separate release gates.

## Build locally

The host needs Apple's macOS SDK/command-line tools, Rust and the repository's
locked Node dependencies. Full Xcode is not required for this macOS build; iOS
still needs it. Install the matching Rust standard-library target:

```sh
rustup target add aarch64-apple-darwin
```

From the repository root:

```sh
npm run desktop:build --prefix client -- \
  --target aarch64-apple-darwin --bundles app,dmg --ci --no-sign -- --locked
```

Then seal and repackage the development app, from `client/`:

```sh
npx tauri bundle --target aarch64-apple-darwin --bundles app,dmg --ci \
  --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
```

Use a development build environment without `APPLE_*` and `TAURI_SIGNING_*`
credentials. Keep the same `CARGO_TARGET_DIR` for both commands. The first
command skips signing; the second adds only the local ad-hoc integrity seal.
Neither command configures an update endpoint, installs the app or touches the
Hub and Bot services. The Tauri build includes the current frontend build; do
not run browser acceptance concurrently with that frontend rebuild.

On the owner's Mac, use the mounted disk for builds and release output by default:

```sh
export CARGO_HOME=/Volumes/gdrive/dev-cache/tarobot-release-cargo
export CARGO_TARGET_DIR=/Volumes/gdrive/dev-cache/tarobot-release-target
export npm_config_cache=/Volumes/gdrive/dev-cache/tarobot-npm-cache
```

Keep checkouts under `/Volumes/gdrive/projects` and installers, downloaded
verification copies and temporary acceptance files under `/Volumes/gdrive/taro-tmp`.
Verify the volume is mounted and writable before building; resolve unavailable
disk access instead of silently filling the internal disk. Installed applications
and active host data retain their supported paths. Only installation staging that
requires a same-volume atomic rename should remain temporarily on the internal disk.

On other machines, select a writable cache on a sufficiently spacious disk.
Bundle paths are relative to `CARGO_TARGET_DIR`, otherwise to `client/src-tauri/target/`:

- `aarch64-apple-darwin/release/bundle/macos/TaroBot.app`
- `aarch64-apple-darwin/release/bundle/dmg/TaroBot_<version>_aarch64.dmg`

`desktop:prepare` replaces the shared `client/src-tauri/host` directory. Finish
one platform's package and verification before preparing another platform.
The build gate checks the runtime receipt, actual Node/addon architecture and
required Hub/frontend files. See [runtime packaging audit](desktop-runtime-gate-2026-10-14.md).

Before handing off a bundle, inspect the main executable with `lipo -archs` and
`file`, verify the sealed app with `codesign --verify --deep --strict
--all-architectures`, verify the DMG with `hdiutil verify`, mount it read-only and check the
embedded executable matches the standalone app, then record the DMG SHA-256.
Compilation alone does not prove native startup, pairing, file dialogs or
cross-device behavior. Apple Silicon execution also does not certify an Intel
Mac; both architectures need their own runtime checks.

## Performance acceptance

The original plan requires cold launch below 1.5 seconds and resident memory
below 200 MB. Measure the optimized bundle's visible, usable app state; a browser
page load or the return time of `open` is not native cold-start evidence. Include
the app's WebView processes in memory accounting. A main-process-only `ps` or
`footprint` measurement cannot prove the complete application budget. Report the
machine, app state, sample count and measurement boundary with each result.

## Current evidence

The latest `20261011-r33` development DMG includes [bounded Markdown recovery](markdown-recovery-2026-10-11.md),
owner failure isolation, bulk recovery of mounted latest history and all r32
features. Actual Opus 5.5 xhigh review led to reproduced corrections; Astra
reviewed the final changes. Chromium/WebKit each passed 67 related cases,
including the actual built-App/Hub desktop and phone layouts; separate heap and
streaming checks passed. Both optimized architectures, strict ad-hoc seals,
DMG integrity, read-only full-bundle equality, exclusive Downloads copy and 303
frontend resources in both phone shells were verified. See r33 receipt（本地材料：`evidence/macos-r33-2026-10-11.json`）.
Bytes: 17,073,355; SHA-256 `dbd444fef569b22a7cf5be0c4ceb844c95491b5607c5f07fc16fbfbfa460689e`.
Not installed, notarized or published. Matching Hub required; native UI,
RSS/cold-launch, mobile SDK/device and production acceptance remain open.

The earlier `20261011-r32` development DMG includes the [Markdown retained-memory
optimization](markdown-memory-2026-10-11.md) and all r31 corrections. Opus 5.5
xhigh and Astra reviewed the production source. Chromium/WebKit each passed
52 distinct related cases; separate Chromium heap and built-App streaming
checks passed. Both optimized architectures, strict ad-hoc seals, DMG integrity,
read-only full-bundle comparison, exclusive Downloads copy and all 303 frontend
resources in both mobile shells were verified. See the r32 receipt（本地材料：`evidence/macos-r32-2026-10-11.json`）.
It is 17,071,849 bytes, SHA-256
`78773ab19394727bfade6e913939d536bfad48b0dad455b2a0c4c3d37df28468`.
This development package was not installed, notarized or published and requires
the matching Hub. Native UI, RSS/cold-launch and physical-phone acceptance are
still open; shell resource copies are not mobile SDK builds.

The earlier `20261011-r31` development DMG includes the subsequent storage,
history-refresh, send-continuity and [outbox/scroll fixes](outbox-refresh-2026-10-11.md),
including the completed Opus/Astra review corrections and delayed-Markdown
reading-anchor fix. It supersedes r30, which predates those last corrections.
Both optimized CPU architectures, strict ad-hoc signatures, DMG integrity,
read-only complete bundle comparison and the exclusive Downloads copy passed.
All 303 final frontend resources match both mobile shell copies. Source inputs
were unchanged during packaging and match the tested source. See the
r31 receipt（本地材料：`evidence/macos-r31-2026-10-11.json`）. The Mac was locked, so this
package has not received new ordinary native UI, RSS or cold-start acceptance.
It was not installed, notarized or published and requires the matching Hub;
phone resources were copied, not compiled or installed on devices.

The earlier `20261011-r29` development DMG includes finished-recording lifecycle,
system-share draft recovery and optional-shortcut fixes. Its ordinary native
App was exercised for manual loopback pairing, synthetic streamed chat and
revocation. Both architectures, ad-hoc seals, DMG integrity and mobile resource
copies were verified. See the r29 receipt（本地材料：`evidence/macos-r29-2026-10-11.json`）
and [native product scope](native-product-2026-10-11.md). Subsequent
[storage allocation fixes](storage-performance-2026-10-11.md) and
[serialized history refresh](message-refresh-performance-2026-10-11.md), and
[message send continuity](message-send-continuity-2026-10-11.md) are
not included in r29; they are now packaged in r30. Native performance and mobile/release
gates remain open.

The earlier `20261006-r28` development DMG adds complete local conversation drafts,
Skills/MCP filters and configuration-message handoff, and the phone pending-question
and approval inbox. It includes the final Opus review fixes (draft revalidation, active-only draft
limits, key rotation, recording during steering, landscape layout and capability
dialog recovery) as well as preceding device-settings and conversation receipt fixes.
It supersedes the interim r27 build. Both CPU architectures, strict ad-hoc seals, DMG integrity, read-only
bundle comparison and exclusive Downloads copy passed. All 303 final frontend files
match both mobile shell copies. See the r28 receipt（本地材料：`evidence/macos-r28-2026-10-06.json`）
and [alignment changes and validation boundaries](grok-alignment-2026-10-06.md).
The package was not installed, notarized or published; it requires the matching Hub.
Browser acceptance does not close native phone, packaged UI or performance gates.


The earlier `20261005-r26` development DMG packages the native pinned Rust
HTTP/WebSocket transport, independent trusted-key pairing, and localized
verification/reconnect guidance. Public-key pastes preserve whitespace-wrapped
keys and reject malformed input before networking. It retains the r25 phone
interaction changes. Both architectures, strict ad-hoc seals, DMG integrity,
read-only full-bundle comparison, exclusive Downloads copy and all 303 frontend
files in both mobile shell copies were verified. See the r26 receipt（本地材料：`evidence/macos-r26-2026-10-05.json`）
and [connection feedback, Opus review and validation limits](connection-feedback-2026-10-05.md).
The package requires a matching Hub with `/api/tls-identity`; it does not bundle
or update the service. Isolated native WebView transport checks passed, but the
packaged App has not been installed or accepted through the complete product UI.
Phone compilation/device acceptance, native performance, production signing and
deployment remain open. No application-layer E2EE was added.

The earlier `20261005-r25` development DMG includes the phone Camera / Photos /
Files menu, touch-hold message actions, partial text selection and direct file
preview without a visible Open label. It retains the keyboard-aware layout,
PDF reader, download recovery and prior visual refinements. Both CPU
architectures, strict ad-hoc seals, DMG integrity, read-only full-bundle comparison
and the exclusive Downloads copy passed verification. All 303 frontend files
match the accepted browser build and both mobile shell copies. See the
r25 receipt（本地材料：`evidence/macos-r25-2026-10-05.json`）,
[attachment menu](attachment-menu-2026-10-05.md) and
[hold/quote acceptance](message-hold-2026-10-05.md). This package was not installed,
notarized or published, and does not bundle the Hub service. Native runtime,
physical mobile gestures, startup/memory budgets and matching Hub deployment
remain separate gates. Mobile resources were copied, not compiled.

A subsequent [active-relay audit](tls-identity-2026-10-05.md) reproduced an open
security gap when a proxy holds another trusted same-host certificate. The new
Hub proof endpoint is not enforced by r25. Native pinned transport and secure
pairing remain release blockers; this package is not evidence of their completion.

The earlier `20261005-r16` development DMG includes the keyboard-aware phone
layout, registered mobile Keyboard plugin resources, bounded pairing scrolling,
commit-based conversation focus and proportional Bot avatars. Both CPU
architectures, strict ad-hoc signatures, a read-only mounted bundle comparison,
DMG integrity and the exclusive Downloads copy passed verification. All 303
frontend files match the accepted browser build and both mobile shells. See the
r16 receipt（本地材料：`evidence/macos-r16-2026-10-05.json`） and
[viewport QA](keyboard-qa-2026-10-05.md). The application was not installed,
notarized or published; mobile shells were copied, not compiled. Physical-device
keyboard and native runtime acceptance remain open, as does matching Hub deployment.

The earlier `20261005-r15` development DMG includes the local PDF reader,
bundled parser support files and drag-selection dismissal fix, designed with
actual Opus 5.5 xhigh and verified in Chromium/WebKit. Both architectures,
strict ad-hoc seals, DMG integrity, mounted bundle and delivered copy passed.
All 302 frontend files match the accepted browser build and both mobile shell
resource copies. Receipt（本地材料：`evidence/macos-r15-2026-10-05.json`） and
[rendered acceptance / limits](pdf-preview-qa-2026-10-05.md). Native custom
protocols, old WebViews, physical mobile gestures and runtime acceptance of
this package remain open. No installed app, deployed Hub or fleet changed.

The previous `20261005-r14` development DMG includes the
[Opus-led file-action refinement](file-actions-qa-2026-10-05.md), small-phone
filename/action rows, 44px preview retry controls and explicit opener-focus
restoration. Both optimized architectures compiled; strict ad-hoc seals,
DMG verification, read-only full-bundle comparison and exclusive Downloads-copy
hashes passed. All 99 frontend resources match the accepted build and both
phone-shell copies. See the r14 receipt（本地材料：`evidence/macos-r14-2026-10-05.json`）.
r13 is superseded because it preceded the last opener-focus correction.
The Mac was locked; this does not establish native startup, dialogs or device
acceptance. The installed app and Hub were not replaced, and no release was
published or notarized.

The earlier `20261004-r12` development DMG adds the
[desktop save-integrity fix](desktop-export-2026-10-04.md): confirmed-count
partial-write recovery, useful native save errors and safe Unicode name limits.
Both optimized architectures compiled; strict ad-hoc seals, DMG integrity,
read-only full-bundle comparison and exclusive Downloads-copy hashes passed.
All 99 frontend resources match the accepted build and both phone-shell copies.
See the r12 receipt（本地材料：`evidence/macos-r12-2026-10-04.json`）. The Mac remained locked:
there is no new native-window, save-dialog or cold-start/memory acceptance.
The installed app and Hub were not replaced; this is not a notarized release.

The earlier `20261004-r11` development DMG packages the phone message-action
sheet, settings hierarchy, collaboration label, rotation/route guards and lazy
chat startup. Both optimized architectures compiled. Strict all-architecture
ad-hoc seal checks, DMG verification, read-only mounted full-bundle comparison
and the exclusive Downloads copy hash passed. All 99 frontend files match the
accepted build and both phone-shell resource copies. See the
r11 receipt（本地材料：`evidence/macos-r11-2026-10-04.json`） and
[settings/startup QA](settings-nav-qa-2026-10-04.md).
The package is not installed, notarized or published, and does not bundle Hub.
Native runtime and physical mobile acceptance were not performed for this build.

The earlier `20261004-r10` development DMG packages the Opus 5.5 visual refinement:
reading/navigation surfaces, typography, avatars, phone composer and bottom-sheet
motion, including the parent's avatar-contrast correction. Both optimized
architectures compile; standalone and read-only mounted app seals, all bundle
files, DMG integrity, Applications link and exclusive Downloads copy match.
All 97 frontend files match the browser-accepted production build and the copied
iOS/Android web resources. See r10 receipt（本地材料：`evidence/macos-r10-2026-10-04.json`）
and [visual QA](../../design-qa.md). This does not replace the installed app or
bundle the Hub. The Mac is still locked, so native window interaction and native
cold-start/memory budgets remain unverified. This is an ad-hoc sealed development
bundle, not a notarized release, APK or IPA.

Post-package production-frontend checks passed: Chromium three cases (5,000-line
stream, five fresh contexts, and offline Markdown worker); WebKit two startup /
offline cases. Frame P95 was 16.7ms and the maximum 33.4ms, with no observed long
tasks. These measurements describe the browser rendering path only. They do not
close the native startup/memory budgets above. Metrics and log hashes are in the
r10 receipt.

The earlier `20261004-r9` development DMG adds the Opus-reviewed phone question
focus fix. Chromium/WebKit each passed 14 targeted cases, and real Codex native
forms passed on the final frontend. Both optimized architectures compiled;
strict ad-hoc signature verification, read-only mounted bundle comparison, DMG
integrity and the exclusive Downloads copy hash passed. All 97 frontend files
match the accepted browser input and both mobile shells. See the
r9 receipt（本地材料：`evidence/macos-r9-2026-10-04.json`） and
[real-CLI phone debugging](live-mobile-2026-10-04.md). This is not native runtime,
APK/IPA, notarization or production-release acceptance. The Mac remains locked;
the installed app, live Hub and Bot fleet were not replaced or restarted.

The earlier `20261004-r8` development DMG packages the then-current full-regression
frontend: per-host/offline Bot names, lazy phone home and the WebKit measurement
fix. Both optimized architectures compiled. Standalone and read-only mounted
apps passed strict all-architecture ad-hoc signature verification; every bundle
file, the Applications link, DMG integrity and exclusive Downloads copy were
verified. All 97 frontend files match the browser-accepted build and both mobile
shells. See the r8 receipt（本地材料：`evidence/macos-r8-2026-10-04.json`）.
The current OS session remains locked, so native interaction and performance
have not been reaccepted. No installed app, live Hub or fleet was restarted.
The app is not notarized or published and needs matching Hub code.


The earlier `20261004-r7` development DMG packages the then-current multi-host UI,
mobile IM navigation, settings, share/notification client logic and the
Opus-reviewed mobile fixes. Both architectures compiled in the optimized
profile. Strict ad-hoc signatures, read-only mounted bundle comparison, DMG
verification and the exclusive Downloads copy hash passed. All 95 frontend
files exactly match the 2026-10-04 mobile debugging browser inputs and both
mobile shells' copied resources. See the r7 receipt（本地材料：`evidence/macos-r7-2026-10-04.json`）.
The existing running debug app was not replaced or restarted. Current native
window inspection was blocked by the locked Mac; an unlock request is pending.
This artifact is not notarized or published and requires matching updated Hub
code. It does not provide an APK, iOS app or physical-device acceptance.

On 2026-10-03, both architectures compiled, the locally sealed app passed strict
all-architecture signature verification, and the DMG passed image verification.
Its read-only mounted app matches every file in the standalone bundle, including
the signature seal. The checksum and source-input hashes are in the
build receipt（本地材料：`evidence/macos-universal-2026-10-03.json`）. The Mac was locked, so
new native launch/interaction and performance acceptance were not performed.

The subsequent dashboard performance update is included in the `20261003-r2`
development DMG. Both architectures were rebuilt; strict signatures, read-only
mount comparison and the Downloads copy hash passed again. The
updated receipt（本地材料：`evidence/macos-dashboard-scale-2026-10-03.json`） identifies the
frontend and artifact at that milestone. It retains the same pending native-runtime and
production-distribution boundaries.

The question-draft recovery update is included in the newer `20261003-r3`
development DMG. Both architectures compiled again; strict signature checks on
the standalone and read-only mounted apps, file-for-file comparison, DMG image
verification and the Downloads copy hash passed. All 95 frontend input files also
match both mobile shells' copied assets. The current
question-draft receipt（本地材料：`evidence/question-drafts-2026-10-03.json`） records the source and artifact
hashes, including the initial root-test timeout and successful rechecks. Native
runtime, performance, notarization and production distribution remain unverified.

The `20261003-r4` development DMG adds paged history search. Universal
compilation, strict ad-hoc signature verification on standalone/mounted apps,
file comparison, image verification and the Downloads checksum passed. Both
mobile asset copies match all 95 web files. The
search receipt（本地材料：`evidence/search-pages-2026-10-03.json`） records the new artifact
and source hashes. This shell requires matching updated Hub code for paged
search; it does not bundle or deploy the Hub. The same native-runtime and
production-distribution gates remain open.

The `20261003-r5` development DMG includes the current frontend, including
signed offline-revocation recovery and resumable downloads. The optimized Intel
and Apple Silicon builds passed strict ad-hoc signature checks. The read-only
mounted DMG matches the standalone application file for file, and its exclusive
Downloads copy has the same SHA-256. All 95 rebuilt frontend files match the
browser-acceptance inputs and both mobile shells' copied resources. See the
r5 build receipt（本地材料：`evidence/macos-r5-2026-10-03.json`）. This is a development bundle;
notarization, production signing and publication were not performed. It requires
matching Hub code and does not package or deploy the Hub. Native runtime and
performance acceptance remain pending because the Mac is still locked.

The earlier `20261003-r6` development DMG fixes the Send/Queue button shrinking
during a remote stop, which could leave a click unsubmitted. At narrow phone
widths the controls use stable icon targets. Both architectures passed strict
ad-hoc signature checks; the read-only mounted bundle, Applications link, DMG
integrity and exclusive Downloads copy were verified. All 95 web files match
the browser-test inputs and Android/iOS resource copies. See the
r6 build receipt（本地材料：`evidence/macos-r6-2026-10-03.json`） and
click-race regression（本地材料：`evidence/native-stop-click-2026-10-03.json`）. This supersedes
r5 for the frontend fix. It still requires matching Hub code, and is neither
notarized nor published. Native interaction and performance remain unverified
while the Mac is locked.
