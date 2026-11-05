# Workbench opening and resize stability — 2026-11-03

The owner reported intermittent rebound and growth of the main chat when opening
the desktop Workbench. The repair preserves the existing rule: an automatically
expanded normal window reserves the right-hand column, while closing restores the
original window width. Maximized/fullscreen and insufficient-screen-space cases
keep their existing in-window split behavior.

## Reproduced causes

1. `App.tsx` asked the native window to expand before `useWorkbench.ensure()`
   finished initializing local state. There was no panel until initialization
   finished. The later lazy `Workbench` component used an un-sized loading aside.
   In the real App/Hub browser fixture, delaying initialization changed chat width
   from **1088 to 1488 px**; delaying the component chunk changed it to
   **1378.875 px**. Loading completion then returned that extra space to the panel.
2. After a native resize, the hook awaited a mode read to distinguish ordinary
   resizing from maximize/fullscreen. During that asynchronous gap, flex layout
   gave the width delta to chat; only the reply allocated it to the right panel.
   Controlled readback reproduced **728 → 908 → 728 px** for both side chat and
   Workbench. Final-geometry assertions alone had missed the intervening jump.

These are controlled timing reproductions, not frame recordings from the owner's
original incident. The installed App was not replaced or instrumented.

## Repair

- The desktop conversation renders a correctly sized loading column during both
  initialization and lazy component loading. It follows the native opening gate;
  a late response after Close cannot reveal the Workbench. The actual content
  retains its normal entry animation; the placeholder does not replay it.
- The native hook temporarily reserves the last confirmed chat allocation while
  reading the window mode. The right panel takes the intermediate extra space.
  Confirmed ordinary resizing then saves the panel width; maximize/fullscreen
  does not become a saved panel preference. A two-second deadline and cleanup
  release the temporary style if IPC never replies, fails or the panel closes.
- Size observation follows the visible direct-child panel after placeholder
  replacement and cached-surface switching. Hidden panels and absolute expanded
  views cannot become the measured dock. Mutation observation is limited to the
  shell's direct children and panel `hidden`/`class` attributes, not streaming
  chat contents or editor subtrees.
- The same resize hold is styled for the independent ADHD browser dock. ADHD
  conversation panes retain their existing behavior and do not resize the native
  window. No new loading column is introduced on phones or inside ADHD cards.

This is local App presentation only. Host/CLI APIs, model routing, content,
permissions, native window sizing commands and window lease policy are unchanged.
CLI is not applicable.

## Verification

Evidence is retained under
`/Volumes/gdrive/taro-tmp.noindex/workbench-opening-stability-20261103`.

- `loading-red.log`: both initialization/chunk-delay regressions failed on the
  original code, with the widths above.
- `resize-red.log`: both delayed-mode-read regressions failed on the original
  code. A first fix exposed a missing first-observer baseline; that was repaired
  before final acceptance.
- Window lease/planning tests: **36/36** (`window-unit.log`).
- Client translations, TypeScript and production build passed (`build-final.log`),
  with the existing bundle-size and mixed-import warnings.
- `native-final-v2/verification.json`: real isolated Electron 45.1.0, production
  preload/window IPC/hook/CSS, fixture content, no production Host or profile.
  **106 sampled display frames** across opening, closing, repeated cycles and
  resizing both surfaces kept chat width at **728 px**. The actual window minimum
  was enforced and restored to **600 × 480** on document retirement. Native size
  API calls exercise OS bounds; this is not a manual mouse-drag or installed-App
  acceptance claim.

- Browser coverage comprises **54 distinct passing scenarios**, verified in batches:
  window opening/resizing (33), Workbench/ADHD (13) and Workbench functionality
  including phone navigation (8). The initial broader run (`final-browser.log`)
  had 48 passes and three test failures: an existing Electron substitute returned
  `null` for window state, and the two new minimum-size assertions incorrectly
  expected 1652 instead of 1360 + 320 - 8 = 1672. The substitute now returns the
  native frame contract; corrected and expanded loading/cancellation cases passed
  in `loading-final.log` (5/5).
- Review also removed redundant re-observation of the same panel after a browser
  reported an undelivered ResizeObserver notification. The final hook passed
  `window-final.log` (33/33, including an explicit no-page-error check for hidden
  panels) and `app-final.log` (5/5: four actual App loading/close journeys plus
  ADHD native expansion). The final native run above used this same hook.

No release or local installation is part of this fix. Windows and physical mobile
acceptance are not claimed. Native API failure/timeout and unavailable screen
space still use the documented split fallback; no screen can be made wider than
its usable work area.
