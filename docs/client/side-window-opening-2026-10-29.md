# Side panel opening order — 2026-10-29

The owner observed the temporary side conversation briefly appear to the left
of its eventual position, then move right. An isolated browser fixture using the
production window hook and layout CSS reproduced the ordering defect before the
fix. No production Host, model session or installed App was changed.

## Cause and repair

The pending native-window state painted the side panel against the old window's
right edge and immediately ran its entry animation. Native frame acknowledgement
could arrive before the WebView width changed. The hook then selected `split`
from that old width, before a later resize event selected `expanded`.

With a 1000px viewport and requested 400px extension, captured baseline frames
showed the panel begin near x=600, become an inline split near x=672, then move
with the growing right edge. The main conversation also temporarily shrank from
728px to 400px. This is a presentation-order defect in automatic window expansion;
it does not establish that the user's own frame timing was measured.

The pending state now preserves the main width and does not paint, animate or
activate the side content. The hook waits for the native decision and, when
expanding, the matching WebView width. Only then does the existing right-edge
entry animation start. `App.tsx` defers the child visibility flag too, so its
existing autofocus runs after the panel becomes visible. Animations remain on.

Fullscreen/maximized/unavailable-native cases resolve directly to the existing
split. A missing WebView resize falls back after two seconds rather than leaving
an invisible panel indefinitely. The initial 500ms candidate exposed its fallback
too early in the delayed WebKit test and was replaced before final verification.
The reveal timer is cleared on presentation and cleanup; closing during the wait
does not reopen the panel. Later manual resize and guarded native restoration
retain the existing behavior.

This is App presentation only. Host APIs, side sessions, queue dispatch, models,
permissions and headless CLI behavior are unchanged.

## Verification boundaries

Evidence: `/Volumes/gdrive/taro-tmp/side-opening-20261029`.

- Before the production change, the new opening regression failed its pending,
  native-acknowledgement and intermediate-width frame checks. The existing final
  geometry check alone had not detected the defect.
- Five final browser journeys passed in Chromium and WebKit (10 executions):
  delayed native geometry and intermediate resize, maximized split, failed native
  read, missing WebView resize, and close during the delayed reveal.
- The existing 25 window-controller unit cases passed.
- Three existing Chromium journeys passed for conversation/draft retention,
  side follow-up/stop/close, and desktop-only eligibility.
- Client translation validation, TypeScript and production build passed; the
  standalone Host build also passed.
- The native macOS fixture was rebuilt with the real hook/CSS, the entry-animation
  stylesheet and 40 opening-frame assertions. CUA native startup failed twice,
  so this fixture was **not run** and native frame acceptance remains pending.

The installed App has not been updated. Browser WebKit coverage does not replace
installed macOS/WKWebView or physical Windows acceptance.
