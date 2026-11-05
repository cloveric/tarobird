# Monochrome data accents

The optional Monochrome accent previously affected reply marks and controls but
not data-series colours. An already-open HTML widget also did not observe an
accent-only preference change. This update connects both presentation paths.

## Appearance and scope

- With no accent, four neutral shades replace the previous fixed blue-grey
  companion. The unset root fallback now matches the default Monochrome palette.
- Five coloured accents highlight the main series; three reference series
  stay grayscale. Graphite and no accent share the same neutral data palette.
  Light and dark modes have separate colours; system mode follows the OS. Other palettes retain their existing series colours.
- Original series order still assigns the slots. Hiding a series, filtering,
  selecting a record and expanding the report never reassigns colours. Existing
  distinct line styles and matching legend/inspector samples remain.
- Only the leading report metric receives emphasis. Other values, labels,
  surfaces, grids and the table remain neutral. Selected overview/table controls
  and timeline nodes use the data emphasis. The bar-chart record frame stays
  neutral so a selection is not confused with one of the series.
- The leading series, headline ink and data-widget primary action share one
  tone in either mode, with enough contrast for small text. Widgets use that
  data tone instead of the surrounding App's slightly different solid-control
  tint. App controls themselves are not modified.

`chart-palette.css` owns concrete series colours and the data-scoped semantic
roles. `report.css` consumes those roles locally. `widgetTheme` maps them to
the guest's existing accent/primary/soft tokens, leaving the surrounding App's
global accent, message bubbles and status colours unchanged. `Widget.tsx`
observes `data-mono-accent` and sends an ordinary theme update without creating
a new Worker or resetting the guest's counter, filters or other local state.

No report schema, preference ID, migration, sandbox permission or frozen native
tool definition changes. Unknown/missing accents use the neutral fallback.
Historical structured reports adopt the renderer after a client update.
Token-aware historical HTML also follows the new theme. Hardcoded historical
HTML and explicit author-defined semantic colours are not rewritten.

The leading metric should correspond to the first chart series when applicable;
the on-demand guidance states that ordering convention without a schema change.
Soft backgrounds use concrete hex colours. Widget forwarding expands minified
three-digit hex tokens for scripts that expect six digits, without converting
font/length tokens.

The on-demand authoring guide uses the actual `tarobot:theme` event when scripts
cache colours; SVG/CSS variables can update directly. Canvas remains unsupported.
The headless CLI shares that guidance and publishes the same report/widget
format; it needs no new command, state or server endpoint. This is presentation
and authoring guidance, not a model/engine behaviour change.

## Verification

Evidence directory: `mono-chart-accent-20261026` outside the repository.

- A baseline browser test reproduced the missing neutral/accent behaviour.
- Rendered chart tests cover all existing palettes plus all seven Monochrome
  choices at phone and desktop widths, light/dark/system modes, line and bar
  charts, timeline nodes, selected records, hidden series and expansion.
- Marks and visible legend/inspector samples must maintain contrast of at least
  3:1. Leading metric and selected control text must meet 4.5:1. The existing
  OKLab separation guardrails (adjacent slots at least 15, other pairs at least
  6) and simulated protan/deutan adjacent separation of 8 remain unchanged.
  These are product guardrails, not universal accessibility certification.
- A real sandboxed-widget test changes only the accent attribute, verifies all
  four series and semantic tokens, checks 4.5:1 button/card-label contrast,
  preserves the guest counter and author-defined warning colour, and checks
  phone containment, expansion and switching back to another palette. A separate
  production-minified fixture verifies token forwarding for all accent choices.
  The existing general interaction suites cover local filters, touch selection, negative/missing values and sandboxing.

Final validation on the reviewed product diff:

- Chromium: **40/40** report/widget cases passed (`final-chromium.log`).
- WebKit: **40/40** cases passed (`final-webkit.log`).
- Host report/widget unit tests: **12/12** passed (`unit-final-v2.log`).
- Host and client builds, including client type and translation checks, passed.
- Two additional phone/desktop palette checks passed after shortening dates in
  the small synthetic preview dataset (`previews.log`); product code was unchanged.
- Opus 5.5 xhigh independently reviewed the source and measured the rendered
  colour matrix in Chromium and WebKit, with no blocking findings. Review feedback improved the visible accent, kept the bar
  selection frame neutral, unified the leading-series identity and replaced
  computed soft-colour expressions with compatible hex tokens. The original
  separation thresholds were retained.

The earlier `final-focus.log` widget failure ran against stale client output
(14 distinct old series sets versus the intended 12). After rebuilding the
client, `final-updated.log` passed 5/5 and the complete final suites above passed.
No product rule or colour threshold was relaxed to make that test pass.

Future palette additions should also verify production CSS token serialization;
named colours are not normalized to hex by this change.

Browser screenshots do not establish native iPhone/Android/Mac-shell acceptance.
No installation, release, production restart or data operation is part of this
change. Very dense grouped bars keep their existing layout; this is not a chart
sampling/navigation redesign.
