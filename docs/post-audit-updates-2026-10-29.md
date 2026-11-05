# Review of updates after the comprehensive audit — 2026-10-29

## Scope and boundaries

Reviewed `0705ace4e956972b88cf3d8f45634dabf7b354c7..c4842238aa355160bc78c4c11f4cddf2e317ec5d`: 22 commits and 279 changed paths, including native package renames. This is an incremental audit of the changes after [the comprehensive audit](comprehensive-audit-2026-10-28.md), not a claim that every product or physical-device scenario has passed.

Covered global/group-local pins, exact-conversation attachment drops, queue source navigation, animations and retired themes, CLI typography, sidebar sizing, side-window presentation, ADHD card clipping, recovery-cause retention, Search MCP/Scrapling, and the all-platform application identity transition. Codex reviewed shared/UI behavior and integrated the results; Claude Opus 5.5 independently reviewed search/identity, implemented APNs and Scrapling fixes, and cross-reviewed the root repairs.

No production database, credentials, model settings, APNs/Firebase settings, Apple records, running Host, installed App, or released artifact was changed by this audit. Isolated fixtures and test accounts were not used to send real model prompts or push notifications.

## Confirmed findings and repairs

### UI-1 — side conversation remains hidden when native window IPC never answers (P2)

The opening fallback timer was armed only after the expansion callback. An unanswered initial native window read therefore kept the side panel hidden indefinitely. The unchanged candidate fails the new visible-panel assertion while the geometry promise remains pending.

The presentation deadline now bounds the whole opening. After two seconds without a usable response, the existing window shows an in-page split. Unanswered native work relinquishes its expansion intent; an acknowledged expansion keeps its frame while waiting for the WebView resize. Late reads cannot expand an obsolete panel; a resize already applied before its receipt arrives is restored only if the controller still owns the exact frame. Closing cancels the deadline. Existing manual-move, multi-owner and frame-restoration guards remain in the controller. Opus caught an over-broad timeout release in the first candidate; the strengthened missing-WebView-resize test reproduced a shrink from 1400 to 1000 before that correction. A permanently unanswered native promise remains serialized: later openings still use the bounded visible split, rather than starting competing native writes.

Regression coverage includes delayed/no geometry, delayed resize receipt, close-before-response, intermediate WebView resize, maximized/rejected geometry, and the normal opening animation. This is a presentation change; headless CLI behavior is not applicable.

### PUSH-1 — APNs topic mismatch destroys an otherwise valid subscription (P1)

Opus reproduced the real sender with a local HTTP/2 double: either global topic
made the other app identity return `gone`. The worker then erased `push_json`.
The repair introduces per-subscription APNs topics gated by the Host's advertised
allowlist, obtains the installed identifier through Capacitor's native App API,
and rejects unsupported registration before prompting or writing a token.
Subscriptions without a topic retain the existing configured default. A topic
mismatch fails that delivery without invalidating the device subscription.
Readiness now explains an unsupported Host or excluded App identifier even
when a subscription exists. Maintenance capability reads use cancellation and
a deadline. No live push configuration was changed. The old topic must remain the default while old clients are supported.

### UPD-1 — old installed updaters discover packages they cannot install (P1 release blocker)

Changing package identity while reusing release tags allows an old updater to
download a new package and only then fail its strict identity check. New-ID
source now discovers/publishes `macos-tarobot-v*`, `windows-tarobot-v*` and
`android-tarobot-v*`; desktop manifests also include `-tarobot-`. Legacy tags and
assets must remain immutable. New and old discovery policies ignore the other
identity. Package/signer checks and rollback remain strict. This avoids unsafe
offers, but cannot retrofit migration UI into already-installed binaries: the
first cross-ID installation remains a one-time installer transition, described
in the current platform update guides and release checklist.

### WIN-1 — the implicit NSIS publisher changes the installation registry namespace (P2)

Tauri derives a missing publisher from the identifier. The native rebrand thus
changes the namespace used to remember the install directory, while the
uninstaller record still uses the same product name. The candidate explicitly
keeps `bundle.publisher` at the legacy `tarocub` namespace; its application ID
is still `com.tarobot.client`. This is an installation compatibility exception,
not a client identity rollback. Static template/config review confirms the key
selection; interactive custom-directory upgrade/uninstall still needs Windows
execution before release.

### SCR-1 — an interrupted Scrapling upgrade leaves incompatible skill instructions (P2)

Opus reproduced a successful runtime upgrade followed by browser setup failure:
the installer exits before copying the matching skill, leaving commands removed
in Scrapling 0.5. The installer now copies the matching skill and executable link before the
optional browser step, which still returns failure if incomplete. It checks
Python 3.10+ before any environment mutation, including existing virtual
environments; an explicit interpreter override is supported. These two failure
cases were reproduced before the repair. No user runtime was installed by this audit.

### DIAG-1 — native directory refusal and reused Host path are misreported (P3)

