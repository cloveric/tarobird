# Baoyu canvas and PPT wheel navigation

The owner reported that a small wheel action sent the presentation far away.
In the actual canvas editor, both the empty viewport and the nested artboard
forwarded a 120 px wheel event as a 120 px on-screen translation. The viewport
zoom function also allowed a single modifier-wheel event to reduce scale by 20%.
This explains a reproducible sensitivity problem; it does not establish the
precise delta emitted by the owner's physical mouse.

The build adapter now uses one canvas-only response for both editor variants
and for canvas artboard forwarding. It converts pixel/line/page units, preserves
small movements up to 12 px, and smoothly limits larger event travel to 60 px.
Diagonal motion retains its direction and shares the same travel budget.
Modifier-wheel zoom retains its cursor anchor and limits one event to roughly
7–8% scale change. Consecutive events still allow deliberate long-distance
navigation; this is not a total gesture-distance lock.

The change runs after upstream native-scroll decisions. It does not intercept
App scrolling, editor menus, text editing, touch dragging, Safari gesture
pinches, image-crop controls, or presentation-mode slide changes. PPT keeps its
fit/minimum-zoom boundary. No upstream vendored bytes or saved documents change.
Exact adapter match checks and vendor hashes must be revalidated on upgrades.

CLI impact: none; this changes local pointer navigation only, with no new
protocol, model guidance, storage or permissions.

## Validation

Evidence lives in `/Volumes/gdrive/taro-tmp.noindex/baoyu-wheel-20261103/`.
The original canvas background and nested-artboard regressions both failed with
120 px travel. The initial PPT test incorrectly assumed a fitted slide could
pan; the final regression enlarges the slide through its actual zoom menu first.

Final checks:

- Five unit cases passed (fine movement, accelerated/diagonal travel, line/page
  units, bounded reversible zoom, invalid input).
- Three production-build Chromium editor cases passed: canvas background,
  nested artboard, and zoomed PPT. Browser mouse wheel input of 120 px moved
  the content about 44.4 px in all three. Synthetic line/page and modifier
  events also verified bounds and unchanged scale during ordinary panning.
- Both existing edit/save/reopen/export regressions passed, including PPTX and
  canvas project import/delete. Canvas initially exceeded its 20-second editor
  load assertion while suites ran concurrently; the identical test passed when
  rerun alone. No assertion was weakened and no production code changed for it.
- Host standalone and client production builds passed; existing large-chunk
  and ineffective dynamic-import warnings remain.

This is source and isolated Chromium editor evidence, not physical-mouse,
installed-App, phone or WebKit acceptance. No release or installation is
performed as part of this fix.
