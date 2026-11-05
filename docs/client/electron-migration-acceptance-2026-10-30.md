# Electron desktop migration acceptance — 2026-10-30

Current checkpoint: [Kimi audit and independently reviewed fixes](electron-kimi-audit-2026-10-30.md).
Publication and local installation are held at the owner's request until a new
explicit release instruction. The prepared 1.0.121 artifacts predate these source
fixes and are not acceptance evidence for them. The records below retain their
original source/package/platform scope.

Follow-up: [DeepSeek audit, Codex/Opus adjudication and fixes](electron-deepseek-audit-2026-10-30.md). The pending 1.0.120 activation was held before replacement; these newer fixes require a new release and installed acceptance.

Latest source audit: [Phase 7 comprehensive review and fixes](electron-migration-audit-2026-10-30.md).
[Phase 8 actual functional verification](electron-functional-verification-2026-10-30.md)
covers the clean 1.0.120 / Host 0.1.465 package, real model/file/UI operations
and independent signed native service runs. Mac and CLI publication is verified;
installed activation is still waiting for active tasks at that checkpoint.
Historical package/gate sections below retain their original scope.
Windows runtime is explicitly deferred.

The desktop implementation has moved to Electron on macOS arm64 and Windows x64.
The existing React UI, independent Node Host and Rust identity/pinned transport
remain shared. Tauri remains only for reading legacy WebView data and historical
regressions. iOS/Android retain Capacitor; this change does not move phones to
Electron or require new mobile pairing.

**Not a release or production installation receipt.** The Phase 5 packages below are
isolated development/Developer ID acceptance packages, built from the working
tree based on `09bbfbd28e782f41fb3b86a359de3607f5f8a9e3`, App 1.0.119 / Host
0.1.464. Their metadata explicitly records `dirty: true`; they must not be
published as a clean release. `/Applications/TaroBot.app`, its Host and production
credential records were not replaced, restarted or used for model tests.
The later clean-source Phase 6 package is recorded separately at the end.

## Functional boundaries

| Area | Implementation and evidence |
| --- | --- |
| Desktop UI | Full shared UI under sandboxed preload; window controls/geometry, tray, single instance, protocol activation, shortcuts, autostart, notifications, badge, attachment dialogs/open/reveal and screenshots have Electron routes |
| Host and CLI | Same canonical Node Host and state ownership; real isolated packaged start/local pairing/stop passed; transient commands retain native ownership; empty stdin cannot authorize a Host action |
| Credentials and transport | Shared Rust installation binding, keychain namespaces, action proofs and pinned TLS; main owns paths and IPC; untrusted renderer content cannot gain native APIs |
| Legacy data | Real persistent WKWebView → embedded-identity reader → HMAC/part/blob checks → packaged Chromium. Nine records, pairing reference, host/database IDs, draft, 150 KB attachment and original outbox ID survive; reload does not duplicate the queue |
| Legacy concurrency | Windows checks old-instance mutexes and same-user process ancestry, holds compatible forwarding windows for late starts, never kills the Host. Mac checks old App processes. Exporter is separate from HostApp and has no Host/network plugins |
| Failure recovery | Invalid exports can be regenerated; single-reader lock; bounded timeout/kill; safe stale partial cleanup; unconfirmed committed exports quarantined; no silent fresh-profile fallback |
| Updates | Shared signature/version/GitHub policy, native transactional Mac install/rollback, Windows installer handoff. Mac archives tested through both the installed Tauri extraction algorithm and new Rust extractor |
| Windows installer | Legacy NSIS identity, custom location, shortcut/AUMID, autostart key and uninstall/reset behavior retained. Actual installer built/extracted; runtime execution still pending |

## Defects found and closed with Opus 5.5

- BSD tar emitted AppleDouble entries and xattrs, causing both real updaters to
  reject the archive even though BSD tar read-back passed. Packaging now disables
  that metadata and runs both real extraction algorithms plus strict codesign.
- A bare Mac legacy reader did not inherit the outer App identity and read an
  empty profile. It now embeds and checks its own Info.plist identity. A persistent
  source fixture reproduces the old failure and verifies the corrected path.
- WebView2 profiles are shareable; they cannot serve as an old-App lock. The
  Windows native guard now checks ownership and intercepts late legacy starts.
