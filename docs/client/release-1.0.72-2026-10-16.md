# TaroBot Android 1.0.72: open downloaded files and APKs

After an Android download, the card previously showed a successful save location
but no action to open the saved file. Only desktop saves returned an actionable
reference. Android now returns its completed public Downloads content URI and the
card offers **Open file**, or **Install APK** for `.apk` attachments.

Opening uses the existing saved copy, with no second network download or cache
export. The native saver accepts only URIs recorded after its own successful saves
in the current App session, checks that the file can still be read, and grants the
receiver read-only access. Arbitrary URIs, deleted files and failed saves do not
become open grants. Starting a replacement save clears the previous action.
Open errors retain the save receipt so the user can retry.

APK installation is explicitly user initiated. The manifest declares
`REQUEST_INSTALL_PACKAGES`; Android 8+ opens TaroBot's per-app unknown-source
setting when needed, checks permission again on return, then launches the system
installer with the saved URI and APK MIME type. The system owns confirmation,
signature/version checks and installation. Cancelling permission shows a retry
instruction; handing off to the installer never claims installation succeeded.
See [Android's permission API](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls()).

The first update from an older TaroBot still requires the phone's file manager:
Downloads → TaroBot → `TaroBot-1.0.72-android.apk`. Keep the existing App installed
and apply the update. The new button appears on subsequent completed saves.
Saved-action receipts are transient card/session state, not a persistent download
history. Browser and iOS behavior is unchanged; Android 7–9 document-provider
opening has not been checked on a device.

## Release scope and verification

This is an Android-only prerelease. App version `1.0.72`, version code
`2026101601`, application ID `com.tarocub.client`. It retains the original test
certificate SHA-256
`9e3ed24a0b9b90f765d2a21d4107c6f3e124fa652f6bf9cfc2fb04155c0c1b30`.
The host/CLI remains `0.1.424`, schema 15; this device UI/OS handoff changes no Hub
API, CLI capability, engine adapter or host state. No new desktop or CLI release
is needed, and no production host or optional adapter is restarted.

- `pre-complete-hook.sh`: standalone build and 3,806 source tests pass, one
  existing skip. Clean client dependency installation and production build pass.
- 30 distinct Chromium/bridge checks pass across `android-saved-file`,
  `mobile-file-export`, `desktop-export`, `file-actions` and `attachment-safety`.
  They cover no extra download, action serialization, failed-open retry,
  cancelled replacement, old native receipts without URI, and desktop/iOS/browser
  compatibility. These bridge doubles are not physical-phone evidence.
- Android build, 30 JVM tests and lint pass (0 errors, 22 existing warnings).
  The signed non-debuggable APK has the expected identity, installer permission,
  392 matching packaged web files and all 15 launcher PNG variants.
- Three Android API 36 instrumentation tests pass in an isolated `.downloadtest`
  App: exact public download bytes/duplicate names; another UID reading a saved
  file after cache deletion without write permission; arbitrary/deleted URI
  rejection; APK permission cancellation/retry and the actual system installer
  update confirmation. The test cancels that confirmation, not an installation.
- The signed APK updates the emulator's existing `0.1.375-test.3` installation
  in place, preserves its first-install timestamp, cold-launches successfully
  and leaves an empty crash buffer. The standalone package also passes a clean
  production dependency install and Hub/client asset startup verification.
- Physical-phone installation and manufacturer-specific installer UI remain
  unverified. This release does not add or revalidate FCM delivery.

APK button (historical image omitted from this clean snapshot) ·
System installer (historical image omitted from this clean snapshot) ·
[Native acceptance](evidence/android-open-1.0.72/native-acceptance.txt) ·
[Artifact verification](evidence/android-open-1.0.72/verification.json)

APK SHA-256: `e1b4926ec90c88d012bf65c91d343d184d0d74cf8005f44eacf19396b6d5abe0`.

[Published Android release](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.72):
APK and SHA256SUMS uploaded, downloaded through the authenticated GitHub asset
API and verified against the local originals. [Publication receipt](evidence/android-open-1.0.72/published.json).
