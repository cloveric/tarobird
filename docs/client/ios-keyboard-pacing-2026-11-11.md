# iOS keyboard pacing

The requested change is a slightly quicker-feeling chat animation. The reported
symptom is smooth but slow movement, with the keyboard and chat moving together,
in both short and long conversations.

New iOS shells already provide their window-relative keyboard height and UIKit
animation duration. Keep that duration and use a modestly earlier middle section:
`cubic-bezier(.2,.35,.45,1)` replaces `ease-out` only when the native
`tarobotKeyboardInsets` capability is present. At a 383 ms duration, the calculated
time to 80% travel changes from about 236 to 199 ms. This does not change the
system keyboard's speed or claim a higher display frame rate.

Android's 285 ms curve and older iOS shells' 250 ms fallback are unchanged.
Height measurement, frame scheduling, message virtualization and scroll ownership
are unchanged. Expired events, zero-duration corrections, window resizing and
zoom keep their existing handling. The earlier immediate-update experiment was
discarded and is not part of this change.

## Verification

- FABLE5 reviewed the scoped approach, including preservation of old-shell and
  Android behavior, bridge-delay compensation, and separate checks of dismissal.
- The viewport regression first failed on the prior curve, then passed with the
  change. Existing Android, fallback, stale-report, resize and teardown cases
  remain part of the same suite.
- Chromium runs the real App against an isolated Hub with simulated iOS reports
  and actual CSS transitions. It checks painted-tail following, opening, closing,
  reversal, preservation of the reading position and draft, and zero document
  scrolling. The tail check uses the rendered last message, because the iOS
  virtual spacer may temporarily retain a deferred size correction.
- A separate iPhone Duo cover-window Simulator component probe uses the
  production Swift keyboard-insets bridge and viewport controller with UIKit
  keyboard events. In two warm open/close cycles per variant, 80% page travel
  occurred at about 237–269 ms before and 206–226 ms after. The native guide's
  corresponding timing remained about 135–143 ms. These are small-sample
  diagnostics, not a guaranteed device-speed improvement.

The native probe uses a UIKit text field to trigger the keyboard and a synthetic
chat layout. It does not establish full-App caret alignment, third-party keyboard
behavior, physical-device acceptance or the reported iPhone 17 Pro Max's perceived
speed. Those remain checks for an authorized installation/release. No release or
owner-App update is performed by this change.

This is a client presentation change. Host APIs, data, permissions, dependencies
and the headless CLI are unaffected; no CLI command is needed.

The [2026-11-12 chat follow-up](ios-chat-keyboard-speed-2026-11-12.md) adds a
separate duration cap to two phone-chat transitions. The general motion and
other surfaces described above retain their existing OS duration.
