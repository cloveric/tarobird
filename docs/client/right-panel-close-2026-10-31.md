# Consistent right-panel close geometry

The requested behavior is now explicit: closing side chat or the workbench
returns an auto-expanded desktop App to its pre-open width, keeping the main
chat at that original width. Moving or resizing the ordinary window while the
panel is open no longer silently makes the extra panel width permanent. Later
position and height changes are retained. This supersedes the earlier policy
that treated any window movement as a request to retain the expanded size.

Two causes were identified in the shared controller/hook:

- `sameSideWindow` compared position as well as size on close. A position-only
  move discarded the expansion lease, so closing filled the current wide frame
  with chat instead of shrinking it. The same happened after manual resizing.
- Closing stopped pinning the chat as soon as native IPC settled. The native
  frame could already be restored while Chromium still reported the expanded
  viewport. Both side and workbench regression cases failed on the previous
  source because `restoring` was removed before the renderer resize.

`side-window-expansion.ts` now returns the original CSS viewport only after a
confirmed native shrink. Normal close restores width, retains current height,
and avoids undoing a deliberate position move. Fullscreen/maximized/display or
scale changes and a non-resizable window remain guarded; the App does not force
those states back. Opening rollback still requires an exact owned frame, so a
failed opening cannot overwrite an unrelated resize.

`use-side-window-expansion.ts` pins the chat until the confirmed viewport arrives.
A two-second deadline releases that temporary layout if close IPC or a viewport
event never arrives, preventing a permanently unused column. Late callbacks are
scoped to the closing effect. Rapid reopening uses the original baseline, even
if the renderer still reports the old expanded width. Cross-Host transfer keeps
one serialized native-window owner and never stacks panel expansions.

## Verification

- 32 unit cases pass: normal/edge/scaled plans, changed position/height/width,
  display/window-mode protection, close receipts, failed reads/writes,
  opening rollback, cross-Host ownership and close/reopen races.
- 21 browser scenarios pass in Chromium and 21 in WebKit (42 passes): both
  right-side surfaces across the three desktop widths, delayed/absent native
  geometry, delayed renderer resize, native page reveal, closing cancellation,
  failed/stalled close and reopening before the close viewport event. The two
  new native-ack-before-renderer-resize cases were red before the fix.
- Client translation, TypeScript and Vite build pass. Existing chunk-size and
  mixed Capacitor Keyboard static/dynamic import warnings remain.
- Isolated Electron 45.1.0 window using the production native bridge, hook,
  controller and shared layout CSS was operated through CUA. Measured states:
  native width 1000 -> 1400 -> 1000; main width 728 in all three states; sidebar
  272; position (30,80) and height 700 unchanged; main draft preserved. The
  fixture uses synthetic content and no production Host. Native workbench and
  manual-resize permutations are covered by shared-controller/browser evidence,
  not claimed as separately executed native journeys.

The legacy Tauri fixture's manual-resize assertion was updated to the new
contract, but its automated native suite was not rerun. Windows native and
physical multi-monitor acceptance remain outside this verification.

CLI impact: not applicable; local desktop geometry only. No side-session, Bot,
Host API, workbench content, persistence schema or mobile navigation changed.
No release/install or production App/Host restart was performed.

Evidence:
`/Volumes/gdrive/taro-tmp.noindex/right-panel-close-20261031/` contains
`baseline.log`, `unit.log`, `chromium.log`, `webkit.log`, `build.log`,
`native-before.json`, `native-opened.json`, `native-closed.json` and the isolated
native runner. The test window was closed after acceptance.
