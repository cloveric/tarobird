# Theme-specific chart series

The black-and-white palette exposed a collision in fixed reports: the first,
second and fourth series were derived from `accent`, `text` and their mixture,
but that palette deliberately gives `accent` and `text` the same colour.

## Behaviour

`client/src/chart-palette.css` supplies four dedicated data-colour slots for each
of the 16 App palettes, separately for light and dark mode. System mode resolves
through the existing colour-scheme media query. Black-and-white uses three
neutral shades and a restrained blue-grey companion. Other palettes use their
own coordinated colours; the App's default theme and existing surface tokens
are unchanged.

The later [Monochrome accent integration](mono-chart-accent-2026-10-26.md)
supersedes the fixed blue-grey companion: no accent uses four neutral shades,
and a coloured accent highlights the main series beside three neutral references; Graphite remains grayscale.
It also connects live HTML-widget accent updates and data-scoped emphasis.

`Report.tsx` assigns slots by the original `chart.values` order. Hiding a series,
filtering records or opening the reader does not reassign remaining colours.
The legend and inspector show the same line samples as the plot. Four distinct
line styles supplement colour. Continuous SVG paths preserve dash cadence in
dense charts; missing values still start new spans rather than connecting gaps.
Bars retain full colour; a separate dashed category frame marks the selected
record instead of reducing the opacity of all other records. The frame remains
visible when a bar has the same colour as the surrounding text. Legend hover
changes the border rather than changing the surface beneath the data swatch.

The CSS tokens `--chart-series-1` through `--chart-series-4` are also supplied to
HTML widgets through `widgetTheme`. Live theme updates reuse the same guest
runtime and its local state. On-demand widget guidance tells authors to use these
tokens, stable series identities, matching legend samples and distinct non-colour
cues. Older clients require light/dark-aware fallback colours.

## Compatibility and scope

- No report schema, persisted data, publication switch, sandbox permission or
  frozen native tool definition changes.
- Historical fixed reports use the new renderer after a client update. Old
  clients continue rendering their existing report format.
- Historical HTML that hardcodes its colours is not rewritten. New tokens help
  token-aware HTML; author-defined semantic colours remain the author's choice.
- The headless CLI shares the on-demand authoring guidance. There is no new
  CLI command or host state: presentation remains in the client renderer.
- Existing iPhone, Android and desktop typography and density remain unchanged.
  This change does not establish physical-device acceptance.

## Verification

Evidence is kept outside the repository in the `chart-theme-20261026` verification
directory. The independent reviewer is CC1 with `claude-opus-5-5[1m]`, xhigh;
root owns the implementation.

- Root and client builds; targeted `widgets` / `reports` unit tests.
- Chromium and WebKit report/widget interaction suites.
- Real rendered colours for all 16 palettes × light/dark at 390 and 1360 widths:
  four distinct slots, plot/legend/inspector contrast against their surfaces,
  consistent line samples, full-colour bars, stable selection through hiding,
  filtering, theme changes and expansion. Also checks system mode and 320 width.
- Colour separation uses the published
  [OKLab transform](https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab)
  and [Machado colour-vision simulation](https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html).
  Regression guardrails are adjacent-series OKLab distance ×100 ≥15, other
  pairs ≥6; adjacent protan/deutan simulated distance ≥8. These are product
  regression thresholds, not universal accessibility certification. Four line
  styles, named legends, record inspection and the data table remain necessary.
- Long Chinese series names at 320/390 in both modes: actual text ranges occupy
  at most three lines in the inspector, with no horizontal overflow.
- Custom HTML receives all four tokens on live theme changes and preserves its
  counter state through theme changes and expansion.
- Contrast checks wait for existing button surface transitions to settle.
  Browser-computed colours are used rather than assuming six-digit hex output;
  production CSS may legally compress a colour to three digits.

The independent review led to wider lightness separation, green/walnut colours
for Pixel, ink/orange as Paper's first two slots, extra light-mode contrast
margin, the category selection frame and stronger regression checks. An initial
candidate measured 2.998:1 on one green-theme surface; the final colours were
corrected rather than rounding the test threshold down.

Verified: 12 targeted unit tests; 72 distinct Chromium/WebKit interaction cases
passed, with two opt-in live-model runs skipped. Root/client builds passed. The
final matrix and HTML-token test were rerun after the last colour/test corrections.
One existing Capacitor keyboard static/dynamic-import build warning remains.

Known boundaries: no physical iPhone/Android/Mac-shell verification this round;
no forced-colours/print acceptance. Very dense grouped bars still use the existing
geometry (e.g. 53 categories × four series on a phone produces very narrow bars);
this change does not redesign sampling or chart navigation. Author-hardcoded HTML
colours retain the compatibility behaviour described above.

The independent Chromium run covered 128 palette/mode/width/chart combinations,
128 legend hover samples, 24 line-style samples and 32 system-mode comparisons.
It reported no page errors or legend/inspector identity mismatches. Measured
minimum contrast was 3.393 for marks, 3.164 for legend/inspector samples and 13.06
for the separate category frame. Simulated touch selection, series hiding,
expansion/return, filtering and theme changes preserved state. One initial
review probe selected a legend checkbox SVG as the plot; its contrast readings
were discarded and the corrected direct-child SVG probe was rerun.

No release, production migration or local App installation is part of this change.
