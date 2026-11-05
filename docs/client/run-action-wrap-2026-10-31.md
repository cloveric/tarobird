# Run action row sizing

The foreground run action row allowed wrapping on desktop and iOS, but the
Android phone path kept all actions on one line. Larger counts and longer
translated labels could squeeze the process, recorded changes and Stop buttons.

All run action rows now allow wrapping. Buttons keep their content width up to
the row width; an individually oversized label can wrap inside its button.
Icons do not shrink, and Stop stays at the right edge when it wraps. Existing
labels, full numeric counts, accessible names, detail readers and stop behavior
are unchanged. CLI: not applicable; this is client CSS only.

## Verification

- Chromium and WebKit: 10 isolated real-component layout cases covering 320,
  360, 390 and 1360 px viewports, Chinese/English and counts 290/9999/999999.
  No clipped text, button overflow or horizontal page overflow; process readers
  open. Native platform attributes are simulated, not physical-device evidence.
- Existing run formatting/detail and recorded-change checks: 4/4 Chromium,
  4/4 WebKit. Client type/translation/build and standalone Host build pass.
- Evidence: `/Volumes/gdrive/taro-tmp.noindex/run-action-wrap-20261031/`.
  `after-geometry.json` records action-row widths (not viewport widths).

No release or installed App update is included.
