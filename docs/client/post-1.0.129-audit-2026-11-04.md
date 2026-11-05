# Post-1.0.129 joint audit — 2026-11-04

## Scope and review

The latest GitHub Mac/Android release was checked live: 1.0.129, source
`c29e51a230cf4c5de2b0a1549e68163c47695c25`. This audit covers its ten subsequent
commits through `197747ebbaab5e7803022bafad64749afc0022b8` (77 changed files):
fullscreen close, neutral/narrow Workbench UI, New Bot form, warm-gray default,
AGENTS.md persona, hidden sharing/local-storage entries, native PPT routing,
and conversation-scoped Workbench visibility, plus release evidence documents.

Root implemented and validated the fixes. CC1 / Claude Opus 5.5 independently
reviewed the range, ran isolated persona probes, and reviewed Root's changes.
Its reports and probe output are retained under the evidence root's `opus/`.
Opus also ran isolated real CLI permission probes: nine Claude Code 2.1.317 runs
using Haiku (metadata `claude-haiku-5-5`) and three Antigravity 1.4.12 runs using
its default model (underlying model name not inferred). These validate native
permission behavior, not installed App approval cards.
The final `opus/fix-review.md` reports all four fixes correct with no blocking
issue, including the corrected hidden-pane error guard. The frame-call test
snapshot was tightened to permit only mount-time reads as Opus suggested.
Opus did not edit production code or run Root's browser/native test suites.
Kimi was not tested. No version bump, release, installation, global skill update,
production persona change, or active Host restart was performed.

## Confirmed defects and repairs

1. **Close after external fullscreen exit.** Escape or a browser-initiated HTML
   exit can finish before macOS finishes its Space transition. Clicking X then
   skipped the native wait. Explicit controller exit now settles the target even
   if its logical state already reads false; the screen target still waits when
   HTML fullscreen has ended. It preserves another element's fullscreen and a
   pre-existing native fullscreen window. Both the direct and queued paths have
   regression coverage.
2. **Stale close after returning to the same Host viewer.** Navigation hides a
   viewer without unmounting it. An older pending close could remove that viewer
   after it was reopened. Visibility changes now retire the close token as do
   Host changes and unmounts.
3. **A's initialization error shown in B.** Panel contents/open state already
   belonged to the conversation, but button/restore rejection handlers wrote
   into the currently selected interface. They now check the originating
   connection, user and conversation. An independently mounted hidden pane
   retains its own error for return/retry. Opus caught an intermediate visibility
   guard that swallowed that error; a negative browser test reproduced it before
   the guard was removed.
4. **Hand-cleared persona becomes unreadable.** Adjacent start/end marker lines
   (`START\nEND` or CRLF) are a valid empty section. The parser formerly demanded
   two line breaks, blocking both get and save. The parser accepts this empty
   form while retaining malformed/duplicate marker rejection. Tests verify empty
   precedence over a recreated legacy persona, subsequent save, and byte-for-byte
   preservation of surrounding rules.

The screen and Workbench fixes affect App lifecycle/presentation only; CLI screen
and Workbench contracts are unchanged. The persona parser is shared by App and
`tarobot bots persona`, so the same repair applies to both without a new command.

## Validation

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/post-1.0.129-audit-20261104/`.

- Negative evidence: `screen-negative.log` fails both new lifecycle assertions;
  `workbench-negative.log` proves A's error leaked to B; `persona-negative.log`
  fails both LF/CRLF empty cases; `workbench-hidden-negative.log` proves the
  intermediate hidden-pane error regression. These failures are retained.
- `final-focused-tests.log`: 10 suites / 145 tests pass, covering fullscreen,
  persona storage/settings/CLI/engine wiring, side sessions, PPT routing and
  Workbench tools/protocol/schema compatibility.
- `desktop-services.log`: 7 tests pass.
- `screen-fixed.log`: 8 focused remote-screen cases pass.
- `browser-regression.log`: 45 cases pass (New Bot catalog/error recovery,
  persona desktop/phone UI, 40 remote-screen cases, PPT render/edit/save/reopen/
  export and local assets).
- `webkit-regression.log`: 7 cases pass, including Chinese/English narrow
  controls and desktop/phone conversation isolation. This batch predates the
  final initialization-error guard; final guard results are recorded separately.
- `workbench-verified.log`: 25 Chromium cases pass; one pre-existing frame-call
  assertion fails because earlier native bridge installation now observes two
  legitimate mount-time visibility reads. The corrected action-window assertion
  passes in `workbench-frame-verified.log` (1/1). This covers all 26 cases, including
  chart layouts, board ownership/undo, drafts, ADHD, and desktop/phone switching.
- `workbench-webkit-verified.log`: all 5 final error-isolation, hidden-pane return,
  cancelled initialization, and desktop/phone conversation-state cases pass.
- `root-final-build.log`: standalone 491-module build passes.
  `client-verified-build.log`: translation, TypeScript and client production
  build pass. Existing Vite chunk-size/dynamic-import warnings remain.
- `native-screen.noindex/verification.json`: actual isolated Electron 45.1.0
  under production App permission policy / DesktopServices, four balanced
  HTML/native fullscreen entry/exit pairs, original 1100 × 760 bounds and
  editable local chat restored. Includes external HTML exit followed by X.
  The restored-window screenshot was inspected. Pixels/transport are synthetic;
  this is not real desktop capture, remote input, multi-machine/WAN, or installed
  App acceptance.

The first final Workbench batch had 10 passes and one initialization-gate failure;
three isolated repetitions had two passes and the same failure once. The retained
trace shows the browser fixture installed its desktop bridge after ADHD panes
mounted: pointer focus inserted the screen button between mouse-down/up, moving
the intended Workbench target. The fixture now installs the bridge before those
panes mount. Timeouts were not relaxed. One assertion now compares frame calls against the
post-mount snapshot (which must contain only read calls), so opening Workbench
still cannot add frame reads, sizing or positioning. The earlier task's separate
`markdown.create / workbench_app_unavailable` one-off failure remains unattributed;
a passing rerun must not be reported as its root cause being fixed.

## Evidence boundaries

No additional concrete defect was found in neutral visible labels, hidden sharing
entry, New Bot form, preserving explicitly saved accent choices, ordinary PPT
using the engine's native skill, or v1–v12 schema compatibility. Existing content
is not renamed and internal skill identifiers/attribution remain intact.

The AGENTS.md design intentionally uses an actual file read. Custom project
workspaces can place that Bot-owned file outside the engine's working directory;
manual/acceptEdits read approval remains applicable when that path is not already
authorized (confirmed by native Claude probes). Antigravity's existing whole-turn
approval/permission policy allowed the isolated external-file reads. App approval
card/session-grant behavior and Windows are not established by these probes.
Four existing Claude adapter approval-routing tests also pass
(`claude-approval-boundary.log`; other cases were not selected).
Opus's final source review confirms that TaroBot routes this native Read request
through its existing approval handler; no Host approval/re-read defect was found.
This audit does not broaden engine
working directories or disable approval. File save success is not proof that a
model read the latest content. Native Goal/continuation paths and installed or
physical-device acceptance are not newly established here.

The probes did not alter CLI settings or production Bot files. Antigravity wrote
three test conversations into its own session store, and Claude created an empty
project-memory directory even with session persistence disabled. Exact IDs and
paths are recorded in `opus/fix-review.md`; no cleanup of unrelated state occurred.
