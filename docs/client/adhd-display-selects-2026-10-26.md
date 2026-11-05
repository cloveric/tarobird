# ADHD display controls: arrow clearance and pointer focus

The compact “Per row” and “Text size” selects overrode the shared select's
right padding, leaving only 5 px for a chevron painted 10 px from the right edge.
Their background shorthand also removed the shared arrow in the CLI palette.
Native select focus could retain the text-field shadow after pointer interaction.

`client/src/adhd-board.css` now reserves space for the themed arrow, sizes the
controls from their content without flex shrink, and uses `background-color`
so the shared arrow survives. Only these controls suppress the focus shadow
when the existing input-intent tracker says mouse/touch. Keyboard focus remains
visible; native selects, options, accessible names and persistence are unchanged.

This is App presentation only. No Host API, schema, CLI command, conversation
data, normal-chat typography or saved preference format changes.

## Verification

- Reproduced the insufficient arrow padding and pointer focus shadow on the
  unmodified client before the CSS change.
- Chromium: 4 focused ADHD journeys passed. WebKit: the same 4 passed.
- New coverage measures text clearance across all font options and automatic,
  two- and six-column labels, in monochrome, orange and CLI palettes, light/dark,
  at 1360 and 900 px. Screenshots cover both widths in monochrome light/dark.
- Pointer focus is quiet, keyboard focus remains visible, and chosen values
  survive reload/reopening the board. Existing coverage also checks independent
  normal-chat typography, failed writes/retry, and legacy preference recovery.
- Client translation checks/typecheck/build and standalone Host build passed.

Browser results do not establish physical-device or native shell acceptance.
This change has not been packaged or installed as a new App release.
