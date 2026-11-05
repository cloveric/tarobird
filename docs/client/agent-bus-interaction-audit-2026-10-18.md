# Agent Bus hands-on interaction audit

This follows the [independent source audit](agent-bus-independent-audit-2026-10-18.md).
Claude Opus 5.5, configured with `xhigh` effort, operated the actual application
through its Chrome computer/browser tools. It first explored the UI without
reading source or earlier findings. The implementation reviewer independently
operated a separate tab, reproduced findings, and added failing regression cases
before repairs. The baseline was `ddb1fa0`.

## Environment and journeys

The isolated application used the production client and real Hub, SQLite,
signed pairing, durable queues, Gateway/outbox, local Bus listeners, permissions,
workflow scheduling and cancellation. Five deterministic model substitutes made
normal completion, slow cancellation and deliberate research failure repeatable.
The lab was bound to loopback, used disposable external-disk state and did not
restart or change production Bots.

Opus explored three groups of journeys:

1. Create and name a chain, choose participants, save, reopen from the sidebar,
   start a task and locate member results.
2. Change member order, add a member, stop slow work, reuse the saved Bus, retain
   unsent drafts, and execute a five-member research team with both success and
   deliberate failure.
3. Incomplete configuration, duplicate and long names, board capacity, cancel
   and delete confirmations, keyboard navigation, panel collapse/reopen, and
   light/dark appearance. Eleven baseline screenshots were retained.

Native browser operations are evidence for the application interactions. The
model output is synthetic, and the five workers share an isolated process.
This does not establish packaged Tauri acceptance, native worker restart,
physical Windows behavior or real-model answer quality. During the baseline
pass, the browser tool reported window resizing success without changing the
measured viewport; narrower baseline acceptance is not claimed. The second pass
records its own observed dimensions below.

## Reproduced issues and repairs

| Issue | Evidence and resulting behavior |
| --- | --- |
| Cancelled parallel work claimed to have results and exposed cancellation exceptions | The reviewer and Opus both stopped a slow Fan before any answer. The shared command now distinguishes zero, partial and all completed results, preserves actual failures observed before cancellation, and renders explicitly cancelled branches as stopped. Cancellation is captured from the abort signal when each branch settles, never inferred from error text. |
| A disabled Create/Save button did not explain incomplete configuration | An empty name looked like a real title because its placeholder was “new collaboration.” The placeholder now asks for a name. The existing footer shows one actionable reason from the shared schema, in form order; name validation is associated with the input for assistive technology. |
| Invalid research limits remained hidden after changing modes | A fractional Crew limit prevented saving Ask/Fan even after that control disappeared. Leaving Crew resets only invalid hidden limits to the shared schema defaults; valid choices remain. |
| Selecting a Bus left its new members below the visible board | With several rows already open, the panel changed but the board stayed on earlier conversations. Explicit selection/reveal now returns to the overview and scrolls to the first available participant, preferring the coordinator. It preserves pane order, prior conversations and drafts, does not move keyboard focus, and does not scroll on background polling. Full capacity never evicts another conversation. Selecting an individual graph node retains its existing single-pane behavior. |
| A completed run retained an actionable Stop confirmation | The captured run may finish while the confirmation is open. An expired confirmation now states that it is no longer current and only offers Close. A newly started run cannot inherit that confirmation; the final stop identity guard remains in place. |
| A delayed send stole focus from another ADHD conversation | The broader WebKit regression failed after focusing host A while host B's offline send finished. The original test passed five unchanged reruns, but delaying the real IndexedDB draft-clear receipt reproduced the race deterministically. Send completion now restores focus only while the sending composer retains it. Moving to another pane or sidebar prevents restoration, including pointer interaction with a non-focusable area. Normal same-composer restoration remains. This was a focus race, not a host-ID routing failure. |
| A deleted Bus retained its missing-member warning | The board capacity warning still referred to a Bus after it was deleted. The warning now carries its source workspace/host identity; deleting that workspace clears only its own still-current warning, preserving unrelated notices. |
| Expanding a short conversation retained an obsolete latest-message button | A strict reproduction in both browser engines first scrolled a narrow pane upward, then expanded it: the complete history fit, with scroll height equal to viewport height and scroll position zero, but the button remained. Resize reconciliation now clears it only after the real tail and all loaded rows fit, with no active reading gesture or pending Markdown measurement. A long-history control preserves the button and reading position. |

## Findings that do not justify deleting data or changing execution

Previously opened ADHD panes are intentionally retained when another Bus opens.
Automatic removal would discard the user's working arrangement and threaten
unsent drafts. The repair reveals the chosen Bus without clearing the board.

Member conversations retain earlier completed runs. A latest-run “not executed”
badge beside an earlier answer is not proof of a new execution or reused output.
Deleting a Bus also deliberately preserves member conversations and messages;
the confirmation describes this boundary. These histories must not be silently
deleted to simplify the screen.

