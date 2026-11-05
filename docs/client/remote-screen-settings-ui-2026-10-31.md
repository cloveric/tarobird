# Remote screen settings layout

The connection dialog previously repeated screen-service registration, separated
each macOS permission status from its setting button, and placed the disabled
viewer explanation below the permission controls. A fully permitted Mac could
therefore look ready even though the current GUI device had no viewing grant.

`RemoteScreenSettings.tsx` now groups the page into readiness and viewing,
system permissions, and paired-device access. The main switch remains beside
the heading. Host connection, screen service and this device's access each have
one value; unavailable reads show an unknown state. Local startup/retry phases
remain visible even when the Host read fails. Active viewing/control sessions
and their disconnect controls precede the permission settings.

The three macOS permissions use aligned name, purpose, status and Settings
columns. Their accessible button names retain the permission type; English names
also include the visible Settings label. Explicit permission requests remain
unchanged. Detailed permission guidance is expandable; after a user requests a
permission, the real request result and recovery steps remain next to the rows.
The shared remote viewer's toolbar and native input/capture behavior are unchanged.

When the current GUI device is ungranted, a manager can go directly to its
device-access selector. This only expands the list and moves focus. Saving still
requires an explicit selection with the same public key, policy revision and
selected-Host connection. The current device sorts first. Non-managers instead
receive instructions to request access on the target Mac. The native checkbox,
theme tokens and original busy/lifetime protections remain in use.

## Validation and boundaries

Opus 5.5 reviewed the layout and implementation independently. The browser fixture
uses controlled Host/native responses, the full App theme, and Chinese/English
layouts. Regression coverage includes explicit authorization, unchanged grants
when toggling the main switch, stale-state clearing, Host selection and switching,
permission denial/retry, local service recovery, active-session disconnection,
and narrow-window overflow. The independent review also checked the built
production CSS against the fixture and found matching heading alignment and
typography. It identified an ambiguous unlabelled device count, English Settings
buttons whose accessible names omitted their visible text, and a switch-specific
hint shown to non-managers. Those were corrected; the device section now uses
its visible title directly as its accessible name, with no misleading count.
Read failure now asks the user to refresh rather than claiming a read is ongoing.

Final reviewed validation is recorded in
`/Volumes/gdrive/taro-tmp.noindex/remote-screen-settings-ui-20261031/`:
`verified-final.log`, `build-reviewed.log`, and `opus-final-review.md`.
All 22 Chromium browser regressions passed, including Chinese/English narrow
layouts. The client build passed translation validation, TypeScript and Vite;
existing chunk-size and static/dynamic import warnings remain.
The earlier new-session test used an overly strict text locator; after correcting
the locator, its exact-session disconnect assertion passed. The production
session handling did not need a change for that test. With the full theme loaded,
the drag test now waits for the real entrance animation to finish before measuring
pointer displacement. Summary-name assertions allow the shared theme's existing
decorative expansion marker; neither change disables App animations.

This is a desktop presentation and navigation change. The headless CLI, Host
protocol and native permission implementation are unchanged. Tests do not capture
the owner's desktop, post remote input or change production permissions. No
release or installed App replacement is part of this change.
