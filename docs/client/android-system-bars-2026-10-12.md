# Android system bars after returning to the app

**Follow-up:** the lifecycle fix below did not cover white colors shortened by
the production CSS optimizer. A real startup test reproduced white web content
with black native bars even with this fix installed. See the
[2026-10-13 startup correction](android-bars-startup-2026-10-13.md); test.5
contains both fixes. The older test.2 package is insufficient for this case.

The app's status and navigation areas now retain the selected canvas and icon
contrast when the activity regains focus or receives a configuration change.
This includes a light app on a phone using Android's dark theme. Insets still
reserve the status bar, display cutout, navigation area and keyboard.

## Cause and fix

Capacitor 8.5.2's built-in `SystemBars` plugin repaints the window decor using
Android's `windowBackground` in `handleOnConfigurationChanged`. Its
`insetsHandling: "disable"` option disables inset handling, not this repaint.
The app previously restored `NativeAppearance` on creation and resume only.
A later configuration callback could therefore overwrite both the canvas and
icon contrast, independently of the app's selected theme.

`MainActivity` now restores the saved appearance **after** the superclass has
dispatched configuration changes to plugins, and when the window gains focus.
The shared `NativeAppearance` implementation remains the owner of canvas and
contrast. No delays, polling, forced light theme or dependency patches are used.

## Verification

- The new native regression failed against the previous implementation on an
  Android 16 emulator: after returning to the app and rotating the display, the
  white canvas was overwritten with Android's dark `#303030` background.
  Before (historical image omitted from this clean snapshot).
- The same test passes after the fix. It exercises two Home/return and rotation
  cycles for each of white, dark and warm canvases (six cycles), a native dialog
  dismissal, changing the system theme while backgrounded, and keyboard
  opening/dismissal. Assertions cover actual screenshot pixels in both system
  bars, both icon contrast settings and preserved native padding.
- Both `AppearanceTest` instrumentation tests pass in the installed isolated
  `com.tarocub.client.appearancetest` APK. Native unit tests: 21 passed. Android
  release lint: no errors, 22 warnings. Root and client production builds pass.
- Light after return/configuration (historical image omitted from this clean snapshot),
  dark after return/configuration (historical image omitted from this clean snapshot),
  keyboard dismissed (historical image omitted from this clean snapshot).
- This verifies the Android emulator and packaged native bridge, not the user's
  physical phone/OEM build. Android `0.1.414-test.2` (code `2026101230`) contains
  this fix; the existing installed APK needs that update. A signed local repair
  package is built without republishing a GitHub Release.
- Final APK verification passes v2/v3 signatures, package identity, increased
  version code, both adaptive launcher references and all 15 PNG icon variants.
  The signing certificate SHA-256 remains
  `9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
  APK SHA-256:
  `ae3135fab68ba8be5b4fe357b41d59b5d64e3c3fd8562cf6970b4e9751815fcf`.

Build instrumentation with `:app:assembleDebug :app:assembleDebugAndroidTest`
and `-PtarobotApplicationId=com.tarocub.client.appearancetest`. Install both APKs
on the test emulator and run `AppearanceTest` using `am instrument -w -r`.
Screenshots are written under the isolated app's external `files/evidence`
directory. The test restores the emulator's original night mode afterwards.
