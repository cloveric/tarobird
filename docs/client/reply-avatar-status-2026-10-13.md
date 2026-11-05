# Reply activity without portrait frames

The previous working/pending styles outlined custom Bot pictures, producing a
rounded black box in the monochrome palette. Default portraits instead received
a glow, so selecting a library picture changed the activity treatment.

`brand-theme.css` now places three 3 px dots below the message avatar. Pending
messages show a static muted marker; streaming replies fade gently over 2.4 s.
The picture itself stays still and has no activity border or glow. The existing
message state removes the marker on completion, error or disconnection. The
header keeps its existing localized reply text and no longer frames its avatar.

The marker is absolutely positioned and does not alter virtual message heights.
Reduced motion disables its animation. Pixel mode uses square dots; CLI mode
keeps its transcript gutter on a separate pseudo-element and places the dots
above it. Defaults and custom pictures share the same treatment on both layouts.

## Verification

- Production client translation, type and Vite build passes.
- Isolated Hub/browser preview in Chromium and WebKit: 24 combinations per
  engine covering phone/desktop, default/custom pictures, monochrome/CLI/pixel,
  and light/dark. Rendered portraits have no activity shadow or filter; reduced
  motion leaves static dots. Completion removes them, pending stays static, and
  disconnect removes the pending marker. Phone and desktop screenshots inspected.
- Existing `stream` journeys pass in both engines, including unchanged card
  widths through reasoning, tool calls and completion, and durable stream replay.
- Standalone build passes. The initial parallel full suite had six failures in
  the unchanged service timing tests; that file then passed all 172 tests alone.
  The complete suite with four workers passes: 230 files, 2,935 tests, one skip.

This source update does not replace an already published installer. Physical
Android/macOS rendering is separate from these browser checks.
