# Android private test build — 2026-10-11

Installable package: **TaroBot 0.1.373-test.1**, version code `2026101101`.
Download from the private [Android test release](https://github.com/cloveric/tarobot/releases/tag/android-test-20261011.1).
This is a signed, non-debuggable test APK, not a Play Store release.

## Package and fixes

- Package ID `com.tarocub.client` is retained. Launcher name and icons use
  TaroBot; some existing in-app copy still says TaroCub. Startup no longer shows
  the Capacitor sample logo.
- A persistent private test certificate signs this and subsequent test updates.
  Signing material lives outside the repository and APK. App version code must
  increase for each distributed update.
- Fixed Android compilation of `DeviceIdentity.legacyValue`: Android's JSON API
  declares checked `JSONException`, unlike the JVM test dependency. The existing
  exception boundary now receives it; migration and storage semantics are unchanged.
- The Hub address field uses URL input mode with capitalization, autocorrect and
  spelling correction disabled. The Android keyboard had capitalized the scheme.
- UI resources are bundled locally. No development browser/server, Feishu SDK,
  Feishu CLI or Feishu account is required by the APK.

## Verification

- Client build, root standalone build, and focused pairing/keyboard browser
  regression passed. Root graph remains 275 modules without a legacy transport
  or Feishu SDK import.
- Actual Android SDK compilation: `assembleRelease testDebugUnitTest lintRelease`
  passed. App JUnit reports contain 20 cases, including one scaffold arithmetic
  test; identity checks include the shared migration/signing vectors. The test
  variant is debug, while the delivered APK and lint variant are release.
- Release lint reports **0 errors and 22 warnings**, including dependency version
  suggestions, unused scaffold resources and icon guidance. Warnings were not
  disabled or represented as zero findings.
- APK ZIP integrity, 16 KiB alignment and v2/v3 signatures passed. All **305**
  copied web assets match the package byte for byte. No remote `server.url`,
  signing key/password or Firebase project configuration is embedded. The
  manifest keeps backup and cleartext network traffic disabled.
- Installed the signed APK on an **Android 16 / API 36 arm64 Pixel 7 emulator**.
  Cold launch renders the real native WebView pairing screen. The URL keyboard
  preserves `https://` in lowercase, and Android Back dismisses the keyboard.
  The scanner invoked the OS camera permission dialog; denial remained recoverable
  through the scanner's close/Back controls. Same-certificate replacement install
  succeeded, followed by another cold start. No app fatal exception was observed.
- Initial SwiftShader emulator screenshots had rendering artifacts. Rechecking
  with host GPU and Vulkan disabled produced clean screenshots without changing
  application rendering rules. This does not establish every physical GPU's behavior.

SHA-256: `f11fbf4a3130a2254d621c637f666511eb80de97948ecb2c96ef60595b2d963a`

Size: **16,076,239 bytes** (15.33 MiB). Minimum SDK 24, target SDK 36, compile
SDK 37. Included ABIs: arm64-v8a, armeabi-v7a, x86 and x86_64; only arm64 was run.
Certificate SHA-256:
`9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.

Local evidence is under
`/Volumes/gdrive/releases/tarobot/android/20261011-test1/evidence/`.
Build tools, Gradle cache and emulator are on gdrive. GitHub Actions could not
start because of an account payment/spending-limit gate; these are local native
build and emulator results, not a successful hosted workflow.

## Start testing / 开始测试

1. Download the APK while signed into the private repository, then open it on
   Android. Allow installation from the chosen browser/file manager if prompted.
2. On an already trusted desktop device, open **Settings → Devices & security →
   Add a device** to display the Hub connection QR code. Scan it in the Android
   app, then approve the phone's pairing request on the trusted device.
3. The Hub address must be reachable from the phone using HTTPS and a valid
   certificate. A desktop-only `127.0.0.1` address is not the desktop from the
   phone. Existing direct/Tailscale/VPS routes are separate host setup.
4. Test text and streaming first, then attachments with captions, voice, long
   press/quote/forward, stopping a Bot, app background/foreground and cross-device
   sync. Report the phone model, Android version, exact steps and a screenshot or
   recording with each bug; the Android system app-info page shows this build's
   version.

中文：安装后扫描桌面端「设置 → 设备与安全 → 添加新设备」中的 Hub 二维码，再在可信
设备上批准手机的配对请求。以后安装同一签名的新测试包可以覆盖升级。若提示签名冲突，
先核对旧包来源，不要直接卸载丢掉本地数据。

## Still open

No physical phone was connected. This pass does not certify actual Hub pairing,
Bot message/file/voice round trips through the installed Android APK, real camera
capture, microphone permissions, background reconnection, lock-screen delivery,
or paired data retention across an upgrade. Earlier protocol/desktop live CLI
results are separate evidence. FCM is unconfigured; UnifiedPush needs a configured
distributor and host. Other Android OS versions and ABIs remain untested.

The build does not deploy a Hub, update the installed desktop application, or
restart any existing TaroCub/Feishu Bot services.
