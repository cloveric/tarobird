# Phone message actions and long-press feedback

The per-message More button duplicated the bubble's long-press menu and forced a
44px author/time row. It is removed on phones. The header's conversation menu and
attachment quote/forward shortcuts retain their existing scope. Desktop toolbars
and context menus retain their behavior.

`useMessageHold` now returns the source message row rather than searching for a
More button. The row is focusable and can open the same sheet with Enter, Space,
the context-menu key, Shift+F10 or a direct assistive click. Ordinary taps on text
do not open the menu; file taps still preview. Links, code and form fields retain
their own interaction. Closing the sheet returns focus to the row, with the
existing conversation fallback when a virtual row or its conversation disappears.
The author/time row no longer reserves space for the removed control. Copy status
remains a polite live region.

## Feedback ownership

The App previously called Capacitor's light impact after its 500ms hold timer.
Android WebView also calls `performHapticFeedback(LONG_PRESS)` for a consumed long
press; see [Chromium's gesture handler](https://github.com/chromium/chromium/blob/main/content/public/android/java/src/org/chromium/content/browser/GestureListenerManagerImpl.java).
These are two feedback owners, not two menu-opening callbacks. Capacitor's Android
light waveform itself contains one pulse (`[0, 50]`, amplitudes `[0, 110]`).

`nativeHoldHaptic` now skips the extra App impact on Android, preserving the system
long-press feedback and the user's system touch-feedback setting. It retains one
light impact on iOS. Send/voice-send feedback is unchanged. This avoids disabling
the WebView's feedback globally, so native selection and inbox holds keep their
normal feedback. [Android haptic API behavior](https://developer.android.com/develop/ui/views/haptics/haptics-apis).

## CLI impact

The requested change concerns presentation and gesture feedback. The additional
draft fix below changes only client-local cleanup after an existing send receipt.
No host API, message state, permission rule, schema or CLI operation changes.

## Additional confirmed regression found during verification

The collaboration send path cleared the visible composer but compared the saved
draft against the generated wire command (`/ask …`, `/fan …`, etc.). The cache
contains the original prompt, so the comparison failed: the list showed a ghost
draft and switching conversations restored already-sent text. The send path now
captures the actual draft and clears only that matching value after the receipt,
with its existing revision guard and cache comparison protecting newer edits.

The collaboration journey now checks successful-send cleanup on both devices and
retention of an unsent prompt after failed preflight and offline reload. The latter
correctly takes priority in the list over the previous message author.

## Verification

- A pre-change regression expected zero phone message More buttons and observed
  one, confirming the redundant entry.
- Translation validation, TypeScript and production client build pass.
- 38 unique journeys pass in Chromium and 38 in WebKit, including the targeted
  reruns after fixing the collaboration draft bug and fixture assumptions. The
  final 10-journey App/message/delegation rerun passes in each engine.
- Browser verification covers phone/desktop menus, exact quote/forward ownership,
  draft retention, archive/streaming constraints, source removal, native Back,
  focus return, file previews, release suppression and cancellation.
- A substituted Haptics bridge counts calls from the real App: Android gets zero
  extra impacts, iOS gets one per deliberate hold, and web gets none. Repeated
  contextmenu/release events and cancelled holds add no impact. A later deliberate
  hold remains available. These bridge checks do not measure a physical vibrator.
- Two older fixture assumptions were corrected: wait for host rename to finish
  before Escape (the dialog cannot close while busy), and use a viewport with
  actual scroll range when checking desktop menu dismissal.

Evidence lives under `/Volumes/gdrive/taro-tmp/tarobot-message-hold-20261016`.
This is a source change, not a new APK or installed-client update. The user's vivo
hardware pulse sensation remains a real-device acceptance item after installation.
