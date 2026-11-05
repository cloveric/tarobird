# Electron migration: comprehensive audit and fixes — 2026-10-30

Follow-up: [DeepSeek audit, Codex/Opus adjudication and fixes](electron-deepseek-audit-2026-10-30.md). The pending 1.0.120 activation was held before replacement; these newer fixes require a new release and installed acceptance.

Follow-up: [Phase 8 actual functional verification](electron-functional-verification-2026-10-30.md)
records the clean published 1.0.120 / Host 0.1.465 package, native UI/model/file
operations and Opus 5.5 native failure/recovery runs. Installed activation is
separate from these source-audit results.

This is the final source audit for the Tauri → Electron desktop migration,
reviewed independently with **Claude Opus 5.5**. It covers the full desktop
application, native helpers, existing data, Host/CLI lifecycle, packaging and
updates. iOS and Android retain Capacitor. Windows runtime acceptance remains
**explicitly deferred by the owner**, not passed.

The source release target is **App 1.0.120 / Host and CLI 0.1.465**. A source
commit or the signed development packages below do not establish publication
or installation. Formal Mac artifact and installed acceptance are separate.

## Confirmed issues corrected

| Area | Failure before this audit | Resulting behavior |
| --- | --- | --- |
| Links and native chrome | External links were discarded; draggable setup surfaces swallowed disclosure/label clicks | Trusted main-frame clicks open the validated external URL; interactive elements, dialogs and previews retain mouse input; Close Window and Full Screen menu actions restored |
| Signed native caller | A separately launched signed helper could act with the App's Keychain identity | Kernel audit-token sender checks, exact signed main executable/identifier/certificate, own-bundle resource binding and updater seal checks; exporter also requires an authenticated start line |
| Signed acceptance isolation | A debug-capable acceptance App could request the production credential service | Only the verified production App can select the production device service or updater Keychain vault; the acceptance package retains only disposable test namespaces |
| Renderer failure | A crashed renderer left a dead window | Bounded automatic recovery, then a native reload/quit choice; a hung renderer gets wait/reload recovery; document authority is retired before replacement |
| Host reconciliation | A helper crash could kill the control CLI after stopping the Host but before its recovery | Pending Host mutations retain a bounded drain interval after helper death; delayed group cleanup never targets a reused live leader PID |
| Quit and updates | A failed read-only updater request could block Quit; a replaced Mac bundle could mix new helpers with the old main | Only installation retains the update barrier; successful Mac replacement requests a full restart and refuses new helper/updater work until restart; quitting during initial navigation does not open an error dialog |
| Production debug switches | Chromium debugging/profile switches could expose privileged main-frame capabilities | Production launch arguments are validated before readiness and native initialization; debugging is disabled in the production window |
| Snapshot freshness | An interrupted import could reuse a snapshot after the old App wrote newer data | Re-export changed legacy sources; replace only the matching uncommitted import claim; preserve committed Chromium data and show a dismissible notice about divergent legacy data |
| Recovery metadata | Dismissing that notice could incorrectly refresh the old export's fingerprint | Acknowledgment has its own metadata; it never changes the export baseline. Deleted legacy roots can resume a bound verified export; unreadable sources remain retryable before first import |
| Legacy concurrency and storage | Another macOS login could block migration; browser databases were under a cache-named directory | Old-App detection is current-user scoped; persistent Chromium databases reside inside `electron-profile/browser-data` |
| First-use identity | Concurrent/interrupted marker creation could leave an invalid installation marker | Private write, sync and atomic no-overwrite publication; concurrent creators use the winner's complete marker |
| Migration limits | Limit failures collapsed into a generic retry error | Preserve the safe reason code and show actionable size/busy guidance; never delete the original data on failure |
| Release source | An ambient URL could silently select a different update provider | Production Mac builds reject alternate ambient feeds and record the pinned GitHub provider |
| Notarization | A long wait/interruption could lose Apple's submission ID | Persist the ID, source/signature binding and immutable ZIP digest before waiting; resume the same submission; retain rejected receipts and require a fresh output for corrected bytes |
| CLI session discovery | Claude path decoding did not resolve `.noindex` and dotted source-directory components | Resolve actual directory entries before the historical fallback; no exponential delimiter search |

The registry/cache schema compatibility gate remains pinned to the supported
Tauri source versions (registry 2, cache 9). Any future schema change must add
an explicit migration transform or adjust the supported upgrade boundary.

## Verification

All fixtures use isolated state and `.noindex` App artifacts. No test below
reads a production credential or replaces `/Applications/TaroBot.app`.

