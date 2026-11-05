# Remote screen toolbar presentation — 2026-11-03

## Owner report and correction

The docked viewer used the same diagonal-arrow glyph for two different actions:
expanding into the conversation area and entering full screen. Keep the existing
operations, but use four corners for full screen; expansion/restore retain the
diagonal outward/inward arrows. Each icon now has a localized hover title.

The compact remote-screen select rule reset padding to 8px on both sides and
used the `background` shorthand, competing with the shared theme's select
chevron and 30px text gutter. In the isolated CSS-order check, loading the panel
rules after the theme removed the custom chevron and reduced the right gutter
to 8px. The installed screenshot also showed a crowded native dropdown marker.
Use `background-color` and explicitly retain the 30px select gutter, including
the system/device permission selects that share the same compact rule.

This is presentation only. CLI is not applicable: no screen command, permission,
viewer session, input handler, selected Host or native service contract changes.

## Verification

- Existing `client/e2e/remote-screen.spec.ts`: **14/14 Chromium passed**.
  This covers expansion/restore, draft preservation, permission changes,
  visibility, release, text and input handling using isolated bridge/decoder fixtures.
- `npm --prefix client run build`: passed. Existing chunk-size and mixed
  static/dynamic import warnings remain.
- Actual React UI screenshots with shared monochrome theme, including panel CSS
  loaded after the theme, checked at 1360px and 980px viewport widths. The docked
  400px panel shows distinct icons and the full Fit label with a separate chevron.
  Dropdown readback: 30px right gutter; Fit text 40px in 48px available text area.
  Selecting 200% and returning to Fit continues to update the viewer layout.
- No new test-only product branches or host/native changes. Fullscreen interaction
  was attempted in the isolated headless visual probe but did not establish a
  fullscreen element; no new native fullscreen acceptance is claimed. The existing
  fullscreen handler is unchanged.
- No real remote capture or native input was performed. No owner permissions or
  installed App were changed. Not included in the frozen 1.0.127 release candidate.

Local evidence: `/Volumes/gdrive/taro-tmp.noindex/remote-screen-toolbar-20261103/`
(`regression.log`, `build.log`, `before-lazy-geometry.json`, `after-geometry.json`,
`after-toolbar.png`). The preview was delivered with an explicit test-UI label.
