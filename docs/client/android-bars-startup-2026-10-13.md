# Android black system bars on startup — 2026-10-13

## Confirmed cause

The white web page and black native system bars were reproduced with the prior
lifecycle fix present. This was not just an uninstalled update.

The production CSS optimizer changes `--bg:#ffffff` to `--bg:#fff`.
`syncThemeColor()` accepted only six-digit hex values, so it updated the web
theme-color meta tag but silently skipped the native appearance call for white.
The native window retained its previous dark canvas and light status icons.
Recorded state showed `bg="#fff"`, `page="rgb(255, 255, 255)"`, theme `light`,
palette `mono`, Android platform and a correctly registered appearance plugin.
The native background was still `#141414`.

The previous instrumentation called `setCanvas("#ffffff")` directly. That
verified the native plugin and lifecycle recovery while bypassing the failing
production theme-sync code. The new regression seeds persisted user appearance
preferences and the opposite native canvas, then launches a fresh Activity and
lets the packaged application's real startup synchronize them.

## Change

`client/src/appearance.ts` expands three-digit hex to six-digit hex before
native validation, luminance calculation and `TaroBotAppearance.setCanvas`.
Both long and shortened colors therefore reach the native bridge. The meta tag
continues to reflect the CSS token, and the native lifecycle fix remains intact.

## Evidence

- Before: the new regression failed with native color `#141414` despite the
  white web page. Reproduced black bars (historical image omitted from this clean snapshot).
- After: all three `AppearanceTest` instrumentation tests pass on an Android 16
  emulator in the isolated `com.tarocub.client.appearancetest` APK. They cover
  light/dark/light startup with stale native settings, Home/return, rotation,
  system-theme changes, native dialogs and keyboard dismissal. Checks include
  actual system-bar screenshot pixels, icon contrast and inset padding.
  White bars after startup (historical image omitted from this clean snapshot).
- 21 native unit tests pass. Release lint has zero errors and 22 existing
  warnings. Root/client production builds and four Chromium palette/safe-area
  workflows pass.
- The emulator proves the production JS/native bridge interaction. The user's
  physical phone and OEM have not been exercised by this run.

## Installable repair

Android `0.1.414-test.5`, version code `2026101301`, contains both system-bar
fixes and the current client UI. Package ID remains `com.tarocub.client`; the
existing test signing certificate is unchanged, allowing an in-place update.
This system-bar fix does not require a Hub or model-process restart.

Package checks verify v2/v3 signatures, 15 launcher PNG variants, both adaptive
launcher references, 378 production web assets and 380 native packaged assets.
The only expected web/index difference is the existing native CSP hardening.

APK SHA-256:
`c5bb7d5d9a0645af2cfa8a0d98dbb331976bb0147a4152df98739aefd90a8b2f`.

At diagnosis time, the GitHub download channel still offered test.1, while
test.2–test.4 had only been built locally. test.5 is a separate repair package;
installing test.1 or merely updating the Hub does not apply this fix.
