# iOS chat keyboard transitions

The phone chat now settles sooner when its composer opens the keyboard, and the
inbox/tab bar settles sooner when returning from chat with the keyboard open.
The system keyboard itself still uses UIKit's timing. This changes the App's
page movement, not the operating system keyboard, input latency or frame rate.

`viewport.ts` retains the general OS-duration motion and publishes a separate
native-iOS chat value capped at 250 ms. Shorter native durations remain shorter;
bridge delay is still subtracted, and expired/zero-duration reports, window
resizing, zoom and disposal retain their existing handling. No new timers,
React updates, synthetic keyboard heights or focus/navigation side effects are
introduced.

The CSS override is limited to the iOS phone layout (up to 760 CSS pixels):

- Opening: the main chat composer has focus and the native keyboard is open.
- Returning: the inbox is visible and the native keyboard reports closed.

A keyboard dismissal that stays in chat, foreground sheets/forms, Android,
desktop, wide layouts (including phone landscape above 760 CSS pixels) and
older iOS shells keep their existing timing. The new variable is not substituted
into the general form/sheet timing. Inbox height restoration also uses the cap
when its search or a sheet dismisses the keyboard; the sheet itself retains its
OS timing. A device that reports 250 ms or less gets no duration reduction.

## Verification and limits

FABLE5 independently reviewed the candidate diff and found no blocking issue.
The review distinguished source/Chromium reasoning from unrun native checks;
the implementation-side component evidence below was collected separately.

The targeted unit and real-App Chromium regression failed on the previous
source and passed after the change. The controller suite has 18 passing cases;
the motion journey verifies opening, closing, reversal, reading position,
painted tail, draft retention and returning to the inbox. Another 17 existing
keyboard/dismissal cases passed, including Android forms and ordinary iPhone
portrait/landscape focus behavior. The client build passed with existing
chunk-size/dynamic-import warnings. No dependencies were changed.

A separate iOS 27.1 Simulator component check used the production Capacitor
shell and native keyboard bridge with the real viewport controller/CSS,
XCTest input taps and three open/back cycles. Its narrow iPhone Duo window was
386 by 678 CSS pixels. Warm samples reached 80% of page travel in 134–140 ms,
versus 205–207 ms before; 99% travel took 222–234 ms, versus 339–355 ms before.
The native duration remained about 383 ms. Draft contents and final input/tab
bar positions were retained. These small samples are diagnostics, not a
physical-device speed guarantee.

An initial bare-WKWebView probe did not reproduce Capacitor's resize and
accessory-bar policy. Its XCTest passes are excluded from the geometry and
speed evidence; the corrected production-shell comparison above is the valid
native component result. The real-App flow is covered separately in Chromium.
Physical iPhone 17 Pro Max and full installed-iOS-App visual acceptance remain
unverified. No release or owner-App installation is performed by this change.

This is client presentation only. Host behavior, permissions, persistence and
the headless CLI are unaffected, so no CLI command is applicable.
