# Phone folder button labels — 2026-10-13

The new-folder sheet showed an apparently empty grey/black save button. The
button still had its text and accessible name, so the existing click-based
folder journeys did not detect the visual defect.

`mobile-im.css` applied `color: inherit` to every button and input below the
phone home. Its descendant selector outweighed the shared `.primary` foreground,
including buttons in nested native dialogs. In the monochrome light theme,
foreground/background contrast fell to **1.05:1**; fading the empty-form button
did not restore the missing contrast. A hover-only visual check could miss this
because the primary hover rule has higher specificity.

The phone reset now inherits typography only. Existing base/component color
rules control buttons and inputs, including the theme's inverse primary text.
This covers new-folder, rename and create-and-move actions through the shared
style without adding per-dialog overrides. Empty names remain disabled; normal
folder submission, duplicate-name validation and cross-device sync are unchanged.

## Verification

The added real-Hub browser regression fails against the previous production
build at 1.05:1. It checks visible save labels before/after typing, away from
hover, across all 13 palettes, light/dark modes and phone/desktop widths. It also
submits the form and verifies the persisted folder. Disabled buttons retain their
existing whole-control opacity; the test checks their underlying foreground/fill
contrast, not a WCAG contrast claim for the opacity-composited disabled state.

The full folder workflows additionally exercise create, rename, duplicate-name
errors, move, delete, cross-device updates, drafts, offline operation and host
navigation. Production screenshots independently show the empty-form label
visible after the fix.

- Chromium and WebKit each passed 20 cases: eight folder journeys plus twelve
  phone navigation/palette journeys. Screenshots were checked before and after.
- Standalone build/full suite passed: 230 files, 2,935 tests, one existing skip.
  Client translation, TypeScript and production build passed.
- Android release build, 27 JVM tests and lint passed (zero errors, 22 existing
  warnings). Alignment, v2/v3 signatures, application identity/version and all
  launcher icons passed. All 378 web files match the mobile copy (with its
  intended CSP change), and all 380 native public assets match the final APK.
- APK SHA-256: `c641b6e080c2682f3cb73944a2ab1976b4d2ec9d392ed483ea1a7ad1b3c1f047`.

Android client 1.0.59 / versionCode 2026101314 is the mobile repair package;
application ID and signing certificate remain unchanged. This is a phone-home
CSS repair. The installed Mac 1.0.58 remains in place; this checkpoint does not
replace it or restart the user's host. Physical-phone acceptance is separate
from browser and APK packaging checks.
