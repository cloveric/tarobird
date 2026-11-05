# 1.0.123 release preflight (2026-10-31)

Status: **preflight completed; frozen publication is recorded in [release verification](release-1.0.123-verification-2026-10-31.md)**. Candidate App 1.0.123 /
Host CLI 0.1.468 starts from `b9371b9a3888c700bb990321317ae7c81fc8c05e`.
The owner authorized release and a local Mac update. Installed Mac remains
1.0.122 / Host 0.1.467; the working release candidate does not change it.

## Upstream integration gate

The official release APIs confirm Excalidraw 0.18.1 and Vditor 4.0.1 are the
latest stable versions and match the bundled versions.

baoyu-design advanced from 2.4.0 (`414f5802475159349cdded2175e07d148c8e268f`)
to [2.4.1](https://github.com/JimLiu/baoyu-design/releases/tag/v2.4.1), commit
`5a1a6f2ca2606108fc08050a78c4731adc6a2351`. Its new
[NOTICE](https://github.com/JimLiu/baoyu-design/blob/5a1a6f2ca2606108fc08050a78c4731adc6a2351/NOTICE.md)
specifies that the reconstructed editors, Artifact references and Anthropicons
are outside its MIT grant, and that the project grants no license for those
parts. TaroBot's vendored `editor/` and `reference/` contain those categories.
Consequently the current blanket MIT description needs correction; adding a
credit alone does not establish distribution permission. This records upstream's
statement, not a determination of legal rights in older snapshots.

After the explanation, the owner explicitly requested retaining Design and continuing this release. Version 2.4.1 is integrated with its full LICENSE/NOTICE and accurate attribution. This is a product release decision, not a claim that additional rights were obtained. Saved designs and the installed App remain intact during preparation.

The integration inventory also covers both bundled font projects and the direct
package manifests. Sarasa Term SC was upgraded from 1.0.42 to the latest stable
[1.0.43](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43). The official
archive checksum matched; full Regular/SemiBold fonts were converted with
FontTools 4.68.0 and Brotli 1.2.1, preserving every previously mapped character
and units-per-em. Each now maps 51,251 characters. Font/license receipts are
included beside the bundled files.

JetBrains Mono remains pinned to upstream HEAD
`19371302b95d218af43299bce79ddbddd0bc364d`; both bundled WOFF2 files match that
commit exactly. The latest stable tag v2.304 is older (2023 versus the pinned
2025 commit), so this release does not downgrade those existing fonts.

All 68 direct package-manifest entries were checked without lookup failures.
The 29 differences from the npm latest tag are ordinary SDK/framework/utility
and toolchain version differences, retained as an explicit separate dependency
maintenance inventory. They are not additional embedded user-facing application
integrations. This release updates the integrated Design editor and font project,
while retaining the already tested pinned runtime stack; it does not claim every
npm dependency is at the latest version. No new integrated project was silently
excluded from the release gate.

## Secret-scan finding

The full history scan flagged one RSA key in the vendored
`editor/artifact-type/fast-edit-worker.js`, introduced by the Design integration.
The surrounding module is Happy DOM's `FetchHTTPSCertificate`, its public
virtual-server example. Comparison against [the official source](https://github.com/capricorn86/happy-dom/blob/5e100dedb73111a276f75a3daff3a506e2524759/packages/happy-dom/src/fetch/certificate/FetchHTTPSCertificate.ts)
at commit `5e100dedb73111a276f75a3daff3a506e2524759` verifies the entire PEM is byte-for-byte
identical (SHA-256 `7f7f8c83ded111336dca167452776b8b6c35e4223882103df5edeb55875a2d41`). This is not a TaroBot signing,
identity or service key; it must never be used as one.

The scanner exception requires the **complete unchanged PEM and exact vendored
file path together**. It does not exempt that directory or historical commit.
The regression checks the public fixture, a one-byte modification, the same PEM
at another path, and a separate synthetic service token in the original file.
It keeps full-history scanning, inline-allow rejection and baseline rejection.
The five privacy-guard regressions and complete reachable-history scan passed
after this change.
Raw scanner records and downloaded verification sources stay outside Git.

## Completed baseline checks

- Independent root and client `npm ci` passed.
- Host build and client TypeScript/translations/production build passed.
- Vitest: 565 files; 7,602 passed, 6 skipped.
- Full Electron unit suite: 284 passed.
- Artifact path tests: initial 5/6 due an invalid negative-test environment:
  the intended indexed destination was itself below the inherited physical
  `.noindex` temporary root. Repeating only this suite with ordinary system
  temporary storage passed 6/6. The fixture creates directories and a symlink,
  no temporary App bundle. Product guards and test assertions were unchanged.

These are preflight checks on the current integration, not final-package,
physical-device or installed-version acceptance. Windows runtime acceptance
remains owner-deferred. No production capture/input, Host restart or system
permission change was performed.

## Release preparation corrections

The native legacy exporter failed to compile because its store list declared
14 entries after `workbenchDesign` became the fifteenth. The list is now a
constant slice, preserving all stores without a second manually maintained
length. The full legacy native suite passes after the correction.

Parallel native-core tests share a deliberately single-operation Keychain gate;
four independent in-memory fixtures initially received `system_keychain_busy`.
The suite was rerun serially without changing product behavior or disabling its
busy-path assertions. This is separate from real installed Keychain acceptance.

Design 2.4.1 adapts the exact renamed upstream symbols with the existing
one-match guards; the save/quit bridge and disabled standalone chat/comments
remain enforced. Full upstream LICENSE/NOTICE are emitted in the App.
The 107 affected Host/CLI/Design unit checks and eight Chromium Design
regressions passed. Native Electron, WebKit and font checks are recorded with
final source freeze evidence rather than inferred from a build.

### Pointer focus during page entry

Chromium's 390px typography journey repeatedly lost the palette radio click.
Event capture showed pointerdown on the radio, then focusin cancelled the
paused page animation; pointerup/click landed on the grid instead. An isolated
real-browser regression reproduced the hit-target shift for radio, checkbox and
text input (3/3 red before the fix). Focus no longer cancels an animation held
between pointerdown and click. Keyboard focus still settles immediately; a
no-click timeout settles a focused field instead of moving its caret later.
This is a product fix, not an added test delay or disabled animation.

Final pre-package results: the rebuilt client passes all seven Chromium
CLI-typography/mobile-navigation tests, including the previously failing narrow
radio action. The focused motion suite passes six checks in Chromium and six
in WebKit (WebKit does not mouse-focus radio/checkbox controls on macOS; hit
geometry and actual checked state are still verified). Native suites: legacy
104 passed; core 62 passed / 2 fixture writers ignored; addon 33 passed;
updater 71 passed. The existing full-suite baseline and affected regressions
are separate evidence, not a claim that all tests were rerun after every edit.

The installed baseline is already Electron 1.0.122, so the first Tauri-to-Electron
Keychain migration probe is not repeated for this release. Final-package checks
must compare its designated signing requirement to the actual installed App;
installed authentication/model/GUI acceptance still remains mandatory.
