# Settings dialogs move independently of the desktop window

Dragging the small Connection status & routes dialog moved the entire Mac App.
`desktop-window-chrome.ts` explicitly marked both preferences and non-movable
creation-dialog headers as native window handles. ConnectionPanel and
PreferencesPanel had no local drag controller, so the behavior matched that
incorrect routing. The focused marker regression failed on the previous source.

ConnectionPanel, PreferencesPanel and its pairing flow now reuse `useDialogDrag`.
Settings pages built with `CreationDialog.mobilePage` opt into the same controller
on desktop. The existing controller preserves pointer capture, reachable bounds,
resize/phone transitions, input values and normal header button actions. Phone
and coarse-touch layouts remain fixed pages. Other confirmation dialogs stay
fixed unless already opted into local movement; their headers no longer drag the
native App either.

Small dialogs are removed from the automatic native-handle selectors. Electron
also suspends shell handles while a settings/creation dialog is modal, including
nested confirmation, and restores them after the last modal closes. This keeps
an underlying title bar from claiming a pointer meant for the small dialog.
The reset uses `app-region: initial`: explicit `none` is serialized as `no-drag`
by Chromium, whereas the initial value contributes no native region. No global
or viewport-sized `no-drag` rectangle is added. Full-window file and image
surfaces keep their existing behavior.

## Verification

- 10 window-chrome unit cases pass. Before the fix, the new small-dialog marker
  expectation failed while the other nine cases passed.
- Nine distinct browser cases pass: settings focus, desktop/phone nested route
  editing, and creation-dialog dragging in both Chromium and WebKit, plus the
  Chromium native-region CSS case. Checks include preserved unsaved route text,
  discard/continue editing, close/return focus, settings/network-dialog movement,
  fixed phone pages, creation bounds/resize/reopen, and last-modal handle restore.
- The existing creation geometry case sampled the opening scale before settling
  (4.05 px discrepancy). The same failure reproduced against unmodified main's
  built client. Its measurements now await the dialog's own entry animation;
  product animations and the drag controller were not changed for this test.
- Client translation check, TypeScript and Vite build pass. Existing large-chunk
  and mixed Capacitor Keyboard import warnings remain.
- Isolated Electron 45.1.0 acceptance used the production chrome installer/CSS
  and local drag hook, with a test-only settings shell and isolated profile.
  CUA moved the dialog from (240,170) to (360,90); the native BrowserWindow stayed
  at (140,120), 1000×640. The input remained intact. After CUA clicked Close,
  the dialog disappeared and both shell handle regions returned to `drag`.
  A separate instrumented run moved the dialog to y=20 and confirmed a new
  pointerdown at y=51 reached its heading, despite overlapping the shell header.
  Some repeated CUA drag sequences delivered intermediate pointermove events
  with buttons=0 and did not complete movement; those are not counted as a
  native continuous-drag pass. Full component workflows are the browser checks
  above, not this small native fixture.

CLI impact: not applicable; this changes local dialog presentation and pointer
routing only. No Host, pairing, network routes, model behavior or stored settings
schema changed. Installed App/Host were not restarted or updated; no release was
published. Physical mobile and Windows acceptance were not performed.

Local evidence is under
`/Volumes/gdrive/taro-tmp.noindex/settings-dialog-drag-20261031/`:
`baseline-unit.log`, `unit.log`, `chromium.log`, `webkit.log`,
`chromium-final.log`, `webkit-final.log`, `creation-baseline.log`, `build.log`,
`native-before.json`, `native-moved.json`, `native-overlap-instrumented.json`
and `native-closed.json`. The native test process was closed after verification.
