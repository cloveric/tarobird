# Agent Bus desktop UI polish

This pass improves the existing desktop workspace rather than introducing a
different execution model. It follows an independent review by Claude Opus 5.5
at xhigh, using the current source and fresh screenshots. Suggestions were
checked against implementation and interaction tests before adoption.

## Configuration and navigation

- Participant cards separate role/status, Bot identity and record conversation
  into three rows. Conversation names use the card's full width; the permanent
  28px remove control occupies only the metadata row. Configured participants
  no longer all say “Selected”; keyboard/current selection and execution status
  remain distinct.
- Parallel connections branch through the middle gutter instead of drawing a
  frame around the graph. Each branch still originates at the coordinator;
  animation reflects recorded activity, not inferred progress.
- Clicking a configuration node reveals its member editor by scrolling only
  the panel. Adding a member also focuses the Bot selector without moving the
  board. Polling does not initiate this navigation.
- A long graph can hand wheel scrolling to the outer panel, which retains its
  own containment. The fixed five-role research team uses one outer scroll;
  its coordinator is not hidden in a shorter inner graph viewport.
- Trying a smaller collaboration mode temporarily retains the removed member
  bindings. Switching back restores them. Empty placeholder roles are not
  carried into other modes. Explicit add/remove, save or configuration reload
  clears the temporary pool; a conversation explicitly reassigned in the
  meantime takes precedence over a parked binding.
- Research limits remain available regardless of selected member, with local
  validation and accessible error descriptions. A saved/single-host workspace
  shows the host as a compact label rather than an unusable selector.

## Run preparation and feedback

Task input and permission preparation appear before the workflow. The footer
explains the condition blocking Start: connection/ownership, unsaved changes,
permission lookup, missing permissions, or an empty task. During execution the
unused task area is hidden while its draft state remains intact. This does not
add another task queue or allow a second simultaneous run.

Active and failed nodes have distinct borders in addition to status text.
Configuration/run tabs begin at the top of their own scroll container. A
dedicated “Participant workflow” translation avoids labeling every mode as a
Crew workflow. All colors use existing theme tokens; reduced motion remains
supported.

An existing permission snapshot stays visible during background checks; only
the first lookup shows a loading state. Start failures appear next to the Start
button with an accessible alert, instead of below an offscreen graph. Active
branches are painted last so an inactive parallel branch cannot cover their
shared connection. Canvas height updates immediately to make a newly added node
reachable; node movement retains its transition.

## Boundaries

No host, CLI, API, permission-grant, scheduling, stop, idempotency, run-snapshot
or conversation-history behavior changes. The CLI does not need a presentation
counterpart for these desktop controls. Mobile still has no Agent Bus panel.

The suggestion to label the default destination “new conversation” was not
adopted: the Hub can reuse an existing dedicated record conversation. Execution
still uses isolated sessions and does not resume that conversation's history.
Viewing one member's records and revealing all member panes remain separate
actions. Existing group placement, required name field, repeated Bot slots,
draft confirmations and the dock-return scrollbar repair are preserved.

## Verification

Independent Opus 5.5 xhigh review ran three rounds: initial source/screenshots,
implementation review, and final closure review. Its final review found no
remaining must-fix item in this scope. The proposed “new conversation” wording
was checked against the Hub and rejected, as described above.

Before changing the UI, browser checks reproduced the unreachable member editor
and the lack of an accessible reason for an unavailable Start action. Follow-up
review also reproduced canvas-height animation clamping the new-node scroll;
the fix preserves node movement while removing only that height transition.

- Focused unit/integration regression: 10 files, 200 tests passed, covering flow
  geometry, views/records, ADHD state, collaboration, Hub/Gateway/CLI and audit
  boundaries.
- Complete Agent Bus browser regression: 43 Chromium and 43 WebKit checks
  passed. Coverage includes member editor visibility, preserving temporary
  mode bindings, permissions/read failures, same-request retries, host identity,
  stale revisions, keyboard focus, long graphs, themes, reduced motion and
  existing chat drafts.
- Client translation validation, TypeScript and production build passed. After
  applying the final review's error-color suggestion, the uncertain-start and
  retry journey passed again on both browser engines against the rebuilt client.
- ADHD WebKit regression: 3 checks passed for workspace controls, wheel/live
  typing, and long queue containment in both ADHD and ordinary chat.
- An isolated macOS WKWebView test shell exercised saved Bus opening,
  configuration selection, add/select/remove, dock closing, and Crew reviewer
  selection. Across 452 geometry samples, maximum root overflow was 0px on both
  axes. The shell and its isolated Hub were stopped after verification.

Browser fixtures exercise the production client, pairing, directory, message
records and ADHD storage, with controlled Bus responses. This is desktop UI
acceptance, not proof of real agent execution, a mobile change, or replacement
of the installed macOS App. No production service was restarted.
