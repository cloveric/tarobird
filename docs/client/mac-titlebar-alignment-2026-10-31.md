# Mac title-bar alignment (2026-10-31)

The Mac close/minimise/fullscreen controls appeared below the sidebar TaroBot
wordmark. The Electron migration copied the old Tauri `trafficLightPosition`
(18, 30), while the CSS/test commentary still described a centre at y=28.
Electron positions the top of its 14px controls, yielding a centre at y=37.
The actual wordmark bounds are y=19, height=18, centred at y=28.

Set the Electron-only position to (18, 21). This aligns its centre to the
existing 56px brand row without moving or resizing the title, search field or
sidebar. Update the obsolete coordinate comments; the existing browser
hit-point assertions already cover the intended y=21..34 control area.
The legacy reader, Windows/Linux frame and phone layout are unchanged.

Validation:

- Actual `createDesktopWindow` in Electron 45.1.0, two isolated native profiles:
  `getWindowButtonPosition()` changed from (18,30) to (18,21); renderer wordmark
  bounds remained exactly unchanged. CUA inspected both native test windows.
  macOS's sharing indicator overlays the control area during CUA capture, so
  those screenshots are not individual-button pixel measurements.
- Existing `desktop-window-chrome.spec.ts`: 3/3 Chromium tests passed, covering
  native drag-region CSS, controls clearance at wide/narrow widths, minimum
  sidebar width, fullscreen clearance, and image-viewer hit areas.
- Client build and native-module syntax check passed. The first browser command
  used the wrong working directory; it was stopped and rerun from `client`.
  No new OS window-drag or fullscreen round-trip claim is made.

CLI impact: none; this is a macOS window-decoration position change and does
not change Host APIs, data, permissions or commands. No release, installation,
production Host restart or production profile change was performed.
