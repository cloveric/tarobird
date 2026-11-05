# Phone keyboard motion — 2026-10-23

Status: implemented by Opus 5.5 (xhigh) in the mobile-motion collaboration,
with a second pass after the root review. Android emulator and browser
evidence below. iOS keeps its previous 250 ms fallback and still needs a
physical-device look.

## Behavior

Both native shells now overlay the soft keyboard instead of resizing the
WebView. The page receives the keyboard's end-state height once per change and
animates its own shell to it with the OS keyboard's timing:

| Shell | Source | Timing |
| --- | --- | --- |
| iOS (`KeyboardResize.None`) | Capacitor Keyboard `keyboardWillShow/Hide` | 250 ms `ease-out` (unchanged fallback) |
| Android (`NativeInsets`) | `tarobot-keyboard` window event: IME overlap minus the navigation bar, plus native dispatch time; the page keeps the latest report in `window.__tarobotKeyboard`, republished after every page load | 285 ms `cubic-bezier(.2,0,0,1)`; the transition starts as far in as the bridge was late |

- `viewport.ts` sets `data-keyboard-motion` only while a keyboard change runs.
  - A window size change (rotation, split view) or zoom ends a running
    keyboard transition and applies at once; a keyboard change coalesced with
    one does too. This prevents double animation.
  - A report older than the OS animation (blocked JS, resume, restored or
    reloaded page) applies at once instead of replaying.
  - A repeated report (did-show, same IME) is ignored, so a form the reader
    scrolled is not pulled back.
  - A visual-viewport-only change inside the keyboard's window follows it
    (hedge in case WebKit also shrinks its visual viewport).
- `.app-shell` height, the composer's bottom inset, and phone bottom sheets
  (`dialog.creation-dialog`, `.preferences-dialog`: `bottom`/`max-height`)
  follow the keyboard. This is a height/layout transition, not a transform:
  iOS draws the caret natively from layout, so a composited transform would
  leave it behind. Chat follow-to-latest stays DOM-only (the existing
  `App.tsx` ResizeObserver), with no React state per frame.
- A focused lower text field is revealed by scrolling its inner container.
  While a sheet is still moving, this repeats each frame so the reveal is not
  clamped by the sheet's growing scroll range. It stops once the field is
  inside the final band. The chat composer rides on the shell and is never
  measured. Moving focus to another text field while the keyboard stays open
  also reveals it; buttons and checkboxes do not.
- Reduced motion: the system preference or `html[data-motion="reduced"]` (the
  shared local setting) declares no transition; geometry meets the end state
  at once.

Android previously padded the decor view for the IME. `onApplyWindowInsets`
receives an IME animation's end state before the keyboard moves (AOSP
`WindowInsetsAnimation.Callback#onPrepare`), so the WebView resized at once.
The composer and last message vanished for about 5 frames, then the composer
jumped and left an empty band of up to 322 CSS px while the IME slid in. On
hide, the composer sat under the sliding keyboard.

## Evidence

Isolated Hub, Android 16 / API 36 Pixel emulator (Gboard), debug build under
the separate package ID `com.tarocub.client.motiontest`, with screen recordings
analyzed frame by frame against a composer marker colour. Artifacts and tools:
`/Volumes/gdrive/taro-tmp/mobile-motion-20261023/opus/`.

- Baseline `27a5331`: across 4 IME events, 20 of 165 frames had no visible
  composer, and 14 frames had an empty band over 100 device px (max 845).
- This change: median composer/IME progress difference was 0.3%, with p95
  1.3–3.9% across four recordings. Of 16 recorded events, 13 had no frame
  lagging by more than 8%. Three had one or two such frames at the start; in
  one show the composer stayed under the rising IME for 2 frames, and the
  latency compensation then caught it up to the same progress.
- 6 open/close cycles: 712–720 rAF frames, none over 20 ms, and no long
  animation frames. The baseline also shows none in-page; its defect is the
  WebView resize.
- While a Bot streamed 120 paragraphs with repeated IME toggles, the tail
  stayed pinned above the composer after layout in 544 of 550 sampled frames.
  The other 6 were the same one-frame streaming catch-up seen without a
  keyboard. Reversing a hide by re-focusing mid-animation retargets smoothly.
- Reading earlier history kept its scroll position and first visible row
  through show and hide.
- New Bot sheet, Advanced → Workspace: the sheet follows the IME and the field
  reaches its final place within 3 frames, with no end-of-motion jump. The
  document scroll stayed 0.

Second pass, same emulator, debug APK of the reviewed commit:

- Chat sync: median 0.5% and p95 3.9% progress difference; no frame without
  the composer. The residual outliers were capture timing and Gboard overlays
  (toolbar redraw, "See more features" tip). 6 open/close cycles: 721 frames,
  none over 20 ms. Streaming plus toggles: 551 frames, none over 25 ms.
