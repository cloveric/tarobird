# Workbench tab context-menu position — 2026-10-31

Right-clicking a tab only set its menu ID. The menu was still rendered inside
`.workbench-tab-actions` with `right: 5px`, so it appeared under the far-right
toolbar instead of at the clicked tab. Both docked and expanded workbenches
reproduced the defect; the new geometry checks fail against the baseline.

Tab context menus now reuse `DesktopMenu` with the actual pointer coordinates
and a body portal, escaping the horizontally scrolling tab strip. Its existing
viewport clamping, outside dismissal, ancestor-scroll/resize dismissal and
keyboard/focus handling apply. Shift+F10 and the context-menu key use the tab's
bounds as the anchor. Toolbar disclosures keep their current positioning and
phone controls. The context menu keeps the workbench delete colour.

The menu continues to operate on the clicked tab ID, including when another tab
is selected. A disappearing target or hidden workbench removes the menu. The
shared `.desktop-menu` overlay is already observed by the native-browser
visibility coordinator, so the portalled menu remains an overlay boundary.
No browser capability or command contract changes.

Regression coverage exercises the docked/expanded geometry, inactive-tab
rename, unchanged active note/content, keyboard entry and Escape focus return,
resize dismissal, and switching back to the toolbar menu. Existing toolbar
keyboard and phone close/delete cases remain in the focused browser run.

This is presentation-only; Host/Bot/CLI operations and persisted documents do
not change. Tests use isolated data. No owner workbench is modified, and no
release or installed-App update is performed. Browser results do not establish
native Electron or physical-device acceptance.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/workbench-tab-menu-20261031/`.

## Verification

Eight distinct Chromium/WebKit cases passed (four in each engine), including
the existing phone and toolbar flows. Client translations, TypeScript and the
production build passed; existing chunk-size and Capacitor Keyboard import
warnings remain. Two baseline geometry cases failed before the fix.

The additional same-tab toolbar handoff test initially clicked a button centre
covered by the context menu in the narrow dock. It now clicks the exposed upper
edge without forcing or bypassing hit testing; both browser rechecks pass.
Repeated runs are not counted as additional coverage.
