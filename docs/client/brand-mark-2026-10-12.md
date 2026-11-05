# TaroBot in-app brand mark

The sidebar previously used a generic Layers glyph that did not identify
TaroBot. The shared `BrandMark` now uses the GPT Image taro mascot from
[the icon exploration](../design/app-icon-concepts-2026-10-12/README.md).

The same image appears in the desktop sidebar, pairing, welcome and loading
screens. It is 32 CSS pixels with balanced text alignment and a fixed corner
radius. The previous accent tile, gradient and extra shadow are removed.
The image is imported locally and emitted with the app's offline assets; it
does not fetch remote artwork or replace individual Bot avatars.

The existing palette contrast check now measures the product-name text;
computed text colors on an image do not measure that image's contrast.

## Validation

- Root standalone build and client production build passed.
- Existing pairing-design and palettes coverage: 3 Chromium and 3 WebKit
  tests passed, including both languages, 320/390-pixel phone layouts,
  palette persistence, dark/light themes and readable text contrast.
- Built and opened a separate Tauri app with an isolated bundle identifier.
  Visually checked its welcome page and paired sidebar against a temporary
  fixture Hub. The production app and running Bot services were not changed.
- Native sidebar (historical image omitted from this clean snapshot)
  and native welcome (historical image omitted from this clean snapshot).

This changes the in-app wordmark. Native launcher, Dock and tray icons are
outside this change. No installer was published or installed, and no Android
physical-device acceptance was performed.

## Sidebar sizing, 2026-10-16

The desktop sidebar mark is now 16 CSS pixels with a 6-pixel gap to the name,
following the owner's request for a much smaller top-left logo. The scoped
rule applies to the coloured image and the CLI theme's flat silhouette.
This is presentation only: there is no host API, state or headless CLI change.

Validation: the client production build and the existing Chromium CLI/pixel
palette journey pass, covering light/dark desktop and 320/390px phone layouts.
The rendered CLI dark sidebar was visually checked. This sizing change is
committed source; the already-installed Mac App has not been replaced.
