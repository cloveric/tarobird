# Avatar settings survive sidebar activity

## Confirmed failure

While choosing a built-in Bot avatar from the desktop sidebar, activity in a
different conversation can reorder the combined Bot list. Each combined row
owns a `ConversationList` slice. Previously, that slice's native settings dialog
and nested avatar dialog were descendants of the row's moving DOM subtree.
Moving the row removes both dialogs from the browser's modal top layer even
though their `open` attributes and React editing state remain set. The editor
then falls into the sidebar, moves with subsequent activity, and reopening
settings cannot recover the existing dialog.

The regression uses two real isolated Hubs, the combined sidebar, its right-click
Bot settings entry, and actual Hub message updates. Before the fix, Chromium
and WebKit both retain `dialog[open]` while losing `:modal`; the resulting
screenshot reproduces the avatar grid spilling into the sidebar.

## Change

- `ConversationList.tsx` portals the sidebar's dialog stack to the stable body
  overlay. This also protects conversation avatars, rename, move, group settings
  and archive confirmation dialogs owned by moving combined rows.
- Nested dialogs remain physically nested. Existing native Back, Escape,
  backdrop, drag and focus behavior is reused rather than reopening dialogs on
  every directory update. Selected avatars and unsaved forms remain mounted.
- Existing host/visibility/target guards still own rendering and teardown.
  React context retains the clicked host's connection, permissions and avatars;
  a portal does not select the active host or create a new host API path.
- `Avatar.tsx` supplies an explicit focus return target. On first load, disabling
  the trigger during the dynamic import can blur it before the dialog mounts;
  closing the editor must still return keyboard focus to its settings button.

This is App presentation only. Host/CLI commands, protocols, model execution,
avatar storage/revisions and image bytes are unchanged. No font, avatar size,
theme or mobile density changes are included. No installed App or Host update
is performed by this source repair.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp/avatar-modal-20261025/`.

- Baseline `red3-chromium.log` and `red3-webkit.log`: actual row movement loses
  native modality in both browsers; screenshots and traces retained.
- Regression checks retain the chosen avatar and exact dialog bounds through
  repeated activity reordering, exercise native Back and settings reopening,
  save to the correct Hub, preserve the main draft, and check the phone details
  entry at 390px. Desktop light/dark and phone screenshots are retained.
- Existing related suites cover avatar upload/sync/conflicts, same-ID host
  routing, old Hub capabilities, nested undo, group settings, folder movement,
  archive/restore and host-switch teardown.
- Two existing context-menu assertions omitted the already shipped `多选`
  action. Their complete expected menus are updated; the actions are unchanged.
- The native Back resize test now waits for the desktop-only React sidebar to
  mount, rather than only waiting for CSS to reveal a header button. CSS can
  respond before the media-query callback commits the desktop Back policy.
  The unchanged baseline passed in isolation; no Back production code changes.

Final results:

| Check | Result |
| --- | --- |
| Chromium final focused regressions (`final-chromium.log`) | 23 passed |
| WebKit final focused regressions (`final-webkit.log`) | 23 passed |
| Folder regressions in the earlier broad run, each browser | 24 passed |
| WebKit final screenshot/complete reorder journey (`screens-final.log`) | 1 passed |
| Client build (translations, TypeScript, Vite) | Passed |
| Standalone Host build | Passed; 445 modules |

The final focused run reruns all avatar, settings, nested navigation and context
menu cases after the focus fix and test corrections. Folder code and its portal
implementation did not change after the broad run. This covers 47 distinct cases
per browser (94 total), rather than claiming the initial broad run passed in full.
Screenshots disable transient CSS animations only for capture; the interaction
and reorder checks run with the existing animations enabled.
Browser evidence does not establish physical Mac/iPhone/Android shell acceptance.
