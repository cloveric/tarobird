# Compact phone composer accessories

The phone composer previously stacked the native task-list entry and Claude's
send-choice control on separate rows. Even with no background work running,
the task history entry occupied a whole row above “补充 / 排队”.

## Presentation

- A phone composer with the Claude selector places the task entry on the left
  and the existing segmented send choice and help button on the right.
- The short task label is “任务”, or “N 运行中” for active native tasks. Its
  accessible name remains “子代理与后台任务”; the original task dialog and controls
  remain available.
- Pending messages keep their own full-width row above the shared controls.
  Genuine stop-impact warnings stay readable on a separate line.
- A full background-group progress dock keeps its existing full-width layout:
  forcing it beside the selector truncated completed counts during visual
  review. Group provenance, task management and all counts remain intact.
- Desktop and composers without the selector retain their original layout.
  The input, text sizing, attachment actions and touch targets are unchanged.
  New compact task targets are at least 44 CSS pixels high.

`App.tsx` adds a presentation wrapper around the existing accessories;
`mobile-shell.css` applies the compact grid only where it fits. `EngineTasks.tsx`
accepts an optional short-label preference. The floating return-to-latest button
remains outside the grid and does not reserve a row.

No sending, queueing, task-control, polling, grouping, receipt or persistence
logic changes. Background cards remain read-only. CLI impact: not applicable;
this is App-only presentation, with no Host/protocol or command changes.

## Verification

The isolated browser fixture reproduces the screenshot's running Claude turn
with completed task history. At 390 × 844, the composer measured 146 CSS pixels
before and 104 after (42 fewer, about 29%). The task entry and selector now
share a row; neither overlaps the input. The 320-wide layout also fits.

`claude-send-choice.spec.ts` covers both widths, light/dark appearances, opening
task history, queue selection/editing, focus, a short viewport, and full
background progress with its management dialog, stop-impact warning and jump
back to the task card. Existing task and background-group suites cover desktop,
recovery, read-only cards and task-control behavior.

The active-background fixture seeds earlier history before starting a live
turn, then scrolls to that history to verify the offscreen-card dock. It does
not override production visibility or send behavior.

Client typecheck, translations and production build pass. Final focused browser
suites pass: Chromium 25/25 (`claude-send-choice`, `engine-tasks`,
`background-task-groups`); WebKit 17/17 (`claude-send-choice`,
`background-task-groups`). Logs are `verified-build.log`,
`verified-chromium.log` and `verified-webkit.log`.
Evidence: `/Volumes/gdrive/taro-tmp/phone-composer-tools-20261024/`.

These are browser/viewport checks, not physical keyboard or device acceptance.
This source change does not alter the already-published 1.0.109 artifacts and
requires a subsequent App build to appear in installed clients.

## Desktop follow-up — 2026-10-25

The owner requested the same compact row and short choices on desktop. The
shared rules now live in `claude-send-choice.css` and apply to desktop panes as
well as compact phone layouts. The task entry reads “任务” or “N 运行中”;
“补充 / 排队” is visible in both. Desktop radio accessible names follow those short
labels; the task manager keeps its “子代理与后台任务” accessible name. Existing
tooltips and the help dialog still explain current-turn versus next-turn sends.

Pending messages and stop-impact notices retain their full rows. Full background
group docks retain the original layout and complete counts. The normal composer,
ADHD panes and narrow desktop windows share the same presentation; task polling,
receipts, stop controls, queue operations and draft ownership are unchanged.
Phone touch targets and input geometry retain the previous rules. Expanded
native iOS/Android windows retain their previous presentation; desktop
compactness is not inferred merely from a mobile window becoming wider.

New browser cases exercise the task/choice geometry, task-list access, focus,
queue submission and help at desktop widths 1360 and 900 and in a three-column
ADHD pane, with light/dark screenshots. Existing phone, background-group and
Duo cases cover the shared-style boundary. CLI impact remains not applicable:
this is presentation only, with no Host or command behavior change.

Chromium and WebKit each passed **32 focused cases**. The ADHD fixture was then
tightened to populate three real panes and assert a sub-400-wide composer;
that case passed again in each browser. Client translation/typecheck/production
build and the standalone source build also passed. These are browser results,
not installed native-Mac or physical-device acceptance.

Evidence: `/Volumes/gdrive/taro-tmp/desktop-composer-tools-20261025/`.
Source changes require a subsequent App build; this task does not replace the
installed Mac App or publish another release.

## Wide-composer follow-up — 2026-11-01

The stop-impact notice was forced onto its own grid row even when the chat
composer had enough space for the notice, task manager and send choices. A
named inline-size container now measures the local composer. At 700 CSS pixels
or wider, the notice can share a row with the controls: notice on the left,
task manager and send choices on the right. A long translation can wrap within
the notice column without clipping text or splitting the controls across rows.
Narrow desktop, phone and ADHD panes retain the existing separate notice row;
a wide outer App window does not make a narrow chat qualify.

Pending-message previews and full background-group docks retain their own rows.
The task dialog, keyboard focus, send/queue behavior and phone touch targets are
unchanged. CLI impact: none; this is CSS presentation with no Host, protocol,
polling or command changes. No release or installed-App replacement is included.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/composer-accessories-row-20261101/`.

Validation: the original two-row screenshot layout was reproduced in an
isolated Hub/App fixture. The final layout check passed in Chromium and WebKit
at desktop viewport widths 1360/1100/900 and phone widths 390/320, plus English
at 1360/1100. It checked row geometry, overflow, full warning visibility,
44-pixel phone task targets, task-dialog access and retained draft/focus when
choosing the next-turn route. Six existing focused Chromium cases also passed
(desktop, narrow desktop, three-column ADHD, Android 320, iOS 390 and the full
background-group dock). Translation checks, TypeScript and the client production
build passed. These are browser/viewport results, not installed Mac or physical
phone acceptance. Layout probes and before/after screenshots are task-local;
no new application behavior or test fixture was added to the repository.
