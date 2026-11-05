# Android notification sound and vibration

The user receives notifications in the Android notification shade, but reports
no sound or vibration. The old native publisher creates a HIGH-importance
channel without enabling vibration. A clean API 36 emulator installation
reproduces this: the posted notification exists and has a default sound URI,
but `shouldVibrate()` is false. Thus vibration has a confirmed code defect;
the user's sound symptom cannot be attributed to the same defect without
reading the phone's channel, volume and silent/Do Not Disturb settings.

## Behavior

- `MessageNotificationChannel` owns the persisted `tarocub` channel. FCM and
  UnifiedPush both use `TaroCubNotifications`, so the presentation is shared.
- A new channel requests the system notification tone, notification audio
  usage, HIGH importance and one 200 ms vibration. The manifest explicitly
  requests VIBRATE. Android 7 uses equivalent per-notification sound/vibration.
- Existing channel settings are preserved. The App does not delete or rotate
  channel IDs, raise existing importance, override silent settings or bypass
  Do Not Disturb. Duplicate delivery retains the existing stable notification
  identity and only-alert-once flag.
- Read-only status now reports whether the existing channel allows sound and
  vibration, including importance below DEFAULT. Missing and older bridges
  never invent an alert state. No channel is created merely to inspect it.
- Android notification settings show sound/vibration separately from push
  readiness. The explicit settings button opens the existing message category,
  or the App notification settings when the category is missing/app disabled.
  Unsupported system settings activities fall back to App details. Returning
  triggers the existing foreground refresh without changing notification
  intent, quiet-hour drafts, provider or device registration.

Android does not allow an App to rewrite an already-created channel's sound
and vibration behavior. Existing installations may therefore need the user to
enable these in system settings even after updating. This is the reason for
the direct settings action, rather than silently replacing the channel.
See [Android channel ownership and settings](https://developer.android.com/develop/ui/compose/notifications/channels)
and [NotificationChannel](https://developer.android.com/reference/android/app/NotificationChannel).

This is App-native presentation and local OS settings; the Hub's routing,
push payloads, notification preferences and CLI do not change. CLI applicability:
no new host command or standalone host release is needed.

## Verification and limits

- Before the fix: the clean-install native vibration assertion fails; the
  browser sound/vibration-status assertion also fails.
- API 36 emulator, disposable `com.tarobot.notificationtest` installation:
  three native cases pass for fresh defaults and duplicate updates, preserving
  an old silent/low-importance channel, and read-only inspection/settings
  intents without creating a channel. Each runs after a clean disposable
  installation; production pairing/history is untouched.
- Android debug APK and instrumentation APK compile; all 30 JVM tests pass.
  Android lint completes with zero errors and 24 warnings.
- Chromium and WebKit each pass 31 notification-readiness/settings journeys,
  including independent sound/vibration states, older native bridges, settings
  launch failures, no consent/token mutation, foreground updates and quiet drafts.
  The final concise status copy also receives a focused rerun.
- Frontend translation, TypeScript and production build pass. Evidence lives
  under `/Volumes/gdrive/taro-tmp/tarobot-notification-alerts-20261017`.

No physical Android device was connected. Emulator channel state proves the
requested configuration, not audible sound or physical vibration on the user's
vivo. No production APK was published/installed during this change, and no real
FCM delivery or Android 7 hardware acceptance is claimed.