- Windows Tauri CRT overrides conflicted with fully static cargo-xwin linking.
  The legacy reader disables that extra override and keeps `+crt-static`.
- Windows autostart could duplicate the legacy registry item; Mac stale own
  LaunchAgents could not be repaired; saved documents could not reopen after
  external edits. These compatibility defects are covered by focused tests.
- Windows packaging lacked required author metadata; the final package now keeps
  the existing publisher. Final-runtime verification recognizes `resources/host`
  and requires all Electron native helpers.
- Hosted workflow validation exposed job-level `runner.temp` references that
  GitHub Actions rejects before starting a runner. All three desktop workflows
  now write their `.noindex` paths to `GITHUB_ENV` inside a runner step; actionlint
  validates expression scope in addition to YAML syntax.
- Empty Host CLI stdin left a narrow helper-death race. It is now rejected before
  any start/stop/status operation; nonempty JSON authorization remains required.

## Final local checks

| Check | Result |
| --- | --- |
| Electron main/preload Node tests | 89 passed |
| Rust core, subprocess and migration tests | 51 passed; 2 opt-in fixture writers intentionally ignored |
| Migration/update frontend + CLI lifeline Vitest | 14 passed |
| Host package/runtime and CLI lifeline Vitest | 10 passed (lifeline overlaps previous row) |
| NSIS fixture planning, real compile/extraction, plugin pinning | 6 passed |
| Chromium export/notification/transport/migration regressions | 107 passed |
| Screenshot old/new desktop adapters | 10 passed |
| WebKit logical data migration | 2 passed |
| Actual final packaged Mac Host/UI gate | 8 checks passed |
| Actual final persistent source → packaged Electron + reload | Passed, export `44159095-9192-4e74-848a-fdb5d61b5ee1` |
| CUA final native window | Startup, connected isolated Host, Settings 1.0.119 and Quit observed; test Host stopped and exactly its one temporary key retired |
| Developer ID / foreign Node addon | All 30 signed targets passed exact rights/team/runtime/timestamp checks; foreign ad-hoc Node addon loads |
| Apple notarization | Accepted `46ce5918-d806-4a1e-9621-b208d9406752`; staple/validate and Gatekeeper accepted |
| Final Mac archive / DMG | DMG mounted; old/new updater extraction and strict signatures passed |
| Full Windows package | NSIS installer generated; extracted 23 PE files passed runtime dependency scanning |
| Workflows | actionlint 1.7.12 validated all repository workflows after correcting runner-scoped paths; no claim of hosted execution |

The first browser run had 110 passes and two screenshot failures. Those tests
slept 30 ms without waiting for the destination change to commit. They now wait
for the actual DOM state and cover both Tauri and Electron adapters (10 passes),
without changing capture behavior. The other 107 checks were retained. One
wrong-working-directory test invocation was stopped; its output is not counted.
Windows native tests were cross-compiled and linked, **not executed on macOS**.
Opus separately ran the updater/installer regressions and the real archive test;
the local evidence is retained under the task lab.

## Artifact identity and receipts

Task lab: `/Volumes/gdrive/taro-tmp.noindex/electron-migration-20261030`.

- Final Mac package: `mac-final-a1/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app`.
- Final Mac artifacts: `mac-final-artifacts/macos-artifacts.json` and `SHA256SUMS`.
- DMG SHA-256: `d8d0097380cce6eedc90c72b58ad16b423fa9c8e91ce875eac8d911a0dca8329`.
- Archive SHA-256: `52185179208c16f7385240db19c3c4c839cd7d911b98b76bc6adb8dc13579d1d`.
- Windows package/installer: `windows-entry-a3/desktop-build.json`;
  extracted runtime inventory: `phase5-windows-runtime.json`.
- Source export/import: `persisted-final-a2/verification.json`,
  `final-migration-a2/verification.json`; native GUI: `phase5-native-gui-verification.json`.
- Apple: `phase5-notary-binding.json`, `phase5-notary-submission.json`,
  `phase5-notary-status.json`; binding explicitly marks this as acceptance.
- Opus review: `phase4-parity-findings.md`, `phase4-root-review.md`,
  `phase4-final-review.md` (later appendices close earlier findings).

