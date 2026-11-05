# Font slider and settings spacing — 2026-10-13

The 12–20 px slider is back on phone and desktop, with the current size and live
reading preview. A touch must move at least 8 CSS pixels with clear horizontal
intent before it updates the value; vertical movement keeps scrolling the page.
Touch-down and cancellation before horizontal intent do not change preferences.
Mouse track clicks/drags and the native range's keyboard/assistive adjustment
remain available. The selected size uses the existing device-local preference
storage and stays independent of theme selection.

Phone settings groups now have 16 px horizontal and 4 px outer vertical padding;
row padding adds breathing room above/below controls. Labels, dropdowns, the
slider, preview and model-icon switch share the inset. Desktop's unboxed settings
rows retain their existing alignment.

## Verification

- Chromium: 7 workflows pass, covering real vertical touch scrolling across all
  13 palettes, horizontal drags in both directions, cancellation, mouse controls,
  keyboard changes, 12/16/20/14 px persistence through light/dark/system modes,
  chat navigation and reload, CLI table/body parity, and language/draft retention.
- WebKit: 4 workflows pass; the Chromium-only touch-driver case is skipped.
  Both browser suites include narrow 320 px layouts. Card gutter geometry is
  checked for every palette; phone and desktop screenshots were inspected.
- Android API 36 emulator: the isolated `com.tarocub.client.fontslider.pairingtest`
  APK passes the full pairing journey with `fontSettings=true` and
  `cliTypography=true`. Native vertical touch leaves 14 unchanged; horizontal
  dragging selects 18; theme switch, chat and WebView reload retain 18. The CLI
  verification then confirms 12 px table/body/code parity in both light/dark.
  The test uses a disposable TLS Hub and never opens the user's hosts or data.
- One first native run timed out at the workspace loading screen after reload.
  Diagnostic resource information was added to failure output; a fresh isolated
  run of the same application passed, including reload and Hub reconnect. This
  transient load timeout was not reproduced or attributed to a confirmed cause.
- Root/client production builds and Android release assembly pass. The phone
  screenshot shows native white system bars; the earlier shortened-color startup
  fix is retained.

This is browser and installed emulator evidence, not physical-phone acceptance.
The installable repair is Android `0.1.414-test.6`, code `2026101302`, using the
existing `com.tarocub.client` package ID and test signing key for in-place updates.
It also includes the system-bar startup fix from test.5. No Hub restart is needed.

Installed Android appearance (historical image omitted from this clean snapshot).
Release lint: zero errors, 22 existing warnings. Verified 378 web assets and
380 native package assets; the existing native index CSP hardening is the only
expected web/index difference. Package signature and launcher icons pass.

APK SHA-256: `f463833d2a1a180eee1f71dc7414d8660300acb4acf07c81ad6bf58c7a248217`.
