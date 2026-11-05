# Android recording after microphone approval

## Cause and change

The Android manifest declared `RECORD_AUDIO` but omitted
`MODIFY_AUDIO_SETTINGS`. The installed Capacitor 8.5.2
`BridgeWebChromeClient.onPermissionRequest` requests both for WebView
`AUDIO_CAPTURE`. Its activity-result callback denies capture if either result
is false, even when the user has already granted the visible microphone
permission. The browser then reports `NotAllowedError`, producing the user's
misleading repeat-permission banner.

Declare `MODIFY_AUDIO_SETTINGS` alongside `RECORD_AUDIO`. Keep Capacitor's
permission checks and the user's microphone choice in control; no blanket
WebView permission grant or settings bypass is added. Android classifies the
additional permission as normal, not a second runtime microphone prompt
([Android reference](https://developer.android.com/reference/android/Manifest.permission#MODIFY_AUDIO_SETTINGS)).

## Regression and reproduction

`RecordingPermissionTest` starts the actual packaged `MainActivity` in a
separate `.voicetest` application, grants its runtime microphone permission,
verifies that Android reports it granted, and sends an audio capture request to
the production WebChromeClient. It asserts the resulting native callback grants
the requested resource. This tests Android's permission results and the
Capacitor callback, rather than a browser mock or a source-text assertion.
It does not open a microphone or record the user.

Build and run with the configured SDK/JDK and a disposable emulator:

```sh
cd client/android
./gradlew --no-daemon -PtarobotApplicationId=com.tarocub.client.voicetest \
  :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:lintDebug
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5554 shell am instrument -w \
  -e class com.tarocub.client.RecordingPermissionTest \
  com.tarocub.client.voicetest.test/androidx.test.runner.AndroidJUnitRunner
```

Target `:app:assembleDebugAndroidTest`, not the aggregate task that also builds
unrelated dependency modules' example instrumentation APKs. The aggregate task
currently encounters duplicate Kotlin classes in the generated Cordova plugin
test package; no dependency source was modified to conceal that issue.

## Verification boundary

Before the manifest change, this test failed on Android 16 / API 36 arm64 with
`expected: granted, actual: denied`, after confirming RECORD_AUDIO was granted.
The emulator was started with host audio disabled and the test used an isolated
package, preserving the existing App's data.

After the change, the same native test passed. App debug compilation, 20 native
unit tests and Android lint passed (0 errors, 22 existing warnings). The final
default-package APK was rebuilt and its packaged permission list includes both
audio permissions. The temporary test packages were removed and the emulator
stopped.

Client production build passed. Chromium and WebKit each passed all 8 voice and
voice-draft journeys: real browser encoding, playback, attachment transport,
permission rejection/retry, cancellation and cross-conversation draft retention
using a synthetic microphone. These are not physical microphone results.

The initial standalone gate had 7 failures in the unchanged `service.test.ts`
during overlapping native/browser work; the other 212 files passed. An isolated
rerun passed all 172 service tests. The failure is recorded separately from the
native permission regression, which failed before and passed after the manifest
change.
The final full standalone gate passed: 213 test files, 2,823 tests passed and
1 skipped, with no service or test timeout changes.

This change requires a new native APK; updating the Hub or web assets alone
cannot add a manifest permission to an installed App. No release or installation
on the user's physical phone is included. Physical microphone capture, device
audio quality, OEM privacy controls and speech-transcription services remain
separate acceptance surfaces.
