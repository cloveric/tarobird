# First-run brand layout and phone sizing

The native phone connection page uses a 128 px phoenix above the centered
connection heading, with a 12 px gap. The adjacent product name is hidden on
this welcome page because the heading already names TaroBird. Desktop setup
keeps a 64 px mascot with the adjacent name aligned to its bottom. Pending phone
confirmation also retains the compact name/mascot combination. Loading,
recovery and sidebar branding keep their existing owners and sizes.

`Pairing.tsx` opts only non-pending native iOS/Android connection pages into the
phone welcome class. `pairing.css` owns sizing, alignment and connection-action
wrapping. The action row now wraps by available width and text size: image
import and camera scan stay side by side when they fit and stack on narrow
screens or with larger text. The previous fixed two-column layout let long
English button text overflow under synthetic 200 percent text scaling. Both
platform-hint regressions failed before this action-row repair and passed after.

This is App presentation only. No Host/CLI entry, pairing protocol, identity,
authorization, model adapter or stored preferences change. No release or local
App installation is performed by this change.

## Verification

The pairing fixture now loads the production CSS sequence and appearance
initialization, supports an iOS platform hint and mobile pending confirmation,
and keeps native IPC mocked. The layout suite covers:

- Portrait viewports 320×568, 375×667, 390×844, 440×956, 360×800, 412×915,
  344×882 and 673×841, with Chinese and English text.
- Safe-area tokens for notch/home-indicator layouts; 852×393 landscape;
  rotation to a keyboard-sized viewport while preserving the entered address.
- Synthetic 200 percent text scaling, dark theme, scrolling to controls and
  final instructions, and pending confirmation without the large welcome art.
- Desktop setup at narrow and wide widths; visible, bottom-aligned product name.
- No uncaught page errors, horizontal overflow or overflowing action labels.
- Existing scanner, return/focus, pairing-state and sidebar-brand journeys.

The existing scanner position assertion now checks that the complete touch
button fits within the viewport, instead of enforcing the old small-mascot
layout's arbitrary 400 px vertical limit.

Root/client builds passed. Chromium's first combined run had 44 passes and one
sidebar lazy-load failure while a concurrent build replaced the assets being
served; the trace recorded missing hashed JS resources. That run is retained
as a failed run. The complete four-case Chromium brand suite was subsequently
rerun against the settled build and passed all four cases. WebKit had 44 passes and one existing skip for
its unsupported live-camera stream simulation. The new layout suite passed
all 22 cases on both engines. These are browser/component and synthetic
viewport results, not physical iPhone/Android, OS text-size, camera, native
keyboard or installed-App acceptance.

The implementation starts from `d1431418a83200de66adc67e44359a05dcd25af6`.
Upload privacy/version gates apply to the resulting exact outgoing commit;
private traces, screenshots and raw scan output remain outside Git.
