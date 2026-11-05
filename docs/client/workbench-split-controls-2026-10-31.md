# Workbench split controls — 2026-10-31

The workbench's primary layout operation was only in the per-tab menu. “Add to
split” on the active, already visible tab did nothing, and a first-time user
could not discover how to show the open tabs together.

## Interaction

- The desktop tab bar now has a labeled Split action. It remains visible with
  an explanation when fewer than two tabs exist. Two to four open tabs tile
  together; above four, the active tab and the first three other tabs are shown,
  in tab order. Other tabs remain open and selecting one replaces only the
  current region.
- Merge keeps the active tab on screen without closing or deleting any tab.
  A temporarily maximized region instead offers Restore, preserving the previous
  split composition and proportions. There is no duplicate region header in
  this single-page view.
- The global ellipsis is removed. Tab right-click/Shift+F10 and each open tab's
  action button in the tab list share the same commands. The list version has
  a Back to tabs action that restores the originating row and list scroll position.
  Escape returns focus to the stable list button.
  Phones use this touch-accessible list and continue to show one page at a time.
- Per-tab menus show Add to split only for a hidden tab with an existing region;
  a full four-pane layout keeps this command disabled with a visible explanation.
  Show only this tab and Remove from split are available only while a split
  exists. Single-page views cannot be emptied by a misleading remove action.
  Rename, ordering, Close and confirmed per-document deletion remain separate.
- Split/merge keeps keyboard focus while saving and ignores repeated activation
  during the pending operation. Visible split tabs are described to screen readers.
- A webpage in fullscreen must leave fullscreen before changing the split.
  Single visible pages remain flush with the tab bar; only simultaneous split
  panes have outer frames and spacing.

## State and scope

The new layout actions use the existing serialized controller, flush-before-hide
and compare-and-swap persistence. They do not close documents, mutate content,
change the schema, resize the App window, or create a new Host protocol. This is
local presentation/state management; no headless CLI command is required.

The related maximized-state corrections keep the displayed and selected tab
in agreement when choosing another visible tab, and clear maximized state when
only one region remains. The UI also normalizes legacy one-region maximized
state without requiring a migration.

No release or installed-App update is included. Browser/native-bridge fixtures
must not be described as real Electron page or physical-phone acceptance.

## Verification

Evidence directory: `/Volumes/gdrive/taro-tmp.noindex/workbench-split-controls-20261031`.

- Root independently ran the model, controller persistence, controller and layout
  unit suites: **55/55**, four files (`root-focused.log`). This includes the
  active-tab/maximized corrections, tile/single behavior, failed save and CAS.
  Opus additionally reported **103/103** across nine workbench unit suites;
  these overlap and are not added to the root count.
- Initial browser regression: **17/17 Chromium and 17/17 WebKit**. Coverage
  includes mixed note/board/browser panes, max-four/current-tab selection,
  saved content and drafts, maximize/restore behavior, phone layout recovery,
  per-tab targets and failed-save refusal. Native browser integration is a
  bridge substitute, not a real Electron WebContentsView acceptance.
- Existing content lifecycle checks: **3/3 Chromium** (local tab/side-session
  journey, independent canvas fit, and 2/3/4 image/whiteboard persistence).
- Opus reproduced focus loss caused by disabling the split button while the
  asynchronous change ran. Root reproduced it in the actual App browser fixture
  (`keyboard-red.log`). After fixing it, the affected suites passed again:
  **11/11 Chromium and 11/11 WebKit** (`final-chromium.log`, `final-webkit.log`).
  These are reruns, not 22 additional unique cases. Added checks cover retained
  keyboard focus, the source row on return, accessible split status, visible
  max-four explanation, English/Chinese narrow layouts and ADHD menu geometry.
- Client build passed (`client-build-review.log`): translation checks, TypeScript
  and Vite. Existing bundle-size and mixed Capacitor keyboard import warnings
  remain. Final cleanup only removed unused test helpers/imports and renamed the
  isolated fixture's temporary-directory prefix.
- Opus 5.5 independently reviewed the interaction, implemented the model and
  persistence regressions, then reviewed the final UI increment. His final report
  (`msgs/09-opus-final-review.md`) found no blocker. Low-priority inherited menu
  ID collisions and additional screen-reader/real-native acceptance remain
  separate from this layout change.

Desktop, expanded, narrow ADHD, and phone screenshots were inspected. The owner
received the direct Split entry and four-pane previews as App message
`msg_44d46257914d2729f30805a01568a8eb`. They are browser test screenshots;
installed desktop and physical-phone behavior has not been accepted in this task.
