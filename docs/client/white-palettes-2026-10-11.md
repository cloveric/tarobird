# Pure white accent palettes

Add six Porcelain palettes: Blue, Green, Violet, Rose, Amber and Teal. In light
mode the sidebar, conversation and composer use pure white (`#ffffff`). Selected
rows, primary actions, links and user bubbles follow the chosen accent; neutral
text, Bot surfaces and semantic status colours remain consistent. Dark/system
mode has corresponding accent scales on a shared charcoal foundation.

`palettes.ts` declares the choices and family. `palette-tokens.css` keeps the six
hue scales separate from shared surface tokens, so there are no per-component
colour overrides. General settings group the new Pure white choices before the
four Classic colours, using the existing accessible radio previews. Both English
and Chinese names/descriptions are provided.

The four original palette IDs stay intact. As of 2026-10-17, the owner selected
Porcelain Violet (`white-violet`) as the first-run default, replacing Teal.
The welcome, pairing and loading screens use its white/violet tokens even before
preferences load; the
HTML theme-color starts white. Existing saved preferences are not reset; theme
and palette remain device-local. Choosing a hue does not change
light/dark/system mode. The inline settings explanation makes that distinction
explicit.

The 2026-10-17 change updates both `DEFAULT_PALETTE` and the CSS fallback for an
unset `data-palette`. Explicit saved colours retain precedence. This is shared
App presentation; headless CLI capabilities and host state are unchanged.

## Verification

- Existing full palette journey passes in Chromium and WebKit for all ten
  families: actual text/link/code/attachment contrast at least 4.5:1 in light and
  dark, preference migration, reload/cold-start persistence, system appearance
  switching, theme-colour metadata, keyboard selection and English labels.
- Each new light palette checks the rendered sidebar, chat and composer as pure
  white. All six were captured at 1360×900 and 390×844; phone composer stays in
  view with no document-level horizontal overflow. Preview controls and rich
  chat messages were visually inspected.
- A separate macOS Tauri preview uses a disposable Hub and seeded example
  messages. Native selection, rendered chat colour and reopening persistence
  are checked separately from browser evidence. No real model request is needed.
- Root standalone and client production builds pass. Android APK is signed with
  the existing test key, with its frontend assets compared to the final build.
  Mounted macOS DMG signature, identifier and version are checked.

## Release boundary

Pre-release **0.1.381-test.1** contains macOS App **1.0.8** and Android version
code **2026101109**. The installed user App, stored preferences and separate
legacy services are not modified. Android physical-device appearance, iOS and
Windows were not checked in this change. The macOS build remains ad-hoc signed,
not notarized.
