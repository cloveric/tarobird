# Preserve chat width when resizing the right window edge

The owner clarified that the affected edge is the App's outer right window
border, not the divider between chat and the side panel.

## Reproduction and repair

After native side-panel expansion, the panel kept a fixed CSS width while chat
used the remaining flex width. Resizing a 1400 px window to 1580 px therefore
added 180 px to chat. Shrinking it took width from chat; the opening hook could
also switch back to split mode when the viewport fell below its initial
base + panel width, even though a narrower usable side panel would fit.

The hook now tracks the acknowledged expanded viewport. Subsequent width deltas
are assigned to the right panel, preserving the current chat allocation. Height
changes do not alter widths. Internal divider changes retain their existing
behavior; subsequent outer-edge changes preserve that deliberately chosen
allocation. The side panel's new width remains the window-local width preference.
The shared hook covers side chat, the conversation workbench and the independent
ADHD browser dock.

The window lease also owns a temporary native minimum content width: protected
chat + sidebar + 320 CSS px for the right panel. It is serialized with window
opening/closing and owner changes. A stale owner cannot update or clear it.
The minimum is removed before shrinking to the original window width, and is
also restored when the App document retires. Partial/failed native writes retain
the existing guarded recovery behavior.

The Electron command is trusted-controller-only, schema validated, converts
physical content width to native outer-window width and bounds it to the monitor.
It uses the documented [Electron minimum-size APIs](https://www.electronjs.org/docs/latest/api/base-window#winsetminimumsizewidth-height), preserving the previous minimum height.
Fullscreen/maximized or insufficient-room openings retain the existing split
fallback; this change does not force the OS out of those modes. Browser/mobile
layout and the retired Tauri compatibility path do not gain an OS minimum-width
command. CLI is not applicable: only local window presentation changes.

## Validation

Evidence: `/Volumes/gdrive/taro-tmp.noindex/right-panel-window-resize-20261031`.

- Baseline regression reproduced (`red.log`).
- Window lease/planning tests: 36/36 (`unit.log`), including stale owners,
  uncertain minimum writes, close order and fullscreen cleanup.
- Native desktop services: 5/5 (`native-unit-2.log`), including physical/logical
  conversion, monitor bounds, schema/controller checks and document retirement.
- Browser opening/closing regression: 23/23 (`chromium.log`). The additional
  internal-divider then outer-edge scenario passed 1/1 (`divider.log`). These
  exercise the real hook/CSS with an OS IPC fixture.
- Existing ADHD native-expansion geometry regression: 1/1 (`adhd.log`).
- Real isolated Electron acceptance: `native-3/verification.json` and
  `native-3.log`. With a 272 px sidebar and 728 px main chat, actual content
  widths 1580 / 1320 / 1460 px produced right-panel widths 580 / 320 / 460 px;
  chat remained 728 px for both side chat and workbench. Attempting 1100 px was
  constrained to the usable minimum. Closing restored 1000 px and the previous
  native minimum; document retirement restored the normal 600 × 480 minimum.
- The native harness uses the production hook, preload, NativeOwner and
  DesktopServices with fixture content and an isolated profile. It resizes the
  actual OS window via Electron, not by dragging the system border with a mouse.
  No installed-App or Windows physical-machine acceptance is claimed.
- Client TypeScript/translations/production build passed (`build.log`), with
  existing bundle-size and dynamic-import warnings.

No production Host/App restart, installation, release, model call or data change.
