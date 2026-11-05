# Visible panel entry accent (2026-10-31)

Side chat and workbench header buttons now share an active treatment: tinted
background, inset hairline and a soft accent-coloured shadow. Their existing
`aria-expanded` state remains authoritative. Switching to the workbench removes
side-chat emphasis even if its temporary session remains open; closing both
removes both treatments. No layout or controller changes.

Use `--mono-mark` for the optional monochrome accent and fall back to `--accent`
for other palettes. This avoids rendering a neutral black shadow when the user
selected warm grey or sage. Mix the icon colour with foreground for readability
and strengthen only the fill on hover. Existing dimensions, corner style,
transitions and keyboard focus outlines remain unchanged.

Validation: client build passed; the existing temporary-side-session lifecycle
and workbench split/maximise/dock journeys passed (2 Chromium tests). During the
side test, temporary capture instrumentation opened side chat, switched to the
workbench, returned, and closed; style receipts confirmed only the currently
expanded entry had the accent shadow. Both closed entries had transparent
background and no shadow. Light warm-grey previews were visually inspected;
the existing side journey also passed its dark-theme stage. Capture
instrumentation was removed after validation; no test code is shipped.

These are isolated browser fixtures with a stub engine, not installed/native
acceptance. CLI impact: none; CSS presentation only. No release, installed App
replacement, Host restart, data or permission changes.