Duplicate names remain valid labels; identities and records are bound by IDs.
An 80-character input limit and browser-native select behavior are not evidence
of task loss. Additional presentation ideas from the exploration are recorded
separately from confirmed lifecycle defects.

The remaining review items are explicitly bounded:

| Opus finding | Disposition |
| --- | --- |
| A4: internal IDs and English workflow terms in progress text | Confirmed presentation debt. Friendly names and localized shared workflow text require a follow-up across App and CLI, with immutable IDs retained for routing. This pass does not claim that wording is fixed. |
| A5/A6: retained panes, duplicate names and historical conversation names | Retention and ID-based identity are intentional. Optional “only this Bus” filtering, duplicate-name guidance and managed-conversation rename assistance remain design work; no automatic eviction, renaming or deletion was added. |
| A7: graph status trails message events by roughly 1–2 seconds | Current polling freshness limitation. Stop remains bound to the captured run and server-side checks. Live event-driven graph updates were not introduced. |
| A9: a latest-message button remained after expanding | Confirmed after a strict geometry-based reproduction and repaired above. Merely expanding a long conversation must not clear the button or resume following. |
| B1/B5/B7: distinguish run history, open historical runs, and consolidate progress bubbles | Useful product improvements, kept separate from this repair. Earlier results remain available and are not presented as new execution evidence by the run graph. |
| B2–B4/B8–B11: entry discovery, editor focus, consistent wording/numbering, name counter and dialog spacing | Design follow-ups. Real IME Escape behavior was not manually verified. The attempted double-click Save did not start a task, so that possibility is not reported as a reproduced execution bug. |
| Narrow-window overlap observed in the second pass | At 1000 px, the existing CSS deliberately turns the dock into an overlay below the 1360 px breakpoint. Covered pane controls require closing it first. This remains a responsive-design limitation, not evidence of lost panes; a simultaneous-view redesign was not included. |
| Small validation/accessibility and polling observations | Spacing around numbered member names and associating the disabled save button with the footer hint remain refinements. Opus observed about 200 requests over 20 seconds with 12 panes open, including queue, steering and health requests. That is a local observation, not a production performance benchmark; polling consolidation remains follow-up work. |

## Entry points and compatibility

The Fan wording change is in shared command handling and applies to existing
App and headless CLI entry points. It does not add commands or change queue,
permission, replay, host identity or database semantics. All other changes are
client interaction and presentation fixes; they need no separate CLI command.
Agent Bus remains local to one host.

## Verification

The final frozen source passed `VITEST_MAX_WORKERS=4 bash scripts/pre-complete-hook.sh`:
**338 files, 4,596 tests passed, one Windows-only check skipped on macOS**. It
also validates repository secrets/history and the standalone host build. The
client production build passed separately.

The adjacent browser matrix passed 68 Chromium cases. WebKit passed 67 and
exposed the focus race described above; that failure was investigated rather
than discarded after a green retry. After its deterministic reproduction and
repair, the original same-ID two-host case, delayed-receipt case and pending-send
ownership case passed in both engines (three per engine). The expired Stop
confirmation passed in both engines. Targeted results overlap the matrix and
are not a sum of unique scenarios.

The final board-navigation group passed three cases in each engine, covering
saved/opened Buses, preserved single-node expansion, full-board fallback and
deletion of capacity notices. It includes auto-column changes during the dock
transition, reduced motion, cancellation by user scrolling, and a follow-up
assertion that reopening the dock cannot revive a cancelled scroll intent.
The Fan stop suite has 53 passing focused checks, included in the full gate.
The final latest-message-button group passed three cases in each engine:
short history fits after expansion, long history still overflows, and the
existing live-typing/wheel/streaming reading-position journey. The client was
rebuilt after this final repair, before the final full regression gate.

Automated workspace browser cases use the production client and isolated Hub
with controlled Bus API fixtures. They complement the manual lab's real Bus
transport and workflow execution; they do not replace it.

## Second hands-on pass

Opus operated the repaired lab at an observed **1000 × 683** viewport, using
clicks, typing, native selects and scrolling. Six requested journeys passed:
missing configuration hints, invalid hidden Crew limits after mode changes,
early Fan cancellation, expired Stop confirmation followed by another run,
sidebar reopening/member reveal with drafts and pane order retained, and
deletion of the owning Bus's capacity notice. Six screenshots were retained,
including the A9 counterexample. During a measured 20-second interval with real
Bus polling, the manually chosen board scroll position stayed unchanged.

This pass also independently reproduced A9: after expansion, scroll height and
viewport height were both 492 px with scroll position zero, but the button
remained. That report was not relabelled as a pass. The subsequent final repair
passed the strict automated cases above. A separate final manual check retained
the button while an expanded task still overflowed (1158/1012 px), then cleared
it when folding the task made all content visible (1012/1012 px, position zero).
The delayed IndexedDB focus race was verified by controlled regression, not
claimed as a manual reproduction by Opus.

The lab retained its test history and was shut down after verification. The
installed desktop App and published release are unchanged by this source audit.
