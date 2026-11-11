# Compact iOS bottom navigation

The iOS phone navigation had a 57.1875 px intrinsic icon/label/padding stack,
so its Compact setting could not reach the intended smaller row. The iOS-only
rules in `ios-adaptive.css` now fit a 49 px Compact row, a 52 px Standard row
and a 60 px Comfortable row. Icons increase from 22 to 24 px and labels from
11 to 12 px while internal spacing decreases. Larger text can grow the row.

The parent still reserves the complete current bottom gesture inset exactly
once. No fixed inset subtraction, viewport scaling or native safe-area change
is used. Android, web and desktop retain their existing navigation geometry.
CLI-not-applicable: this is client presentation only; Host state, protocols,
engine behavior and commands are unchanged. No release or installation occurs.

## Verification

- The regression first failed against the previous UI: rendered Compact height
  57.1875 px exceeded its 50 px upper bound.
- All seven layout-density cases passed across the final Chromium runs and
  across the final WebKit runs. Each browser's six non-iOS cases passed in the
  full run; the iOS case passed after correcting the test's English label.
- The iOS case covers three density choices, reload, six window sizes from
  320 px to 600 px wide, bottom insets of 0/21/34 px, tab switching, English
  labels and 200% navigation label size. Targets stay at least 44 px high and
  outside the gesture inset. Android's native window owns its inset.
- Host and client translation/type/production builds passed.
- The wider `iphone-duo` suite has three passing cases and one pre-existing
  failure in each browser: its split-window conversation title is 52 px wide
  against an assertion requiring more than 60 px. The same failure was reproduced
  with Chromium on unchanged baseline `e9f06c15841ca2cf1cf7bee2a8294a5bb6391784`.
  This is a separate header issue; do not report the whole Duo suite as passing.

Browser platform hints and injected safe insets are layout evidence, not
physical-device acceptance. The supplied real screenshot and test artifacts
remain outside Git. Uploads use the new private `cloveric/tarobird` repository
and its exact staged/outgoing privacy and Gitleaks gates.

## Separator spacing follow-up (2026-11-11)

The owner reported that the Message, Bot and Me icon/label groups sat too close
to the top separator on iOS. The phone-width iOS navigation now reserves 6 px
above its buttons, giving the groups more breathing room. The row keeps its
existing density sizing, icons, labels and touch targets. The full bottom
gesture inset remains separate; the navigation is 6 px taller and uses that
much more space above its existing bottom edge. Android, browser and desktop
geometry are unchanged. This remains presentation-only, with no Host/CLI,
dependency or native-code change.

Chromium layout checks cover all three platforms and density choices, seven
iOS window sizes (320–600 px wide), 0/21/34 px bottom insets, tab switching,
English labels and enlarged text. The iOS checks confirm the icon groups clear
the separator while buttons stay above the full gesture inset and text remains
inside its target. Navigation screenshots were visually inspected. Client
translation/type/production and standalone Host builds passed.

These are browser layout checks with injected platform/inset values, not
physical iPhone acceptance. This follow-up does not publish a release or
change an installed App.
