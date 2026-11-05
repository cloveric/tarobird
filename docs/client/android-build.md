# Android development build

The Capacitor app targets Android SDK 36, compiles against SDK 37, and requires
JDK 21. A debug APK does
not require an Android signing account or production FCM credentials. Without
`google-services.json`, Firebase delivery remains unavailable; this does not
disable local chat or the separately configured UnifiedPush integration.

Install the Android command-line tools from Google's official distribution and
review/accept the [SDK license](https://developer.android.com/studio/terms) before
installing SDK packages. The project does not automatically accept these terms.
With the command-line tools available under the selected SDK root:

```sh
export JAVA_HOME=/absolute/path/to/jdk-21/Contents/Home
export ANDROID_HOME=/absolute/path/to/android-sdk
export GRADLE_USER_HOME=/absolute/path/to/gradle-cache

"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  'platform-tools' 'platforms;android-37.0' 'build-tools;36.0.0'

# From the repository root. Finish this build before running browser tests.
npm run build --prefix client
(cd client && npx cap sync android)
(cd client/android && ./gradlew --no-daemon assembleDebug testDebugUnitTest lintDebug)
```

On Linux, `JAVA_HOME` points directly to the JDK root rather than `Contents/Home`.
The toolchain and Gradle cache may live on an external disk. Set these variables
for the build session; no system-wide Java replacement is needed.

Output is `client/android/app/build/outputs/apk/debug/app-debug.apk`. Check the
actual build exit status and lint report before treating it as a usable artifact.
`gradlew help` and `:app:dependencies` validate project setup/dependency metadata
only; they do not compile Java/Kotlin or produce an APK. The scaffold's native
sample tests also do not establish behavior of sharing, push or biometric lock.
Browser bridge tests are separate from Android device acceptance.

## Installable private test APK

The Android launcher now uses the existing TaroBot icon and product name. The
application ID is now `com.tarobot.client`. Android treats this as a new App,
separate from the former `com.tarocub.client`; install the new package and pair
again. Do not copy the old installation identity or bypass updater package
checks. The existing `tarocub://` links remain readable for host compatibility.
Firebase must register the new package and supply a matching private
`google-services.json`; editing the old JSON package field is not registration. `tarobotVersionCode` and `tarobotVersionName` Gradle
properties can override the checked-in test version. Increase the code for each
distributed update and keep the same signing key; a different certificate cannot
update an already installed app. Do not uninstall to resolve a signing mismatch
without first considering the paired hosts and local data that would be lost.

For a private, non-debuggable test build, after building and syncing web assets:

```sh
cd client/android
./gradlew --no-daemon assembleRelease testDebugUnitTest lintRelease
# Optional explicit version on that command:
# -PtarobotVersionCode=2026101102 -PtarobotVersionName=0.1.374-test.2

"$ANDROID_HOME/build-tools/36.0.0/zipalign" -P 16 -f 4 \
  app/build/outputs/apk/release/app-release-unsigned.apk /path/to/aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign \
  --ks /private/path/tarobot-test.jks --ks-key-alias tarobot-test \
  --ks-pass file:/private/path/password.txt \
  --out /path/to/TaroBot-test.apk /path/to/aligned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs \
  /path/to/TaroBot-test.apk
```

The test key and its password belong outside the repository and build artifacts.
They are not a Play Store signing setup. The release APK packages bundled web
assets and does not need a development web server. Unit tests currently run with
the debug test variant; release compilation and lint are separate checks.

On this Mac, the SDK, portable JDK, Gradle cache and emulator live under
`/Volumes/gdrive/dev-cache/tarocub-android`; the persistent private test signer is
under `/Volumes/gdrive/tarobot-signing/android-test`. These are local machine paths,
not files shipped to users. Google SDK tools were installed for this APK build;
earlier dated notes below describe the pre-installation state.

## Push registration source update, 2026-10-11

[Request-bound FCM registration and cleanup](android-fcm-registration-2026-10-11.md)
replaces Android retained registration broadcasts, waits for explicit Firebase
Tasks before token deletion, and fences destroyed Activity owners. The production
Java coordinator passes 10 independent JVM tests; Chromium/WebKit each pass 69
related bridge/UI cases. These do not compile the Android plugin or prove FCM
delivery. Latest copied frontend resources have a separate byte-level receipt
under `evidence/android-fcm-registration-20261011/`; SDK consent and APK/device
gates remain pending. SDK-owned auto-refresh is not fully cancelled by this change.

After a successful build, native acceptance must still cover pairing and revoke,
system shares (text with multiple files), return from background, microphone and
camera permissions, Android Back navigation, biometric/device authentication,
locked-screen individual pushes and notification deep links. UnifiedPush needs
an actual distributor; production FCM needs its own project configuration.

## Local preflight, 2026-10-03

Portable Temurin 21.0.12.1+1 (macOS arm64) was verified against the publisher's
SHA-256 file and executed successfully. Gradle 8.14.3 completed both `help` and
`:app:dependencies --configuration debugCompileClasspath`; the resolved
UnifiedPush 3.3.5 public Java signatures match the custom plugin's calls and
service overrides. No SDK packages were installed: SDK license consent is
pending. Android compilation, lint, APK output and device acceptance remain open.

The macOS r6 packaging pass copied and verified all 95 current frontend
files in both Android and iOS shells. This refreshes web resources only; it does
not install SDK packages, compile an APK or establish Android runtime behavior.
The r6 receipt（本地材料：`evidence/macos-r6-2026-10-03.json`） records the byte comparisons.

On 2026-10-04 the r7 packaging pass recopied the updated multi-host and phone
IM frontend. All 95 files matched that browser-accepted build in both mobile
shells at that milestone. The r7 receipt（本地材料：`evidence/macos-r7-2026-10-04.json`）
records this resource-level check. Android SDK tools still are not available in
the configured local environment; this is not an APK compilation result.

## Multi-host push source validation, 2026-10-04

`app/src/test/java/com/tarobot/client/UnifiedPushRegistryTest.java` exercises the
production persisted registry with real `org.json` and JUnit, independently of
Android APIs. These JVM tests were compiled/executed using the portable JDK 21;
the app Gradle test dependencies include `org.json:json:20240303`. This does not
compile the Android Plugin/Service or satisfy APK/lint/device gates. The
[multi-host push review](unifiedpush-multiple-hosts.md) records the protocol,
client bridge tests and remaining device checks.

## Latest resource and toolchain state, 2026-10-04

After full mobile browser regression and r8 macOS packaging, both phone shells
contain the same 97 frontend files as the accepted build, verified byte for byte.
See [full mobile regression](mobile-full-regression-2026-10-04.md) and
r8 packaging（本地材料：`evidence/macos-r8-2026-10-04.json`）. The user guide now follows the
phone Messages / Bot / Me layout and multi-host controls.

The portable JDK and Gradle remain installed on the external disk; there is no
configured Android SDK, adb or emulator. A concrete request to accept Google's
SDK license and install SDK 36, build tools and adb was sent; no acceptance has
been received at this milestone. No license marker was created and no SDK
package was installed. APK compilation and native phone checks remain open.


## Opus visual refresh resource copy, 2026-10-04

The r10 packaging pass copied all 97 frontend files from the accepted Opus visual
refinement into Android and iOS, with byte-for-byte verification against
`client/dist`. See r10 receipt（本地材料：`evidence/macos-r10-2026-10-04.json`）. This updates
web resources only. Android SDK license acceptance, APK compilation/lint, real
keyboard and device lifecycle checks remain pending; no license marker or
production push configuration was created by the resource copy.
