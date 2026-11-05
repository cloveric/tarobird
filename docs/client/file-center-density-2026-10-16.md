# Compact file-center filters

The phone file center used the general mobile field font floor and let sorting
wrap into a full-width row. Its header also allowed the close button to wrap below
the description when the host label was present.

- Search and the three filters now use 32px minimum control heights, smaller
  padding and 6px gaps. Filters share three equal columns with bounded widths.
- On engines without iOS touch-callout support, mobile utility text is 13px.
  The shared 16px focus-zoom protection remains in effect on iOS. Reading text and
  unrelated inputs are unaffected.
- Sorting sits next to the result count, with a quieter transparent border and
  background. Native select semantics, accessible labels and sort options remain.
- The header description can shrink, keeping the close control at the top right.

## CLI impact

This is shared-client presentation only. No host API, file storage, permissions,
schema or command-line operation changes. A future CLI package must include the
updated client assets to expose this layout in its browser interface; this source
checkpoint does not update the installed or published CLI.

## Verification

- Existing file-center browser journey passed before the change in Chromium.
- Translation validation, TypeScript and production client build pass.
- The existing journey passes after the change in Chromium and WebKit: desktop
  and phone shared labels, filtering, dirty/save guards, conflicts, light/dark
  rendering, English labels, original file preservation and no horizontal overflow.
- Inspected phone list screenshots in both engines and the desktop dark view.
  Controls are compact, the count and sort share a row, and the close button
  remains beside the title. No new tests were needed for this presentation change.

Artifacts: `/Volumes/gdrive/taro-tmp/tarobot-file-filters-20261016`.
These are browser checks, not installed Android/iOS/Mac acceptance. No App or CLI
release is included in this checkpoint.