- Sheet form, history and pairing field: the same results as above. The
  pairing textarea is revealed above the IME with the document scroll at 0.
- Rotation: a window resize ends the keyboard transition and applies at once.
  The IME re-showing after rotation animates with it. A transient
  system-inset size during rotation moves the shell for one or two frames,
  the existing decor-padding behavior.
- Stale: an IME hide that arrived 947 ms late (JS blocked) landed in the next
  frame with no transition.
- Reload: a new page received the stored report (20 s old) through
  `onPageLoaded` and applied it without motion. With the IME open before the
  reload, the IME closed and the page agreed. A load with the IME still open
  was not produced.
- App switch: on return, Android reports hide then show about 100 ms apart
  (no report while in the background). The composer dips briefly and rises
  with the IME.
- Android "remove animations" (all three scales 0, after an app restart):
  `prefers-reduced-motion` matched and the shell landed in one frame. With
  only `animator_duration_scale` at 0, the WebView did not report reduced
  motion.
- The in-app switch: off lands in one frame, is persisted (`animations: false`
  mirror) and is restored as reduced after a restart; on restores motion.
- Keyboard plus the page transitions: BACK hides the IME (285 ms), the next
  BACK slides the list in from −28 px over about 180 ms, and re-entering
  slides the chat from +28 px.

iOS: an earlier iOS 27 simulator recording of the previous build showed the
composer starting one 120 Hz frame after the UIKit keyboard and lagging it
mid-way; a bezier fitted to those frames (`cubic-bezier(.25,.35,.3,1)`, within
2.5% on one show and two hides) is a candidate only. It is not applied
without a device recording or native timing data.

## Limits

- No physical Android device. OEM IMEs or ROMs with other timing, Android
  predictive-back IME gestures (the composer follows on release), and API
  24–29 compatibility insets are unverified.
- iOS: not re-recorded (no non-GUI tap injection; the device harness was
  unavailable). Needed on a device: composer/keyboard sync on show and hide,
  Chinese candidate-bar height changes, sheets with inputs, edge-back with the
  keyboard open, rotation, and the caret during motion.
- Android: Chinese IME, hardware keyboards, a page load with the IME already
  open, and Activity recreation after process death were not exercised.
- `dvh`-based phone layers not bound to `--shell-height` now extend under the
  Android keyboard, as they already did on iOS. The audited input surfaces
  (chat, sheets, settings, files, capabilities, pairing) are bound.

## Tests

`tests/client-viewport.test.ts` covers Android events, latency, stale,
repeated and restored reports, a window change during motion, a trailing
viewport correction, the iOS path and teardown. `e2e/phone-panels.spec.ts`
covers overlay keyboard motion, sheet reveal and the root lifecycle check
(window change, stale event, motion switch), in Chromium and WebKit. The existing `keyboard`, `phone-panels` and
`safe-area` suites pass.

Presentation-only. No Host API, protocol, permission or CLI change, so CLI is
not applicable.


## Same-height IME window resize follow-up

The 2026-10-23 revision audit reproduced a missing focus reveal in the real
New Bot → Advanced → Workspace form. With an overlay IME still 400 CSS px
high, reducing the window from 932 to 750 px correctly reduced the available
band to 350 px but left the focused input bottom at 524.78 px in WebKit.
Only a new keyboard-height or focus event requested another reveal.

The viewport controller now rechecks the active form field when the native
window changes size while the keyboard is open. It uses the existing inner
scroll-container reveal; already visible inputs cause no scroll write, ordinary
resizes without a native keyboard retain browser ownership, and chat composers
remain excluded. Repeated equal-size window/IME signals do not pull a manually
scrolled form back to the field.

`keyboard.spec.ts` exercises the actual New Bot UI and production controller
with an isolated Hub and synthetic native IME events. It checks the focused
workspace, retained draft, zero document scroll, repeated signals, an already
visible input and a no-keyboard resize. These are browser/native-event
simulations, not physical iPhone or Android acceptance. Evidence is under
`/Volumes/gdrive/taro-tmp/day-revision-audit-20261023/mobile-audit/`.

This follow-up is presentation-only; Host, CLI, protocol and permissions are
unchanged.


The same audit also exposed a pre-existing New Bot form issue: scrolling to
Advanced → Workspace scrolled the dialog title and Close control out of view.
New Bot now reuses the existing phone conversation-creation layout while its
input form is shown, keeping the header outside the form scrollport. The
post-creation screen keeps its existing layout. No typography or density
values change. The actual New Bot form is checked at 320 and 430 px widths,
including keyboard resize, retained input and closing from the scrolled form;
Bot creation/first-chat journeys retain their existing end-to-end coverage.
