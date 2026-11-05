# Explicit workbench split selection — 2026-10-31

Previously the desktop Split control immediately chose the active tab plus up to
three leftmost tabs. Selecting a specific set required context menus and
replacing individual regions. The owner requested a checkbox chooser.

## Behavior

- Split opens a compact chooser containing all open tabs, with the current
  visible selection checked and a live “已选 N/4” / “N/4 selected” count.
- Choose exactly 2–4 tabs. At four, unchecked options disable while checked ones
  remain available to remove. No layout changes until Apply.
- Apply orders the chosen tabs by the visible tab strip, preserves the active
  tab if selected, otherwise activates the first chosen tab, and exits pane
  maximization. Unchecked tabs and their contents remain open.
- Merge / Restore remain direct actions. The adjacent down chevron adjusts an
  existing split. Cancel, Escape, clicking outside, and leaving keyboard focus
  discard an unsubmitted selection. Phone mode has no split chooser and does
  not modify the saved desktop layout.

## Implementation and scope

`WorkbenchSplitPicker.tsx` owns the temporary checkbox draft and focus behavior.
It reuses the workbench overlay marker so native web pages yield while open.
`Workbench.tsx` owns the disclosure and the existing in-flight split guard.
`workbench-model.ts` adds a strict atomic `set-visible` layout action. Invalid,
duplicate or stale closed IDs reject without substitution. The existing
controller saves leaving editors and loads entering editors before one CAS
write. Failed saves retain the old layout; concurrent-window conflicts use the
existing adopt-and-report behavior, never automatically replaying stale intent.

No persisted schema, Host API, Bot browser authority, or native capture changes.
CLI impact: presentation only; existing headless workbench commands and layout
operations remain unchanged. This does not publish a release or update any App.

## Verification

- Client build passed; existing large-chunk and mixed Capacitor import warnings remain.
- 43 model/controller tests passed, including explicit selection, closed-tab
  rejection, atomic failed-save retry, and concurrent-window CAS conflict.
- Eight distinct Chromium journeys passed across the initial suite and focused
  reruns; five distinct WebKit journeys passed. Coverage includes arbitrary four
  of six, zero/one/four selection limits, cancellation, keyboard traversal,
  adjustment/replacement, persisted selection after reload, saved note/draft
  preservation, mixed note/board/browser panes, overlay hide/readback, English
  narrow-header fit, and phone return without changing the desktop split.
- Tests caught and corrected initial checkbox focus order, WebKit's skipped
  button traversal, and Escape after WebKit mouse clicks leave focus on body.
  Successful Apply restores focus after the DOM commit re-enables the trigger.
  Tab / Shift+Tab at the chooser boundary explicitly return to the adjacent
  toolbar control (backward to the trigger), avoiding WebKit skipping buttons
  and losing focus. Failed Apply retains the draft and restores keyboard focus
  for retry; the actual IndexedDB write-failure/retry journey passed in both
  engines.
- The browser native-layout fixture verifies `hidden=true` while the chooser
  covers a webpage, not removal of its view geometry. It is not a native
  Electron window acceptance test.

Opus 5.5 independently reviewed the model, controller, chooser, and overlay
boundaries and reran the 43 unit tests. Its findings were addressed: deterministic
success/failure focus, retained focus on Escape during Apply, pruning choices
when tabs close, backward Tab order, and disclosure-only ARIA semantics.
No installed App, release, or physical-device
acceptance is claimed. Local evidence and preview receipts are in
`/Volumes/gdrive/taro-tmp.noindex/workbench-split-picker-20261031`.
