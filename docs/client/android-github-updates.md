# Android in-app updates

The `com.tarobot.client` identity uses a separate `*-tarobot-v` channel. Legacy
`com.tarocub.client` installations keep their old channel and require a one-time
installer transition; never replace old release assets with new-ID packages.
See [the transition checklist](../release-checklist.md).

Android 1.0.89 adds **Settings → Appearance → App updates**. Install this first
updater-enabled APK once through the existing route. Later versions can be
checked, downloaded and installed from the App. Android still owns installation
permission and the final confirmation. Updating preserves the application ID,
signer, pairings and local data; uninstalling is not part of this workflow.

The private repository requires an authorized GitHub account. Device-code login
uses the same public OAuth application as desktop. Its `repo` scope is GitHub's
OAuth private-repository scope; access remains bounded by that account's existing
repository permissions. The access token stays native, encrypted by
AndroidKeyStore through the existing credential wrapper. It is never returned
to the WebView, embedded in an APK, or forwarded to an asset CDN. Signing out
removes this updater's local credential and downloaded package, not host pairing.

## Download and installation contract

- The native client scans the three latest 100-release pages, selects the
  highest numeric `android-tarobot-vX.Y.Z` above the installed version, and ignores
  draft, prerelease, legacy-ID, Mac and Windows releases.
- Prefer exactly one uploaded `TaroBird_X.Y.Z_android.apk`; accept the historical
  `TaroBot-X.Y.Z-android.apk` only when the canonical asset is absent. A malformed
  canonical asset must not fall back to an older name. The selected asset must have a numeric asset ID,
  bounded size (256 MiB maximum), an exact repository asset URL and GitHub's
  SHA-256 digest. Invalid newest metadata fails rather than silently selecting
  another release. Publication must verify that GitHub supplies the digest.
- HTTPS uses the system trust store. Redirects are followed manually only to
  GitHub's allowlisted asset hosts, without the repository credential. JSON,
  download size, redirect count and timeouts are bounded. There are no model-
  or renderer-supplied download URLs.
- The native download must match the declared size/digest, installed package
  name, current signer set, offered version name and a strictly increasing
  version code. Android's package installer performs its own final checks.
  Signer rotation is not introduced here; releases retain the original signer.
- Verified bytes and private metadata survive leaving Settings and process
  recreation. Installation rechecks the bytes and identity before granting a
  read-only URI from a dedicated FileProvider. Cache eviction requires a fresh
  download; an old filename alone never proves that a package is available.
- Cancellation/network failure does not install or silently retry a download.
  Canceling the system installer retains a verified package for **Continue
  installation**. Denying unknown-source permission leaves the same retry path.
  A canceled login fences later authorization callbacks.
- Opening Android's installer is **pending**, not success. The installed package
  version is the authority after return/relaunch; no JavaScript callback alone
  can claim an installed update. A successful self-update normally terminates
  the old App process. Pairing and chat stores are never reset.

`AndroidUpdatePolicy.java` owns the pure release/package policy;
`AndroidUpdateService.java` owns OAuth, transport, cache and native verification;
`AndroidUpdaterPlugin.java` owns permission/installer activities. The Android
controller and settings section reuse the existing GitHub device-login UI
controller, while keeping the phone install state separate from desktop's host
drain/restart flow. Mac/Windows updater behavior is unchanged.

## Build and release

Set `TAROBOT_GITHUB_REPOSITORY` and `TAROBOT_GITHUB_CLIENT_ID` (public values only)
when building Android. Release builds fail if these are missing. Debug builds
may omit them and display updates as unconfigured. Keep increasing `versionCode`
and sign every published APK with the original release key. Do not put a GitHub
PAT, OAuth access token, client secret or signing private key in BuildConfig.

Publish the signed APK and checksums under `android-tarobot-vX.Y.Z`; confirm the asset
name, size and server digest, then download it again and compare bytes. The
initial 1.0.89 installation cannot update older Apps that lack this code.

This is native phone presentation/distribution, not a new Hub capability; no
headless host CLI command is needed. Shared host changes still ship in the
matching CLI archive under the normal release gate.

## Verification

Policy tests cover version/channel selection, malformed or duplicate assets,
redirect boundaries, package name, signer sets and downgrade refusal. Controller
and phone-sized browser tests cover explicit confirmation, errors, installation
pending, canceled-install retry without re-download, and restoring Settings.
Existing desktop update/OAuth regressions run alongside these.

`AndroidUpdaterTest` is opt-in and refuses the production application ID. Build
with `-PtarobotApplicationId=com.tarocub.client.updatetest
-PtarobotUpdaterAcceptance=true`; that isolated build skips Firebase provisioning.
Its network interceptor supplies synthetic GitHub responses and a real signed
higher-version test APK. It verifies download bytes, credential-free redirects,
native package validation, restored cache, system installer cancellation and
tamper rejection. `updaterAction=install` performs a real emulator self-update;
process termination is expected, so read back the installed version and retained
marker externally instead of counting a crashed instrumentation run as a pass.

On 2026-10-17 the Android API 36 emulator passed the cancellation/recovery/tamper
journey, then installed the test App from 1.0.88 to 1.0.89 with its private-data
marker retained. This is Android emulator evidence, not a physical phone or
live GitHub OAuth acceptance. The actual release APK's signer, configuration,
embedded client and download integrity are checked separately at publication.

The source gate passed 4,310 tests (one existing Windows-only skip); client clean
installation, translations, types and build passed. Android's 38 JVM tests and
release lint passed. Update/OAuth/browser suites passed 22 cases each in Chromium
and WebKit; three existing mobile-settings journeys also passed in WebKit.
The real GitHub device-code endpoint accepted the configured public client ID;
no browser authorization was completed and no access token was created by that
endpoint check. Physical-phone installation and live OAuth remain unverified.
