# Extension manager layout — 2026-11-03

The extension entry previously mixed its enable checkbox, stacked scope label,
settings and maintenance buttons in one wrapping flex row. Long extension names
and scope options made alignment and priority unclear.

The entry now has a name/version/status header with an accent-coloured enable
control, a separate full-width access row, and one row of equally sized action
buttons. Settings and reload stay together; removal is separated at the other
edge. Permission and compatibility details remain available below the actions.
Long names wrap within the title column without displacing the enable control.
The scope selector reserves space for its disclosure arrow.

The settings action uses a short visible label; its accessible label and adjacent
scope explanation still distinguish personal-browser settings from the current
conversation. The existing current-browser access warning and network-rule
warning remain visible when applicable. Scope expansion still requires native
confirmation, and cancelling it retains the previous scope. No commands, native
extension policy, compatibility defaults or profile data were changed.

CLI impact: not applicable; this is device-local desktop UI presentation.

## Verification

- Existing `client/e2e/browser-extensions.spec.ts`: 9/9 Chromium tests passed,
  including denied/cancelled scope changes, compatibility targeting, settings,
  retries and removal. Subsequent changes were limited to CSS theme overrides.
- Final temporary visual/keyboard probe: passed against the final built client.
  Actual React cards at 480 px and 360 px dialog widths (438/318 px cards) had no
  horizontal overflow, aligned 32 px action controls and a 30 px select gutter.
  Long AdBlock names wrapped without shifting the switch. Light/dark warm-grey
  previews were inspected; the switch retained the accent fill, and its knob
  was not masked by the shared checkbox checkmark. Keyboard Space toggling and
  removal cancellation passed. The probe is retained in the task lab, not added
  as a permanent presentation-only test.
- Final `npm --prefix client run build` and `git diff --check`: passed. Existing
  bundle-size/dynamic-import warnings remain.

Visual checking caught shared `.workbench-dialog div` layout and monochrome
checkbox styling overriding the first candidate; explicit local layout and
switch rules now handle both. An initial screenshot probe resized the full
window while the popover was open and timed out; the completed probe directly
exercises two dialog widths, not App window-resize behavior. Browser fixtures exercise the actual React
manager with a native bridge substitute; they do not establish native extension
execution or website-specific ad blocking. The installed App is not updated by
this source change.
