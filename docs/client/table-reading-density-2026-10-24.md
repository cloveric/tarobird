# Desktop message table reading — 2026-10-24

A comparison with a short position label and two prose columns could overflow
the conversation even though the contents could reasonably fit. Tables inherited
the full prose font size, used generous cell padding, and bounded long columns
with a fixed root-relative width. Reducing the font alone did not address that
intrinsic column width.

## Change

- Desktop message tables and the expanded reader use a slightly smaller font
  relative to the chosen reading size and tighter cell padding. The scale stops
  at a readable floor without enlarging an already smaller local reading size.
- Long prose columns use the local table container's width, with readable lower
  and upper bounds. Short labels, dates, amounts, alignment and full text stay
  intact. Truly wide tables still scroll locally and can be expanded.
- Terminal-family themes use the same table scale, without also scaling code,
  headings or surrounding text. Passive quote previews are unchanged.
- Native iOS and Android are excluded, including landscape widths above the
  desktop breakpoint. Narrow browser viewports retain their existing typography.
  Normal message text, input text and saved preferences are unchanged.

This is client presentation only. The headless CLI, Host APIs, permissions,
message data and schema are unaffected; no CLI command change is applicable.

## Verification

The production client is served by isolated fixture Hubs. A three-column prose
comparison fits a 650px chat table viewport without horizontal overflow, with
the surrounding text still at 14px and table text at 12.88px. Long prose rows
remain readable rather than compressing into a few characters per line.

Regression coverage includes the comparison in the default and terminal-family
themes, narrow panes, expanded-reader font size, native phone platform selectors
in landscape, mobile browser sizing, large and small saved reading preferences,
six-column local scrolling, amount alignment, sticky headers, live updates,
draft/focus preservation and passive quotes. Browser checks of platform selectors
do not establish physical-device acceptance.

- Chromium: 31 distinct cases passed across table, CLI typography, terminal
  theme, card layout, Markdown, message action and reading-anchor regressions.
- WebKit: 6 distinct table and CLI typography cases passed.
- Client translation check, TypeScript check and production build passed.

The first runs exposed outdated test expectations: a five-column fixture now
fits without scrolling, and a float string needed decimal normalization. The
wide-table fixture now has six columns with the prose target at the far right;
all four final table journeys passed in each engine after updating the fixture.

Evidence directory: `/Volumes/gdrive/taro-tmp/table-reading-density-20261024`.
Source validation does not replace an installed App; this change does not build,
publish or activate a new release.
