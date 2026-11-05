# Phone composer: expand on actual wrapping

The phone composer reserved a full column for attachment, microphone and Send
controls until the draft contained a newline or more than 60 characters. A
42-character mixed Chinese/English draft already wrapped into three lines at
390px, leaving 132px unused beside the upper lines.

`useComposerSize` now measures whether the draft fits the compact input width
using the current text metrics and actual fixed action-control widths. Wrapped
text gets the full input width with the toolbar below it. Short drafts return
to the compact row. Expansion decisions always use the hypothetical compact
width, so the newly wider field cannot trigger a collapse/expand loop.
Measurements remain offscreen and never temporarily collapse the focused field.
Appearance and text/voice mode changes remeasure without taking focus or clearing
the draft. Desktop and ADHD retain their existing presentation; the expanded
class is phone-only. This is client presentation and adds no host/CLI capability,
queue change, protocol or database migration.

## Verification

- Reproduced before the change at 390px: the 42-character draft had a 236px input
  beside 132px of controls. After the change the input is 368px across the inside
  of the 370px composer, and controls occupy the lower row.
- Playwright CLI checked 32 text/width combinations at 320, 390, 430 and 760px:
  short text, Chinese soft wrapping, long English, narrow glyphs, explicit
  newline, long scrolling draft and deletion. Each settled geometry was sampled
  over eight frames; focus/value were retained and the layout did not alternate.
  Long text at a 390x430 viewport kept Send within the visible area.
  Textarea outer width is compared with composer content width because classic
  scrollbars reserve space inside a long textarea's clientWidth.
- Existing composer sizing, busy-state, IME and attachment suites: **19 Chromium
  and 19 WebKit cases passed**. Existing ADHD action alignment and live typing /
  wheel-boundary cases: **2 Chromium cases passed**.
- Client translation checks, TypeScript and Vite build passed; `git diff --check`
  passed. No source or browser assertions were weakened. The temporary visual
  fixture has an offline synthetic Bot; its expected steering-capability HTTP
  503 responses are separate from JavaScript page errors checked by regressions.

Screenshots use the real shared client and synthetic conversation data. These
are browser-layout checks, not physical Android keyboard or IME acceptance.
This source fix was made after the 1.0.89 packages; it requires a subsequent App
release to reach installed phones.
