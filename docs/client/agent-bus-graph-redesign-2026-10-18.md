# Agent Bus participant graph

The desktop workspace now shows its actual coordinator and members as clickable
cards connected by the selected collaboration flow. It replaces the fixed icon
illustrations and the full member form stack. The selected node opens one member
inspector; clicking a node in Run locates or reopens only that record conversation
in ADHD. Other panes and drafts are preserved, including the twelve-pane limit.

## Layout and state

The five collaboration choices share one compact row. A 440-pixel dock leaves
room for conversations on wider screens; below 1360 pixels it becomes an overlay.
The dock clips a stable-width panel during its opening animation, so node layout
does not chase each animation frame. Node spacing is compact enough for the
five-person Crew graph to fit its own viewport at a 1440 by 960 desktop size.
Larger teams and shorter windows scroll within the graph without shrinking text.
Names and stage labels truncate visually while retaining full accessible text
and titles. The Bus name is edited directly in the header; Crew limits belong
to the coordinator inspector. Configure and Run keep independent selections.

Configure shows the draft and one member inspector. Run shows the most recent
run's immutable configuration snapshot and recorded stages. The tabs are kept
intentionally: editing a reusable definition must not relabel the previous run.
A notice identifies when the next task will use a newer configuration. Node
selection, adding, removal and reordering preserve the member/record binding.

The graph follows the existing execution rules:

- Ask delegates to one member and returns the result.
- Fan branches to selected members while the coordinator also answers. It does
  not imply an additional synthesis stage.
- Chain passes results through ordered members; the coordinator dispatches.
- Verify shows an answer followed by review and result delivery, not an automatic
  rewrite of the answer.
- Crew shows planning, research, analysis, writing and review. Its return edge
  exists only when revision rounds are allowed. Repeated writing activates that
  edge only when a matching stage is actually running. The number of research
  subtasks is not invented from the configured upper bound.

Status never participates in geometry. Polling therefore does not reorder or
remount nodes or scroll the graph. Only observed running stages animate their
incoming edge. Queued, stopping and terminal runs do not animate edges. Stopping
has its own pending icon rather than being presented as already cancelled.
Partially successful multi-step members show their actual completed count, even
while the team continues. A single failed stage with no usable results still
shows failure; the overall run status remains visible independently. Explicit
marker colors keep arrowheads visible in WebKit as well as Chromium.
Hidden panels pause graph animation; reduced-motion preferences disable it.
Native buttons support keyboard activation and expose role, Bot name, selection
and status to assistive technology.

## Pele evaluation

[Pele](https://github.com/obsidianmd/pele) informed the restrained SVG line work,
but is not added as a runtime dependency. The evaluated 1.6.0 public API returns
rendered SVG, dimensions and links, not stable coordinates for interactive HTML
nodes. Extracting coordinates from private SVG internals would couple our
selection, authenticated avatars, focus and animation to an undocumented format.
For five bounded topologies and at most twelve participants, React buttons and a
small SVG connector layer provide the interaction directly. No arbitrary edge
editor or new execution engine is introduced.

## Boundaries

This is a desktop presentation change. Host APIs, stored definitions, permissions,
queue admission, cancellation, idempotency and cross-host boundaries are unchanged.
CLI: no new command is needed; existing `tarobot bus` commands use the same host
capabilities. The phone gains neither ADHD nor this graph editor.

The implementation and risks were reviewed independently with Claude Opus 5.5
at xhigh effort. A separate reviewer checked geometry and state semantics, and
browser QA exercised the production client with isolated Hub state. Controlled
stage fixtures validate UI states; they do not represent live model work.

## Verification

- Full repository gate: history privacy checks, standalone host build, and 337
  Vitest files passed (4,539 tests passed, one platform-specific test skipped).
  Focused topology/view coverage passed 15 tests; privacy-guard script coverage
  passed three tests. Client translation validation, TypeScript and production
  build passed.
- Browser coverage: 26 distinct journeys in Chromium and WebKit (52 engine/case
  pairs): 15 Agent Bus journeys, eight adjacent ADHD journeys, two collaboration
  setup journeys and one delegation journey. These ran across frozen builds;
  affected cases were rerun after fixes, not all 52 repeated on the last build.
  The final six pairs specifically rechecked creation/arrow rendering, run versus
  draft selection, partial Crew results, stopping, hidden/reduced motion and
  stable dock width.
- The Bus suite includes an isolated real-Hub stage-record journey in both engines.
  Controlled API fixtures cover additional states and failure receipts. Neither
  is evidence of real model answer quality. No packaged Tauri, native background
  lifecycle or physical Windows test was performed in this redesign.
- Light, dark, CLI palette, English, long names, a twelve-participant graph and
  reduced motion were checked. Final WebKit screenshots visibly confirm the
  arrowheads and partially successful research continuing into analysis.
- Two harness errors were corrected without weakening product assertions: hidden
  mounted DOM needs a DOM locator instead of an accessibility-role locator; the
  existing delegation offline-reload test requires its service worker, so the
  temporary shared runner must not block it globally. Original failures and
  successful reruns are retained in local evidence.

Confirmed issues fixed during review: dock expansion relayout, premature
cancelled styling, misleading all-failed treatment of partial research, WebKit
arrowheads, and the English Run/Uptime translation collision. Configuration and
run selection were also separated, and long status labels now truncate safely.

No production Hub, installed App or release artifact is replaced by this
implementation task.
