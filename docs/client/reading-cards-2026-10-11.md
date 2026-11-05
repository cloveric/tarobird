# Compact reading cards · 2026-10-11

Bot run cards were rendered as broad, grey bubbles. More seriously,
`white-space: pre-line` on Markdown list items displayed the structural newline
nodes around paragraphs and nested lists. A loose ordered list placed its
number on an empty line, and paragraph spacing grew far beyond its CSS margin.

## Changes

- Keep authored paragraph/tool-input newlines and Markdown hard breaks. List
  containers use normal whitespace, so their structural newlines consume no
  line boxes. The parser, worker, message text and stored blocks are unchanged.
- Consolidate card prose rules: 1.6 line height, 8px paragraph spacing, 4px
  between paragraphs inside an item, and 8px between multi-paragraph items.
  Nested lists stay with their lead-in. First/last margins do not add empty ends.
- Structured replies use the palette's raised surface, a thin outline, 10px
  corners and at most 680px width. Status headers and the existing process
  disclosure stay inside the card. Error/warning header semantics remain.
- Process disclosure is compact on desktop and retains a 44px summary target
  on phones. Existing card layout properties, actions, questions, copy controls,
  attachment operations and unstructured text rendering are preserved.

## Verification

The new production-skin fixture reproduces the user's loose-list layout.
Before correction, the first paragraph started 26.8px below the list-item top
and the next paragraph had a 34.8px gap. After correction, those distances are
0px and 4px. Geometry checks run at 900, 390 and 320px widths. Light/dark technical
cards retain explicit breaks, task lists and links; long code scrolls locally
and long filenames/tables cannot expand the page.

Chromium: 16 focused card, Markdown, streaming and reading-position tests passed;
the five card-layout tests were rerun after adding the phone touch target.
WebKit: 14 of 16 passed in the initial run. One failure was trace-output deletion
from a concurrent runner; another failed during fixture setup because a delayed
anchor was missing. That run also had build-triggered page reloads. All three reading-position journeys then
passed in a separate output directory after asset preparation finished; no
assertions were weakened. Card callbacks exercise a real temporary Hub with
synthetic engine data. Streaming includes 50,122 characters and reload recovery.

A separately identified `com.tarobot.card-preview` Mac App was built and opened
against a disposable Hub over loopback. Actual native screenshots confirm the
card geometry and all five numbered sections; mouse expansion and keyboard
collapse of the process section were verified. No installed App or legacy Bot
service was replaced or restarted, and no model session was created.

Local screenshots and build/test logs: `/Volumes/gdrive/taro-tmp/card-evidence/`.
Root standalone build (278 modules, no Feishu SDK) and client build passed.
Release 0.1.382-test.1 uses Mac App 1.0.9 / Android code 2026101110. APK signing
and bundled frontend comparison, and mounted DMG signature/version checks are
part of release verification. Physical Android layout/gestures remain unverified;
responsive Chromium/WebKit checks are not device acceptance.
