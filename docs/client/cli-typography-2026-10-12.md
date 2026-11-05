# CLI reading size and bilingual typography

Current behavior: the [2026-10-28 revision](cli-dark-readable-2026-10-28.md)
makes CLI dark-only and uses wider JetBrains Mono Latin text with Sarasa Chinese.
The earlier light mode and 1:2 mixed-script width measurements below are historical.

The Terminal theme keeps its transcript, prompt and ruled layout. Its reading
text now uses one scale: paragraphs, tables (including expanded tables),
headings and code follow the chosen font size. Heading emphasis comes from
weight and the existing Markdown marks, not a larger font. Other themes retain
their own typography; shared Markdown tables now inherit the surrounding size.

## Cause and changes

The shared table reader had a fixed `14px` size. At a 12 px reading preference,
tables were larger than the surrounding card text. The new regression fails
against that implementation and passes with inherited table sizes. CLI also
unifies plain messages and card text so they do not differ by one pixel.

The theme bundles Sarasa Term SC 1.0.42 Regular and SemiBold. Its Latin and CJK
glyphs use a 1:2 cell ratio, including the same font in code and tables. Font
files, the complete upstream character mapping and OFL license are local to
the app; no remote font service is required. Sources, conversion instructions,
checksums and the approximately 16.7 MiB asset cost are recorded in the
[font README](../../client/src/assets/fonts/sarasa-term-sc/README.md).

The color hierarchy is informed by the
[Codex CLI style guide](https://github.com/openai/codex/blob/main/codex-rs/tui/styles.md):
neutral primary text, readable secondary gray and selective semantic color.
This app uses cyan for transcript prompts, links and inline commands, violet for
Bot labels and code keywords, green for strings, and warm muted numeric
highlighting. Light and dark values are checked against the painted surfaces,
including the user-message background. Settings miniatures use the same accents.
This is our font/color implementation, not a claim that Codex uses this font.

### 2026-10-14: quieter composer

The CLI theme's input uses a single neutral gray border in light, dark and
system modes. Hover and focus use the readable secondary gray; focus no longer
adds a second cyan ring. Its decorative `>` is secondary gray and the insertion
caret follows the text color. Keyboard focus on toolbar buttons retains its
existing indicator. Desktop and mobile share these styles. This is presentation
only: the headless host CLI, engine adapters, message content and network
behavior are unchanged.

Validation: client build and the existing CLI/Pixel palette journey pass in
Chromium and WebKit, including draft retention, phone controls and theme
switching. An isolated Hub render check covers focused composers at 1360 px and
390 px in light, dark and system-dark modes in both engines: 1 px gray border,
no outer shadow, neutral prompt and text-colored caret. Focused desktop/phone
captures were inspected. This source change has not been packaged or installed
on the user's devices.

### 2026-10-14: flat product mark

The CLI wordmark reuses `assets/brand/tray-macos.svg`, the existing flat mascot
silhouette with transparent eye cutouts. It has no lavender tile, shading or
shadow. The CSS mask is black in light mode and white in dark mode, including
live system-theme changes; forced-colors mode uses `CanvasText`. The 32 px logo
slot and product name remain aligned without a layout shift. Other palettes
keep the original icon, and Bot/conversation avatars are independent. The
shared brand component also keeps CLI pairing/loading screens consistent.
This is a client-theme change, so no headless host CLI command or behavior
change is applicable.

Validation: the client build and existing CLI/Pixel palette journey pass in
Chromium and WebKit. Isolated Hub checks verify pure black/white masks in
explicit light/dark modes and both live system schemes, fixed 32 px dimensions,
and restoration of the coloured mark in Porcelain Teal/Pixel. Light/dark and
forced-colors screenshots were inspected. No installer was published.

## Verification

- Browser regressions measure paragraph/table/header/code sizes at 12, 14 and
  20 px, rendered text contrast of at least 4.5:1, loaded font faces and CJK/Latin
  widths. Plain and card messages, phone/desktop, both theme modes and expanded
  tables are covered. Changing to monochrome removes the CLI font.
- Chromium and WebKit both pass the focused typography, table interaction and
  palette regressions. Existing font-preference persistence and real touch
  scrolling regressions remain green; the Chromium touch-driver case is
  intentionally skipped in WebKit.
- Android `PairingJourneyTest` accepts `-e fontSettings true -e cliTypography true`
  with a peer started using `android-pairing-peer.mjs OUTPUT --typography`.
  It runs on the isolated `com.tarocub.client.typography.pairingtest` package,
  checks actual WebView font decoding, 1:2 glyph widths and equal 12 px body,
  table and code text in light/dark modes. Captures wait for the WebView
  compositor and assert that the table is in view: light (historical image omitted from this clean snapshot),
  dark (historical image omitted from this clean snapshot). No user hosts or conversations are used.
- Root/client builds and Android release assembly pass. The signed local
  `0.1.414-test.4` APK (code `2026101232`) contains both fonts, the OFL license
  and synchronized web assets, with the existing package ID and signing
  certificate. Launcher icon verification passes. No GitHub Release was published.

APK SHA-256:
`712175960d768c95a2d0609ac36dcbc69e8ba6c0d389f53475277efc5c430973`.

Browser/emulator verification does not replace acceptance on the user's phone.
