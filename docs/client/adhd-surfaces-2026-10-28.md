# ADHD workspace surfaces and message layout

The owner's supplied reference (`微信图片_20261018143921_31_50.png`) separates
the gray workspace from white chat panes and marks the active conversation's
whole frame. This request supersedes the previous white workspace, quiet focus
frame and visible ADHD message portraits.

Porcelain/Monochrome light mode now uses the reference's sampled colors:
`#f7f8fa` for the workspace and ADHD toolbar, `#fcfcfc` for conversation headers,
and the existing `#ffffff` chat canvas. Dark and system-dark modes use the theme
canvas/header/chat surfaces, without inserting white reading panes. The focused
frame follows the optional Monochrome accent (`--mono-mark`) or palette accent,
including returning to monochrome when the optional accent is disabled. It does
not hardcode purple. Its border width does not change on focus, so text, drafts
and controls do not shift. An attention top edge cannot replace one side of the
focused frame; unfocused attention and drag feedback remain independent.

Only message portraits inside ADHD panes are hidden. Their flex gap is removed
so the message body recovers the space, and group author names and timestamps
remain readable. Sidebar avatars, compact conversation-header icons, ordinary
desktop messages and phone messages retain their existing behavior. Expanded
ADHD panes use the same text-only presentation.
Per-author pending/replying dots move beside the author name and disappear when
the reply completes; reduced-motion preferences still disable their animation.
Author text follows the ADHD metadata reading size instead of inheriting the
ordinary chat's fixed author size. The column/size selects retain white fields
and fine borders on the light-gray toolbar. Dark headers use a subtle blend of
the theme surface and chat canvas. CLI/expressive focus-frame styling stays as
before; their ADHD message portraits follow the same text-only layout.

No Host, protocol, stored-state or polling behavior changes. CLI impact is not
applicable: these are client styles. No release, native restart or installed-App
replacement is part of this source change.

## Verification

Existing `adhd-board` regressions were updated to the requested surface and
portrait behavior, including actual default/custom portraits in ordinary chat,
group author names, text width without a leftover avatar gutter, and return to
ordinary desktop/iOS/Android layouts. Surface checks include light/dark/system
appearance, multiple accents, four-sided focus transfer without geometry shifts,
attention overlap, and preserving white chat content. Other focused regressions
exercise dense columns, reading sizes, headers, expansion, composer controls,
dragging, scroll positions and independent drafts.

Opus 5.5 participates as an independent read-only layout reviewer. Evidence,
screenshots and review reports are kept under
`/Volumes/gdrive/taro-tmp/adhd-surfaces-20261028/`. Browser and source verification
do not establish installed-Mac or physical-phone acceptance.

Final local results:

- Client build passed (translations, TypeScript and production bundle). The
  existing Capacitor Keyboard mixed static/dynamic-import warning remains.
- Chromium: 12 selected regressions passed. `final-chromium.log` records 11
  passes and one test-setup failure; `header-fix-chromium.log` records the
  corrected header case passing.
- WebKit: the same 12 regressions passed, with the corresponding evidence in
  `final-webkit.log` and `header-fix-webkit.log`.
- The header fixture now performs a real reader wheel gesture before publishing
  an unread reply: changing `scrollTop` alone does not enter history-reading
  state. The drag regression observes actual animation creation instead of
  trying to catch an already-finished animation after an asynchronous assertion.
  These are test corrections; no scrolling or dragging runtime was changed.
- Opus 5.5 found no product-layout blocker in the final light/dark, six-pane,
  expanded, accent, author-size and ordinary-phone screenshots. Its remaining
  verification blocker was the history-reading fixture above, now passed in
  both engines. The original review is preserved as `opus-final-review.md`.
- The six-pane overview and selected-accent preview were delivered in the
  current App conversation; delivery receipt is `gallery-receipt.json`.

CLI-not-applicable: the headless CLI has no ADHD presentation and no shared Host
capability changed. Installed-App and physical-device acceptance remain outside
this source-only change.

## Rounded frame correction — 2026-10-29

The owner noticed that the active pane's curved corners looked lighter and less
even than the straight edges. The outer card has a 14px radius in the neutral
themes, but its opaque `.conversation-pane` child had a 0px radius. Parent
overflow clipping alone allowed the child's background to wash out part of the
antialiased inner border curve. Isolated Chromium and WebKit captures using the
production App reproduce the difference with the warm-gray accent.

The frame now exposes its existing radius as `--adhd-card-radius`. Its direct
conversation child clips at that radius minus the existing 1px border: 13px in
the neutral themes and 9px in the other existing 10px frames. This retains the
outer geometry, line width, selected accent, white chat background and separate
header surface. No additional border, shadow or focus layer is introduced.

The comparison also tested background-clip alone; it barely changed the washed
out pixels. Matching the child curve restored the corner contrast in both
browser engines. Normal antialiasing of a curved 1px line remains; it should not
be confused with the content layer painting over it.

The existing surface/focus regression now includes warm gray and saves its
preview. Verification evidence is under
`/Volumes/gdrive/taro-tmp/adhd-corners-20261029/`. CLI-not-applicable: this only
changes the App's pane clipping. No Host state, release or installed App changes.

Final correction validation: translations, TypeScript and client production build
passed. The existing surface/focus and header-drag journeys passed in Chromium
and WebKit (2 each). The raster comparison changed all four curved corners while
changing zero sampled outer straight-edge pixels, and the normal-size warm-gray
preview was inspected. These are isolated browser results, not installed-App or
native display acceptance.