The Windows helper now preserves only the bounded `conflict` and `redirected`
refusal codes. Node accepts those exact strings only from an exit-78, non-killed
helper; malformed errors, launch failures and interruptions remain generic.
`doctor --json` resolves the actual reused desktop directory instead of printing
the new nominal path. A conflict in the default directory is a separate
`desktopDirectoryIssue`, so inspection of an explicit recovery path still works.
Tests fail on the original code and pass after the repair; none creates or moves
a Host as a diagnostic side effect.

### SRCH-1 — Claude/Codex managed Search MCP is missing from the capability catalog (P3)

The metadata catalog now lists the managed server for Claude and Codex as well
as Kimi and DeepSeek. It uses the credential gate and native launch planner,
respects a working or explicitly disabled user/project search registration, and
omits private values. Offline catalogs still remain workspace-only. A catalog
entry is configured metadata, not proof of a successful live search; existing
`runtime_unverified`/partial-coverage markers remain. App and headless workers
share this read-only implementation.

## Validation record

Evidence directory: `/Volumes/gdrive/taro-tmp/post-audit-20261029`.

- Baseline Host standalone and client translation/TypeScript/Vite builds passed.
- Focused shared baseline: 19 files, 622 passed and 1 Windows-only skipped. Covers pins, shared attachments, recovery causes, five engine adapters, Search MCP/config safety, CLI entry and Host directory compatibility.
- Baseline changed-feature browser run: 32 passed and 2 CLI typography reload-readiness failures out of 34. These failures are retained, not counted as passes.
- Isolated original CLI rerun: desktop passed; phone failed the immediate radio checked assertion. A diagnostic phone run completed the same full journey without hitting its failure instrumentation. These are retained as intermittent test failures, not treated as confirmed product fixes.
- UI-1 initial candidate: 8 Chromium and 8 WebKit opening journeys plus 25 controller tests passed. Cross-review strengthened the missing-resize case and caught the extra shrink; after the follow-up, all 8 Chromium opening journeys passed again. The final combined WebKit run below includes all 8 opening journeys.
- Unchanged original CLI typography tests now passed at both widths; the complete selected candidate layout run passed 8 tests including sidebar resizing and ADHD clipping/menu access. Independent WebKit pins/queue navigation passed 10. No production theme/connection code or assertion deadline was changed to obtain these passes. The earlier intermittent failures remain recorded.
- Root follow-up coverage: 154 tests across 7 files. Six files passed; 9 existing Host CLI cases hit the default 5-second timeout while native builds and browser tests were running. The affected file then passed all 23 using the same 15-second budget as the initial baseline.
- Native candidate: 86 Rust tests passed; the Windows Host launcher cross-target check passed. Android unit tests passed 45/45, including channel isolation and strict package/signer validation. Google Services was not configured in this isolated worktree; these tests make no FCM delivery claim.
- Baseline Rust desktop native tests: 83 passed. `TAURI_CONFIG` disables bundled resource packaging for this isolated test run; this does not certify an installed App or native GUI. The first attempt stopped at a missing `host/` build resource and is recorded as test setup, not a product test failure.

## Cross-review and integration

- Root independently reviewed the APNs sender, Host registration/rotation and
  client capability checks. Review added a failing readiness case and a
  maintenance cancellation case; Opus implemented both corrections.
- Opus reviewed window timeout/lease ownership, updater channels/publisher,
  bounded directory error propagation and Search MCP catalog suppression.
  Its generated Android path warning was resolved by restoring the local
  Capacitor-generated file; it is not part of this change. The extra window
  shrink identified in review was reproduced and corrected as described above.
- Opus candidate: 107 logic tests and 80 Chromium native-push/readiness/event
  journeys passed. Both Host and client builds passed.
- Integrated candidate: **261 tests in 17 files passed** in one final run;
  these overlap the earlier root and Opus runs and are not additional unique
  test counts. Host standalone build passed (462 modules); final client
  translation/TypeScript/Vite build passed. **47 WebKit journeys passed**,
  covering notification readiness, native push and side-window opening.
- Final Opus 5.5 delta review found no remaining blocker in the submitted
  changes and accepted integration. The shared Rust refusal helper emits a
  non-blocking unused-function warning in unrelated native compilation units;
  it does not affect directory admission.
- CLI impact: the shared Host push sender, capability catalog, installer and
  diagnostic commands are used without the desktop App. The side-panel change
  is presentation-only; no parallel Host state or API was introduced.

## Remaining release and device gates

- This audit has not published a release or installed its source into daily Apps.
- First cross-ID installation, fresh client pairing, real APNs/FCM delivery,
  iOS App Group sharing, Mac TCC access to required external/network volumes,
  and Windows custom-directory upgrade/uninstall need final signed artifacts
  and physical-device/Windows acceptance.
- New and legacy Android packages both paired on one device may produce
  duplicate notifications and a deep-link chooser. Revoke/remove the old client
  only after replacement acceptance; this does not delete Host sessions.
- APNs sandbox/production still uses a single Host setting. Pre-release test
  Apps registered before topic support need the updated client to attach their
  native topic; older client diagnostics cannot be retrofitted by this source.
  No physical push or migration claim is made for those intermediate builds.
- Older audit limitations, including the previously recorded LAN-readiness
  failures and full-suite timing flakes, are not declared fixed by this focused
  incremental review.
