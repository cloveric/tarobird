# Workbench frame correction — 2026-10-31

The Markdown editor could show a long black edge while typing. Its source-mode
focus shadow painted a 2px vertical inset beside the active pane's 1px frame.
Both used `--accent`, which remains black in the monochrome light palette even
when the user chooses a separate mark colour. The problem was reproduced with
both no accent and the warm-grey accent selected.

The active pane now shares the sidebar/resizer line colour: the selected mark,
or a neutral grey when monochrome has no mark. Its border remains 1px. Markdown
focus uses a 1px bottom inset in the keyboard-focus colour, so it no longer
stacks against the vertical frame. Forced-colour mode retains a system-colour
outline. There are no editor, storage, protocol or headless CLI changes.

Validation: client translations, TypeScript and production build passed.
The four existing `workbench-markdown` browser cases passed in Chromium and
WebKit, covering local resources, import/export, formatting, saved reload,
manual/Bot edit boundaries, IME, undo, failed saves, writer locks and split notes.
Separate visual probes cover docked/expanded/split/390px layouts, light/dark
warm grey, no accent and forced-colour focus. Browser evidence is not physical
device acceptance; no App release or installation was performed.

Evidence and the temporary visual probe are retained in
`/Volumes/gdrive/taro-tmp.noindex/workbench-border-20261031/`.

## Follow-up: single-pane continuity

The same rounded card and outer padding still surrounded a single visible page,
making notes, boards and browsers look detached from the tab bar. The workbench
now removes that padding, gap, border and corner radius when `data-count="1"`.
This count is the rendered pane count, not the number of saved/open tabs: phone
views, maximized panes and a single visible page among many tabs all stay flush.
Two to four simultaneous panes retain their existing thin frames, active mark
colour, spacing and resize handles. Inner editor/browser toolbar dividers and
keyboard focus indicators remain intact. Vditor's inner textarea no longer
rounds its lower corners, so its focus underline stays straight.

This is shared presentation CSS only. The pane tree, persisted layouts, document
contents, native browser layout notifications and headless CLI are unchanged.
No App release or installed update is part of this change.

Validation: the existing layout, phone, board, note and ADHD browser cases pass
in Chromium (8/8) and WebKit (8/8); client translations, TypeScript and production
build pass. Three old right-click selectors in the split scenarios were updated
to target the shared portal menu introduced by the prior tab-menu change.
Screenshot/computed-style review confirms zero padding, border, radius and gap
below the tab bar for single notes/boards, maximized notes and phone views;
two simultaneous notes retain 5px padding/gaps and 1px frames. Browser layout
tests use a native bridge substitute, not a real Electron page. No physical
device or installed-App acceptance is claimed. Evidence:
`/Volumes/gdrive/taro-tmp.noindex/workbench-flush-pane-20261031/`.