All native packages and build/extraction roots are physically below `.noindex`.
No active/recent directories were swept. The separate Spotlight cleanup PR #97
was inspected and left independent.

## Remaining gates

On 2026-10-30 the owner confirmed that no Windows computer or VM is available
and explicitly chose to **retain Windows as pending acceptance**. Its runtime
gate is deferred, not waived or passed. Continue independently verifiable Mac
work without waiting for a Windows machine; do not repeatedly request one.
Resume the prepared Windows scopes when an environment becomes available.
This decision does not authorize an unverified Windows release or change any
existing receipt. Production publication and installation are still separate
from the completed source migration and isolated Mac checks.

1. **Windows execution — deferred by the owner:** clean installation, upgrade from the existing Tauri
   installer (including custom path), WebView2 export, Credential Manager access,
   notifications, autostart, Host survival during App quit/update and uninstall.
   Windows-only tests are wired into CI, but no local Windows machine/VM exists.
2. **Production release and existing-user activation:** rebuild from the final
   clean commit with a new release version, verify signed update feeds and perform
   guarded installation/read-back. Acceptance packages are not substitutes.
   Existing-user Keychain access remains an activation check, even though signing
   requirements and native state layouts are preserved.
3. **Hosted CI:** source runs `40976324842` and `40993297003` have no executed steps. GitHub's
   annotation says recent payments failed or the spending limit must increase.
   Hosted Apple signing/notary credentials also remain unconfigured; local signing
   and notarization have been verified independently.

The full migration must not be called accepted on every supported desktop until
these runtime/release gates have receipts. This is not evidence of zero remaining
bugs; confirmed defects above were fixed and the outstanding boundaries are explicit.

## Follow-up completion audit (Phase 6)

The earlier package receipts above remain historical evidence for those exact
packages. They do not cover the later fixes in this section. The follow-up with
Opus 5.5 found a real Mac credential compatibility defect and missing Windows
execution coverage; the migration was therefore not treated as fully accepted.

The Mac credential fix is committed as `a88d6af637024bad616547088c8aea9ca5b7be6c`.

### Signed Mac credential compatibility

A disposable fixture uses the same `SecKeychainAddGenericPassword` API as the
legacy keyring store and is signed with the installed App's designated
requirement (`com.tarobot.client`, team `7TP234YKWW`). A different signed helper
then reads the installation-bound test key, proves possession by signing a
nonce, and deletes only that fresh service/account. No production credential is
read and the installed App is neither launched nor changed.

Before the fix, read and Ed25519 verification succeeded but deletion failed with
`device_key_delete_failed`. A two-executable API comparison reproduced
`SecItemDelete` returning `-25244`; the exact-item legacy deletion API succeeded.
Shared deletion now uses the same user-domain keychain and service/account,
requests an item reference without reading password bytes, and calls
`SecKeychainItemDelete`. It retains OS access controls and treats only
`errSecItemNotFound` as an idempotent success. Core device retirement and updater
logout share this implementation; non-Mac platforms keep their keyring path.

After the fix, all six signed-credential checks passed, including inability to
sign after retirement. Receipt: `phase6-credential-compat-fixed/verification.json`;
helper SHA-256:
`815e943fb91c489aa8386e4429d05ee24604d1e0fc3a2dceda7a8e96ae6bb149`.
The signed fixture and probe live in `client/electron/tests/`; they require
explicit isolated inputs and are not part of production startup. Existing-user
activation remains a separate gate from this real disposable-key compatibility
test.

### Windows execution coverage

`client/scripts/windows-acceptance.mjs` now performs actual installer operations
on an explicitly disposable Windows user/VM. It refuses existing App data,
installations, login items or processes, and also refuses an unreadable preflight.
It records `pass`, `fail` and `incomplete`; omitted required scopes never count as
passed. Checks include the first-launch profile and committed migration receipt,
installation layout, deep link, shortcut/AUMID, login item ownership, uninstall,
and optional old-installer and next-installer transitions. It ends only its owned
App processes by PID, and distinguishes the same Host state from an unrelated
running Node process. Full usage and manual boundaries are in
[`client/windows-electron/ACCEPTANCE.md`](../../client/windows-electron/ACCEPTANCE.md).

