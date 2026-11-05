# Thin accent dividers for side chat and workbench

The side-chat resize indicator used a 2 px `--accent` stroke. In Monochrome,
that token is the black/white control colour, rather than the selected accent.
The workbench reused the outer handle and also applied a 2 px focus outline
around its separators, making the full hit area look like a thick bar.

The sidebar, side chat and workbench now share `--resize-divider-accent`:
Monochrome uses its selected `--mono-mark`, or `--border-strong` when no accent
is selected; other palettes use their existing `--accent`.

All hover, keyboard-focus and drag indicators are 1 CSS px. The workbench's
inner row/column handles use the same colour and line treatment; focus shows
the line instead of outlining the entire hit area. Normal resting borders
remain quiet. The existing 8 px outer and 7 px inner pointer targets are kept.
No resize handlers, layout bounds, persistence, protocol or Host operations
change. This is presentation only, so the headless CLI is not applicable.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/panel-divider-accent-20261031`.

- Client build (translations, TypeScript and Vite) and standalone Host build
  passed; the Host graph contains 478 modules and no retired transport SDKs.
- Six existing focused cases passed in both Chromium and WebKit: sidebar drag
  bounds/reset, keyboard/cancel/mobile transition, side-session navigation and
  wide resizing, side close/follow-up/draft preservation, local workbench
  interaction and split/dock/maximize behavior.
- The first Chromium run passed five cases; the side-navigation case missed a
  mouse drag (panel stayed 440 px instead of 960 px). Its isolated rerun passed
  without source or test changes. Keep this initial failure in the evidence;
  this run does not establish its intermittent cause.
- `preview.mts` reused an isolated Hub and fake side engine to inspect 180
  rendered states across both browsers: sidebar, side chat, workbench outer
  handle and inner row/column handles; hover, keyboard focus and pointer drag;
  light/dark warm grey, sage, no-accent Monochrome and CLI palettes. Every
  indicator measured 1 CSS px, matched the sidebar colour and had no painted
  focus outline. Outer/inner hit targets remained 8/7 px; the main draft
  remained intact. Measurements are in `geometry.json`.
- Screenshots: `chromium-side.png`, `chromium-workbench.png` and WebKit
  equivalents. Client-build chunk warnings remain unchanged.
- `git diff --check` passed. No new low-impact CSS-mirroring test was added.
These are isolated browser runs, not installed-App or physical-device acceptance.
No release or local App update is part of this change.
