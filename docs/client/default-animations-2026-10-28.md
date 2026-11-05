# Animations enabled by default — 2026-10-28

Follow-up: the owner clarified that App animations must always remain enabled.
System-triggered suppression was subsequently removed too; see
[always-on animation behavior](always-on-animations-2026-10-28.md).
The record below describes the first switch-removal checkpoint.

The General settings page no longer exposes an Interface animations switch.
App animations default on across desktop and phone clients. The operating
system's Reduce Motion preference still takes precedence and updates live.

Both preference readers normalize a legacy `animations: false` value to true.
The startup appearance mirror and live appearance application also ignore the
retired off value, so existing installations cannot get stuck with animations
disabled and no control to re-enable them. The compatibility field remains
readable; no database migration or unrelated preference reset is needed.

This changes client presentation only. Host delivery, notification settings,
model execution and the headless CLI are unaffected; no CLI command is needed.
It does not change animation durations, input cancellation or page geometry.

Verification: client translation/type checks and production build passed; the
Host/CLI build passed with 459 standalone modules. Five Chromium motion cases
and three WebKit motion/queue-drag/accent cases passed across the focused runs.
The initial motion case failed in both browsers because it still waited for
the settings dialog's old CSS entrance. The fullscreen settings page now uses
WAAPI on its arriving section; the assertion was updated to verify interruption
of that actual animation, then the case passed in both engines. It also seeds
old off values in IndexedDB and the appearance mirror before reloading.

Browser coverage is not physical-device or installed-App acceptance. No release
or installation is performed by this source change. Local evidence is retained
under `taro-tmp/motion-default-20261028` on the external workspace disk.
