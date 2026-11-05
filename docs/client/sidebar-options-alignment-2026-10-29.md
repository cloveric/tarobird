# Desktop list-options alignment — 2026-10-29

The list-options button occupied a separate 38 px row above the first custom
folder. In the single-host desktop conversation list it now shares the first
folder heading's line, with room reserved for the 28 px button at the right.
The heading text, count, unread/attention indicators and button remain separate
hit targets.

This is a CSS-only presentation change. The menu keeps its original React owner
so creating/deleting folders cannot dismiss the folder manager by remounting it.
Phone layouts, mixed-host directories, and lists with leading global pins or
Agent Bus groups retain their existing layout. No Host, protocol, data, CLI
command, or model behavior changes; CLI is not applicable to this presentation.

Validation:

- Chromium and WebKit visual checks: heading and button centers both at 160 px;
  menu opens without folding the section, Escape restores trigger focus,
  long names at minimum sidebar width do not overlap the button, and removing
  the last custom folder leaves the list menu accessible.
- Existing Chromium regressions: list options (Chinese/English and keyboard
  focus), phone folder collapse, desktop/phone folder create/move/rename/delete
  with preserved drafts/history, and Agent Bus shared scrolling.
- Client translation/TypeScript/Vite and standalone Host builds passed.
- The first candidate moved the menu into the heading; the existing
  create-folder regression caught an open-dialog remount. That candidate was
  discarded; the final CSS-only change preserves the component tree.
- Browser preview is not installed-App acceptance. No release or installation
  is performed for this change.

