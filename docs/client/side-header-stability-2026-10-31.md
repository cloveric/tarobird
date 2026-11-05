# Keep the conversation heading still when a side panel opens

Opening native side chat or the workbench can widen a window from 1200 to
1600 CSS px while retaining the main conversation's 928 px width and the
sidebar's 272 px width. A viewport-wide media rule nevertheless changed the
conversation header's left padding from 20 to 28 px at 1500 px. This shifted
all leading header content, including the avatar and title, 8 px to the right.

The shared desktop header now retains its existing base 20 px inset on wide
windows too. Only that extra wide-screen inset is removed; no native geometry,
resize controller, animation, mobile rule, Host state or session behavior changes.
Headless CLI: not applicable, because this is header presentation only.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/side-header-stability-20261031`.

- Before the fix, the two 1200 px opening scenarios (side chat and workbench)
  both reproduced the 8 px drift: heading x=293 became x=301 while the main
  conversation remained 928 px wide. See `before.log` and its retained traces.
- `side-window-opening.spec.ts` now covers starting widths 1000, 1200 and 1500
  for both surfaces. It checks the leading heading position before native read,
  after native acknowledgement, through intermediate viewport resize, after
  opening settles and after closing/restoring the original width.
- The full focused suite passed: Chromium 14/14 and WebKit 14/14. This includes
  existing delayed read/resize receipts, cancellation, maximized/failure fallback,
  missing resize and workbench page visibility behavior. The breakpoint-crossing
  cases keep x=293 after the fix.
- Client build (translations, TypeScript and Vite) and standalone Host build
  passed. The Host graph contains 478 modules without retired transport SDKs.
  Existing Vite chunk/import warnings remain. `git diff --check` passed.

These browser fixtures exercise the production shared hook and CSS with a
native-window IPC substitute. They are not a fresh installed Electron/macOS
acceptance run. No App release, local update or production restart occurred.
