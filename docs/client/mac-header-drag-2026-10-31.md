# Mac header dragging after scrolling — 2026-10-31

Blank space in the conversation title bar can stop acting as a window handle
after scrolling history. The Electron stylesheet applied `app-region: no-drag`
to buttons, inputs, roles and focusable elements throughout the whole document.
An offscreen history control could therefore subtract its unclipped rectangle
from the title bar's native drag region.

This is reproduced with Electron 45.1.0 / Chromium 156 on macOS 26.6.2, using
the production window constructor, preload, chrome installer and stylesheet,
an isolated profile, and synthetic content. Electron's
[upstream clipping report](https://github.com/electron/electron/issues/55476)
describes the same interaction. Its
[native-region debugger](https://github.com/electron/electron/pull/53598)
lets the actual hit-test region be checked separately from computed CSS.

## Change

- Declare drag only on explicitly marked handles, excluding `false` markers.
- Apply control/menu `no-drag` exclusions only inside those handles. Ordinary
  messages, scroll containers and composer inputs keep the initial `none` value,
  so they contribute no native exclusion rectangles.
- Keep full-page background handles shallow: their content stays selectable.
  Deep title rows retain blank-space dragging and interactive buttons. Image
  dialog headers are no longer blanket-excluded by a rule for the whole dialog.

The change is macOS Electron presentation only. Legacy Tauri, mobile, web,
Windows and Linux do not activate these Electron Mac chrome rules. Host,
protocol, stored data, attachment transport and headless CLI are unchanged;
a new CLI command is not applicable.

## Verification

- Chrome lifecycle unit tests: **10 passed**.
- Focused browser suite: **3 Chromium + 2 WebKit passed**. The new Electron
  region case is intentionally skipped on WebKit. Existing cases cover system
  button insets, narrow/fullscreen layouts, menus and image viewer gestures.
- Client translations, TypeScript and production build passed. Existing chunk
  size and mixed Capacitor Keyboard import warnings remain.
- Native isolated reproduction: a clipped history button's rectangle was
  `x=264, y=-25, width=697, height=60` after scrolling 500 px. Before the fix,
  Electron's debug overlay showed the missing title-bar area; a CUA click at
  `(680,24)` reached the page's `pointerdown` listener. After the fix, the
  history button computed `none`, the native drag region covered that point,
  and the same click no longer reached the page. Native region exclusions in
  this fixture fell from 5 to 1; this is a fixture count, not a performance
  benchmark.
- In that same native window, CUA clicked the header button successfully and
  edited the retained draft. Test profiles/assets stayed under a physical
  `.noindex` directory. No production Host or installed App was restarted.

**Native hit testing is verified; actual OS window displacement is not.** The
CUA drag gesture left bounds unchanged for both the fixed custom-title window
and a separate default OS-title-bar control window. That control prevents
calling the displacement check a product pass or failure. Verify real mouse
movement in the installed build after release, including scrolled chat/sidebar
history. This source fix does not itself install or publish a new App.

Evidence is retained in the task's `mac-header-drag-20261031` acceptance folder:
`baseline-scroll-hit-test.json`, `fixed-scroll-hit-test.json`,
`scroll-debug.log`, the CUA trace, unit/browser/build logs and isolated runners.
