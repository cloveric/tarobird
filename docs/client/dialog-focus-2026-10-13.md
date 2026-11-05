# Dialog opening focus

The persona editor could open with a ring around its close button because the
native dialog's default focus landed on that first control. Clicking elsewhere
moved focus and removed the ring.

`CreationDialog` now provides a programmatically focusable heading as the
default starting point. Explicit `initialFocus` targets still take priority,
including rename fields and cancellation buttons in destructive confirmations.
The heading is outside the Tab order. Close buttons retain the normal visible
keyboard focus style; their unfocused state has no outline. Escape, nested
dialogs and return-to-trigger focus keep their existing behavior.

Verification uses an isolated Hub and synthetic Bot instructions. The persona
flow checks touch and mouse opening, keyboard navigation to the close button,
Escape, keyboard reopening, closing with Enter and return focus. It also checks
saving, conflicting drafts and owner access. Related creation, rename, details
and settings lifecycle coverage checks the other shared-dialog callers.

The persona regression passed in Chromium and WebKit. Related Chromium
creation/rename/phone-layout checks and WebKit creation/details/settings checks
passed, as did the root and client builds. In macOS WebKit, Option+Tab follows
the browser's default all-controls keyboard cycle. Assertions inspect outline
style as well as focus; a computed outline width alone can be nonzero even
when the outline style is `none`.

The Mac update is 1.0.50. The Apple Silicon DMG passed image verification,
strict ad-hoc signature checks on its read-only mounted App, version/icon
checks, and equality of its executable and all 378 bundled client files.
The Downloads copy matches SHA-256
`ec0e9075d4d525dc2b2c28bee8c3469ef62648327db8e6bc5c422b23a3388d13`.
The installed App was not replaced. Browser-engine checks and installer integrity do not
constitute physical Android/iPhone acceptance. No phone installer is delivered
for this desktop report.

## Confirmation controls (2026-10-22)

Safe cancellation remains initially focused. Secondary confirmation actions now
use the neutral surface fill; keyboard focus uses a neutral inset 2 px outline
instead of the detached accent frame. Pointer focus follows the existing input
intent rule. Danger/primary semantics and 44 px touch targets are unchanged.
This is presentation only and does not change the shared Host or CLI behavior.

The built client was inspected in light/dark Chromium and WebKit with mouse and
keyboard navigation. Both confirmed cancel focus, a pointer outline of `none`,
a visible keyboard outline, and cancellation without archiving. Conversation
context and phone action regressions passed in both browsers. The WebKit phone
fixture now waits for the reloaded client to be online before its next hold;
previously a cached pinned row could appear before reconnect/render settled.
These are browser-engine checks; native installed UI is part of the next release.

## Nested settings return (2026-10-23)

Closing LAN/Tailscale settings could restore focus to the outer connection
dialog itself. WebKit reproduced the owner's blue frame at both 390 px and
1360 px widths: the dialog's computed outline style became `auto` after the
child closed. The existing rule suppressed this only for `.creation-dialog`.
All native `dialog` containers now suppress their own focus outline; their
buttons retain keyboard focus indicators and return-to-trigger behavior.

The local-relay fixture now installs the production pointer/keyboard intent
handler. Its existing nested-settings flow checks real child-close return,
explicit dialog focus and visible keyboard focus on the close button at both
widths. This is presentation only: CLI behavior and Host APIs are unaffected.

Both nested-dialog widths and the existing settings pointer/keyboard workflow
passed in Chromium and WebKit. Screenshots confirm the outer frame is absent.
Root and client builds passed. These checks use browser engines, not installed
native apps; no release or local App replacement is part of this fix.
