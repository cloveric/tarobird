# Attachment Plus tap feedback

Android client 1.0.56 suppresses the WebView's additional tap-highlight overlay
on the phone composer Plus button. The inbox already suppressed this overlay,
but its selector did not include the chat composer. The existing theme-based
pressed/open colors and keyboard focus outline remain in place. The property
inherits into the Plus SVG so tapping the icon has the same behavior as tapping
the surrounding button.

The existing attachment-menu regression now uses a touch-capable browser context
and opens the sheet with a touch tap. The old production bundle failed the
transparent-overlay assertion with `rgba(0, 0, 0, 0.18)` in Chromium. The updated
bundle passes in Chromium and WebKit, checks the button and SVG, and preserves
the 2px keyboard focus indicator after Enter/Escape. Each engine passed three
workflows covering camera/photos/files, cancellation, combined caption delivery,
rotation and rejection of late file selections after conversation changes.

Root/client builds and Android release compilation, unit tests and lint passed.
The signed local APK is version 1.0.56 (2026101311). Package and original signing
certificate checks are separate from physical-device verification; no connected
Android device was available during this change.

## Remove filled touch feedback (2026-10-23)

The owner requested removing the remaining oval highlight, including theme
hover/open fills that the earlier fix deliberately retained. The phone Plus
button now stays transparent and shadow-free, including after touch return
from the attachment sheet. Its 44 px hit area remains; icon color communicates
the open state. A keyboard focus indicator stays on the button, while toolbar
focus no longer frames the entire composer. Pointer intent prevents a restored
Plus button from acquiring the keyboard-only outline.

The existing touch attachment workflow reproduced the unwanted nontransparent
fill before this change. It now checks touch return, all six named palettes,
Enter/Escape focus, camera/photos/files selection and cancellation, and combined
caption delivery. The visual rules apply to both phone platforms without
changing either platform's size baseline. This is presentation only; the CLI,
file APIs and native picker contracts are unchanged.

The expanded attachment workflow passed in Chromium and WebKit, alongside the
three dialog/settings checks in each engine (eight passing workflows total).
Root and client builds passed, and the phone return screenshot was inspected.
No physical-device acceptance or new installer is claimed for this source fix.
