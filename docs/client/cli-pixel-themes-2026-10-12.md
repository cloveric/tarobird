# Terminal and Pixel styles

Ships in Android **0.1.413-test.1** (version code **2026101228**).

Android **0.1.414-test.4** refines CLI bilingual fonts, text colors and table
size inheritance; see [typography and verification](cli-typography-2026-10-12.md).

## Selecting a style

On phones: **我的 → 设置 → 通用 → 配色风格 → 特色主题**. Choose **终端 CLI**
or **像素**, then select light, dark or system in the theme control above.
Desktop uses the same General settings. The selection is local to the device,
persists across reloads, and does not change the Bot or conversation settings.
Porcelain Teal (`white-teal`) remains the first-run default.

## Visual behavior

- **Terminal** uses a monospace UI, left-aligned conversation transcript, `>`
  prompt bands and a prompt input. Bot output hangs from a console gutter;
  titled cards use line-drawn frames. Bracketed timestamps and tags, dashed
  code panes, a file-tree sidebar and reverse-video selection complete the
  terminal layout. Dark mode is near-black; light mode uses pale paper tones.
- **Pixel** uses 3px stepped window corners, hard block shadows, bevelled keys,
  block-framed reply windows and name plates. Common controls use drawn 8×8
  pixel glyphs. Its Minecraft-inspired palette uses grass-green accents,
  earth-brown edges/shadows and pale stone reading surfaces; dark mode uses
  cave-dark surfaces with readable green and warm mineral accents. Chinese
  body text stays in the system font for reading.
- Settings tiles show both light and dark geometry. Custom avatars and media
  retain their artwork. Phone inbox rows have no new separators. Decorative
  prompt and heading marks stay out of the draft and message content.
- The styles keep existing message virtualization, attachment behavior and
  native appearance synchronization. Reduced motion and forced colors retain
  usable controls; forced colors restores native line icons and plain frames.

## 2026-10-14 palette update

The Pixel palette now takes its colour direction from Minecraft's grass,
dirt and stone. The shared tokens update desktop, phone and both settings
miniatures in light, dark and system modes. This is a recolouring of the
existing Pixel theme; Terminal CLI keeps its monochrome logo and quiet input.
Saved palette IDs, geometry, avatars, uploaded media and message content are
unchanged. Headless host CLI commands do not need changes for this client-only
presentation update.

The client build passes. Chromium and WebKit pass the rich-message contrast
and expressive-theme journeys (four cases), including a minimum 4.5:1 ratio
for measured text, draft retention, saved preferences, system switching and
390/320 px phone layouts. Desktop, phone and preview captures were inspected.
The first WebKit rich-message run checked code while the App was still on its
loading screen; the fixture now waits for the existing connected-workspace
signal after reload. That case then passed in both engines. This update is
source-only and has not been packaged or installed; release evidence below
describes the original 2026-10-12 theme release.

## Implementation and design source

`expressive-themes.css` is loaded last and scoped to the two palette IDs.
`ExpressivePreview.tsx` draws the settings miniatures; `MobileHome.tsx` supplies
icon names without changing actions. The existing appearance and preference
pipeline handles persistence and native system bars.

Claude Opus 5.5 was invoked with **xhigh** and directly rewrote the UI styles
and preview component after the user's feedback. It completed normally with no
permission denials. See the [sanitized model receipt](evidence/cli-pixel-2026-10-12/opus-provenance.json).
Subsequent rendered review corrected old bubble/attachment radii that clipped
the pixel steps, overlapping send-button frames, and the phone Terminal copy
button's touch target.

## Verification

- Chromium and WebKit each passed all 11 focused journeys: palette selection
  and contrast, retained drafts, 390px/320px phone layouts, keyboard behavior,
  safe areas and horizontally scrollable/expanded tables. After the final
  sticky-toolbar correction, the expressive-style journey passed again in
  both engines. No horizontal page overflow, and primary phone controls retain
  44px touch targets. Chromium also checks the forced-colors fallback.
- Inspected actual application captures from an isolated Hub:
  Terminal light (historical image omitted from this clean snapshot),
  Terminal dark (historical image omitted from this clean snapshot),
  Pixel light (historical image omitted from this clean snapshot),
  Pixel dark (historical image omitted from this clean snapshot),
  Terminal desktop (historical image omitted from this clean snapshot),
  Pixel desktop (historical image omitted from this clean snapshot),
  Pixel inbox (historical image omitted from this clean snapshot), and
  settings previews (historical image omitted from this clean snapshot).
- Standalone gate: 223 test files, 2,875 passed tests, one existing skip, with
  two Vitest workers. Clean client installation, translations, TypeScript and
  Vite build passed. Dependencies are unchanged; npm reports three moderate
  client dependency advisories.
- Independent installations of the production directory and extracted npm
  archive start an isolated Hub and serve client assets without the Feishu SDK.
- Android release build, 21 JVM tests and release lint passed (no lint errors;
  22 warnings). The signed APK retains the existing update certificate, and
  all 376 bundled public files match the synchronized client byte for byte.
  Both styles are present in the compiled CSS. Launcher verification passes
  all 15 PNG densities, both adaptive launchers and the manifest references.
  [Package receipt](evidence/cli-pixel-2026-10-12/apk-verification.json).

## Acceptance boundary

Browser rendering and package inspection do not establish physical Android or
installed macOS acceptance. This release publishes an Android APK; it does not
replace an installed Mac application. This client appearance change does not require
restarting paired hosts, relays, or legacy services.