The persistent WebView audit now has a Windows path. A uniquely identified
WebView2 fixture is opened by the actual exporter, launched by Electron main so
the native source guard remains active. Chromium must contain the same nine
records, draft, 150 KB attachment bytes, pairing reference and original queued
message ID; reload must not duplicate it. Production rejects the acceptance
switch. Development requires a matching isolated manifest and rejects redirected
source directories. The same content assertions were rerun successfully on the
existing Mac package after being extracted into a shared test module.

The Windows workflow runs installer and native acceptance, then builds a separate
development package for persistent WebView2 content acceptance and uploads the
receipts even on failure. Installation/native checks and full old-version
upgrade checks remain distinct scopes. **None of these Windows runtime checks
has executed yet**: no Windows runner is currently available and hosted CI remains
blocked by billing. Cross-compilation, NSIS extraction and simulated tests are
not Windows runtime acceptance.

Two installer defects were also corrected. Uninstall now removes a login item
only if its command points to this installation; a value owned by another
installation is retained. A Tauri update skips the old uninstaller, so its
top-level `host` runtime could remain. A fixed-argument helper now retires only
that identified bundled directory, after the new runtime exists and Host stop
is confirmed. Unknown contents or any symlink/junction cause refusal. Runtime
selection prefers the new `resources/host` layout even when cleanup is refused.
Tests performed cleanup only in disposable fixtures, never on an installed App.

### Follow-up local verification

- Electron main/preload/acceptance isolation: 93 tests passed (includes four new
  acceptance-boundary checks).
- Mac shared keychain: two focused tests passed; the real isolated OS credential
  round trip passed; updater library: 39 tests passed.
- Old Tauri compatibility: `cargo check` passed. Windows core and updater
  `cargo xwin check` passed; these were compilation checks only.
- Root Host build passed (463 modules). CLI behavior is unchanged: the migration
  retains the existing Host/CLI entry point and state ownership.
- Opus independently reviewed the Keychain selectors, FFI signatures, ownership
  and error boundaries; no blocking issue was found in that fix.
- Windows acceptance harness: seven simulated tests passed; seven mutations
  reinstating incorrect verdicts were caught. Audit-runner tests: eight passed.
- NSIS planner/ownership checks: eight passed, including actual installer
  compilation. Installer helper: 17 native fixture tests passed on Mac; Windows
  development/test-profile compilation passed, without Windows execution.
- Workflow expression validation passed with actionlint. Windows native tests
  explicitly run serially with static CRT enabled; compiled-out or skipped
  checks cannot produce a passing acceptance result.

Receipts and Opus's detailed review remain under the same task lab, with
`phase6-` prefixes. `/Applications/TaroBot.app` is still the previous installed
version; this follow-up is neither a release nor a production activation receipt.

### Clean-source Mac package after the follow-up fixes

Rebuilt from `0ae2d2fa6d2d818d76a2e55bdbfb8a8d9d9d7342`, with the embedded
metadata verified as `dirty: false`, mode `development`. App 1.0.119 / Host
0.1.464 here identify an isolated acceptance build, not a newly published release.

- Package: `phase6-mac-clean-a1/package.noindex/packages/TaroBot-darwin-arm64/TaroBot.app`.
- Developer ID verification: all 30 signed targets passed exact entitlement,
  team, hardened-runtime and timestamp checks; foreign native addon loading in
  bundled Node passed. Receipt: `phase6-mac-signing.json`.
- Actual packaged UI/Host: all eight checks passed, including starting and pairing
  an isolated Host, close/hide and Dock restore, the legacy-profile identity fence,
  stopping the test Host and retiring its temporary key. Receipt:
  `phase6-packaged-host/verification.json`.
- Persistent-source import into this new package passed, using the earlier real
  WKWebView export `44159095-9192-4e74-848a-fdb5d61b5ee1`: same nine records, draft,
  attachment hash and queue ID; reload did not duplicate the queue. Receipt:
  `phase6-packaged-migration/verification.json`.
- No isolated App or Host process remained after the checks. The real App and
  production Host were not replaced or restarted.

This new package has **not** been notarized or published; the Phase 5 notary
receipt applies only to the earlier package. Latest source-check run
`40998609597` again had no executed steps, with GitHub's billing/spending-limit
annotation. No Windows runtime receipt or production activation is implied by
this Mac rebuild.