| Verification | Result |
| --- | --- |
| Electron contracts and notarization regressions | 115 passed |
| Final targeted recovery/freshness regressions | 29 passed; included in the 115 above |
| Opus independent final four-suite review | 37 passed; F1–F4 approved |
| Real native updater lab, including signed download/install/Host drain and Electron integration | 14 passed |
| Retained Tauri compatibility regressions | 97 unit + 3 migration + 3 pinned transport passed |
| Native core after caller/marker changes | 49 unit + 6 integration + 5 transport passed (original ignored cases remain ignored) |
| Native updater and installer helper | 43 library + 17 binary tests passed |
| Native exporter limit diagnostics | 15 binary tests passed |
| Actual IndexedDB compatibility/migration browser checks | 2 Chromium + 2 WebKit passed |
| Real signed Electron parent and old-creator Keychain ACL | 9 checks passed: unchanged ACL, signing, exact disposable-key retirement, direct Node refusal and acceptance-parent production-service refusal |
| Signed full App / isolated Host | 8 checks passed: startup, local pairing, close/reopen, existing-data gate, explicit test Host/key cleanup |
| Native clipboard file aliases → Chromium paste event | Two files received with correct names/sizes; no message sent |
| Actual renderer crash and persistent queue | Draft and outbox client message ID preserved; exactly one queued entry; fresh native document lease |
| Actual hung renderer followed by normal App Quit | Exited normally with code 0, about 0.7 seconds |
| Native CUA | Real mouse expands/collapses manual pairing controls; File menu exposes Close Window |
| Debug endpoint probe | Baseline endpoint reachable; guarded launch exits 64 and endpoint remains unreachable |
| Helper-crash Host reconciliation replay | All three control/crash cases finish with Host `running`; pre-fix crash case stayed `stopped` |
| Host/frontend builds | Passed; official standalone Node is used for frozen-runtime checks |
| Installed 1.0.119 update public key | Matches the configured release public key; GitHub provider retained |

The full initial baseline completed 529 files / 7,153 tests, with 7,100 passed,
48 failed and 5 skipped. The failures were diagnosed individually: use of a
Homebrew Node with external dylib dependencies, stale Mac-build fixtures, and
the `.noindex` path decoder. The affected official-Node regressions (67),
build fixtures and path-decoder regressions (18) subsequently passed. Vitest
also collected a native `node:test` lab file incorrectly; it is now excluded
from that collector and was executed separately against the real lab binary
(14 passed). This is a retained baseline plus focused revalidation, not a claim
that a second full baseline was run. GitHub billing-blocked checks are not
counted as executed CI.

The source-privacy exception is limited to one fixed Ed25519 public SPKI header
in one historical QR test. Actual scanner positive/negative fixtures and the
history scan passed; no general secret-ignore baseline was introduced.

## Evidence boundaries and remaining release work

The signed acceptance package is based on the audit worktree at `9245b5c`
with `dirty=true`, development mode. It is not a distributable release. The
full Host/GUI and persistent WKWebView acceptance from Phase 6 remains recorded
in [the acceptance record](electron-migration-acceptance-2026-10-30.md).

Formal release still requires a clean source SHA, production Developer ID
package, notarization, final DMG/archive read-back, same-source standalone CLI,
GitHub publication/read-back, then local installed runtime/model/GUI acceptance.
The old App and complete data backup must exist independently of the old
updater's temporary backup. Activation must wait for active work to finish;
never synchronously wait for the Host to drain from a Bot turn on that Host.

Physical microphone/camera behavior is distinct from entitlement validation.
The main and generic capture helper now have the correct media entitlements;
renderer/GPU helpers do not receive unnecessary privileges. Physical-device
results must be recorded from the installed production package. Windows
install/upgrade/notifications/uninstall remains pending the user's environment.

Known deliberate boundaries: automatic migration fails safely if the old
origin disappeared before any verified export, or required data exceeds the
bounded export format (4 GiB total / 128 MiB individual value). Original data
is retained. Divergent old/new profiles are never silently merged. The audit
does not prove an arbitrary multi-gigabyte profile or every physical device.

Optional follow-ups, not confirmed migration blockers: tray Retina polish,
crash-only temporary-file retention, and pruning legacy export snapshots after
an explicit rollback-retention period. No broad cleanup or old-profile deletion
is bundled into this migration.

CLI impact: desktop presentation and OS integration reuse the same Host APIs;
no parallel Host or reduced CLI is introduced. The Host version is incremented
so manual App replacement can reconcile an older bundled runtime. The session
path correction is shared by App and headless entry points. Mobile source
version metadata advances with the shared App version; this Mac migration does
not itself publish new iOS/Android binaries.
