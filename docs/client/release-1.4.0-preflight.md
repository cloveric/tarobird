# TaroBird 1.4.0 preflight

The owner authorized a release with one canonical download page for macOS,
Windows, Android and the standalone Host CLI, plus the public iOS TestFlight
link. Existing platform updater channels remain available for older clients.
Release notes are in English. This does not authorize replacing the owner's
installed App or submitting an App Store release.

The previous published source is
`4f0a0fbb770c8744364ea1830d4af7616aefb29b` (1.3.1). This is a full feature release,
including manual engine executable selection, pairing recovery, native goal
controls, CLI compatibility and mobile/desktop UI fixes. It is not the reduced
scoped-patch profile.

## Integrated products

Checked on November 13, 2026, before source freeze:

| Product | Candidate |
| --- | --- |
| Excalidraw | 0.18.1, unchanged |
| Vditor | 4.0.1, unchanged |
| Canvas and PPT | Baoyu 2.15.2, upstream commit `016a68e1b1ac1c7c291b2cb88d66ff087e50b017` |

The Canvas/PPT upgrade replaces pinned upstream files without editing vendor
bytes. The build adapter checks each file's hash and the exact occurrence count
of each adapted code fragment. Authoring references, skill manifests and
packaged resources are updated together. Ordinary dependency versions remain
unchanged; their security review is check-only.

The adapter was rechecked for viewport gestures, local assets and fonts,
Unicode artboard names, comment drafts, export, save settlement and quit
guards. Upstream standalone dispatch is not enabled. On Android and desktop, the new repair actions
use the existing document-owned draft flow, retain the user's text and require
an explicit Send. Native iOS omits those repair actions and their associated
instructions while preserving error details, editing and ordinary comments. Reopening the desktop editor retains the original project
and draft association.

Canvas and PPT remain available on desktop and native mobile clients, including
expanded phones and tablets. Where available, repair drafts keep the editor open.
On touch layouts, focus transfers to the non-editable draft notice after it mounts,
so a direct Send after the repair action can complete on its first tap.
The handoff only runs while the embedded editor still owns focus; an asynchronous
suggestion does not take focus from a chat input already being edited.
Ordinary draft revalidation, file persistence and conversation ownership remain
unchanged. No legacy design records are deleted or migrated.

## Verification boundary

The local full unit run passed 664 files: 8,755 tests passed and 12 were skipped.
The first native step needed the generated Host resource in the fresh checkout;
after preparing it, all 104 Tauri compatibility tests passed. Desktop core
passed 63 tests with 2 ignored, native addon passed 33, updater passed 73,
Electron passed 420 and the iOS release planner passed 7.

Affected editor verification passed 19 Chromium checks and 46 draft/comment
guard tests. The actual desktop repair buttons append to a reviewable draft
and send with the original design target. The final focus-ownership regression
passed 28 Chromium checks. Mobile repair and direct first-Send flows also passed
in Android System WebView, including exact target correlation in the Host store.
Native iOS Simulator checks found that the new repair requests were refused
for both Canvas and PPT by the unchanged parent user-activation gate. The owner
then requested hiding only the native iOS repair entry points. The revised
adapter covers all four repair-entry families without changing authorization or
save behavior. Twelve actual-editor browser checks passed in Chromium and
twelve in WebKit, covering ordinary iPhone, expanded iPhone, iPad, Android and
desktop branches, including damaged-index notices. These use in-memory storage;
they are distinct from native acceptance. The final native Duo package passed error visibility, removal of repair controls
and stale instructions, draft preservation, file restore/readback, panel and
App reopening, and first ordinary Send.
Seven standalone WebKit keyboard and safe-area checks passed. The full paired
WebKit flow remains incomplete because macOS requires a local keychain password
the owner cannot currently provide. No physical-device acceptance is claimed.
Isolated Electron windows passed 18 Canvas checks and 11 PPT checks,
including save failures, active edits on quit, opaque-origin isolation and PPT
fullscreen. These are source/runtime fixtures, not installed-App or physical
device acceptance.

Fable 5 passed the upstream/desktop repair review. The owner also requested
Opus 5.5 to review the retained mobile functionality before publication. Its
independent review found no new blocking product defect in the reviewed
candidate, and identified the focus-ownership guard covered by those regressions.
Opus 5.5 subsequently completed the iOS scope and final-diff static reviews,
found no new blocking defect and reran 19 focused unit tests. It did not run
browser or native acceptance. An additional independent Codex source review
covered the final iOS entry/wording changes and found no new blocking defect.
A known pre-existing issue remains: if a user returns to the embedded editor
after staging a draft, the first Send can be lost during draft revalidation;
a second Send succeeds. The direct repair-to-Send regression does not certify
that broader iframe-focus path.
The bundled Happy DOM advisories were checked independently: the affected
worker is not started with the pinned feature flag, and the App's frame CSP
blocks external network access. Keep that flag/CSP boundary in future upstream
reviews; this finding does not authorize a dependency upgrade.

Source is not frozen yet. Fresh signed packages, artifact privacy scans,
platform runtime acceptance and downloaded-byte readback must be recorded
separately before this release is reported as complete.

The standalone CLI shares Host behavior and versioning with the desktop Apps.
Editor-only presentation changes do not add a CLI command; existing workbench
operations and explicit/native PPT skill routing remain applicable.
