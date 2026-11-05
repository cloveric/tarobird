# Remote screen header shortcut — 2026-11-03

The desktop conversation header previously offered remote viewing only through
Connection settings. It now has a separate View screen button immediately after
Workbench. A monitor/play icon distinguishes it from Workbench; the tooltip names
the current Host, and the open state uses the user's selected pale accent.
Click again closes the viewer through its existing disposal/Host-stop lifecycle.

The button remains discoverable when the target is unready. Opening the panel
only reads status; it does not start capture, grant a device access, request OS
permissions or start control. The panel explains disabled sharing, missing device
grants, offline desktop service, locking, denied capture or unavailable displays.
A recovery button opens Connection settings for the same Workspace/Host. Actual
connection still uses the existing fresh status read and Host authorization.

The existing non-Electron/phone viewer support boundary is unchanged: those
headers do not offer this desktop-only shortcut. This is an App entry/presentation
change. The headless `tarobot screens` commands, grants and protocol are unchanged.

## Validation

- `screen-entry.spec.ts`: 3/3 passed using the real Workspace/cache with explicit
  Host/native boundaries. Covers open/close/reopen, preserved draft, selected-Host
  switching, no implicit capture/grant, unavailable-state recovery, narrow layout,
  and hidden phone/web entry. The phone test initially stayed in the inbox; its
  navigation was corrected to open the chat before checking the header.
- `remote-screen.spec.ts` and `screen-settings.spec.ts`: 54/54 passed.
- Client translation check, TypeScript check and production build passed; existing
  chunk-size and Capacitor keyboard static/dynamic-import warnings remain.
- Header/open/narrow screenshots were inspected. A header preview was delivered.
  These are browser/IPC-fixture checks, not native capture, input or installed-App
  acceptance. No live permissions, pairing, host state or installed App changed.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/screen-toolbar-entry-20261103/`.
No release or installation is included.
