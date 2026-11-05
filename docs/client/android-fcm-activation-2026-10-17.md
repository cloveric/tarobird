# Android 1.0.85 FCM activation

The existing notification implementation could not receive Google push because
the distributed APK lacked its Firebase application configuration and the local
Hub had no sender configuration. Android 1.0.85 now packages the existing
`tarobot-notifications` project's configuration for `com.tarocub.client`.
The original Android signer is retained; upgrade in place without uninstalling.

[APK, matching CLI and checksums](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.85)
are separate from the [Mac release](release-1.0.85-2026-10-17.md). Executable source
remains `de9f454768802e97ba67a40a6d1e51312c8bc8ab`; this checkpoint changes test
navigation and documentation, not application behavior. Android versionCode is
**2026101703**, App **1.0.85**, matching host/CLI **0.1.433**, protocol **1**,
membership **2**, schema **17** with supported inputs **1–17**. The CLI archive
is byte-identical to the Mac 1.0.85 release's matching standalone package.

## Sender setup

The existing dedicated FCM sender account has the Firebase Cloud Messaging API
Admin role on this Firebase project. After the owner's explicit approval, one
JSON service-account key was generated and moved out of Downloads into the
host's private directory (directory 0700, file 0600). No IAM role was expanded.
The credential is absent from the APK and Git history; it is never sent to phones.

The packaged production sender obtained an OAuth access token with HTTP **200**.
The same provider then passed an FCM HTTP v1 **validate_only** request with HTTP
**200**. Validation used a synthetic topic and delivered no message. This proves
sender credentials and API authorization, not actual phone receipt.

Production activation is prepared as a one-time helper that waits for the active
Bot turn, uses the shared drain/guarded restart path, backs up the old config and
merges only `push.fcm.serviceAccountFile`. It checks that the restarted Hub retains
its identity/history and advertises FCM via the authenticated notifications API.
The subsequent activation receipt is separate from this pre-activation evidence.

After activation, a bounded one-time test waits for this conversation's existing,
unrevoked Android device to register and enable notifications. It respects mute
and quiet settings, rechecks authorization, waits 20 seconds to allow leaving the
App and submits one generic file notification. It neither retries a potentially
delivered message nor changes notification preferences. Its receipt distinguishes
FCM acceptance from phone display/click confirmation. This direct sender test is
not a substitute for an end-to-end task-completion outbox test.

Each other host needs its own authorized sender configuration. Updating only the
phone cannot configure Windows or another offline computer.

## Verification

The sanitized [receipt](evidence/android-fcm-1.0.85-2026-10-17.json) records exact
artifact size/hash, signer and verification boundaries.

- Client translation, TypeScript and Vite build passed.
- Android Release compilation, original signing certificate, non-debuggable
  manifest, 16 KB alignment and compiled Firebase resources passed.
- Android JVM: **30 passed**; release lint: **0 errors, 22 existing warnings**.
- Hub push and token rotation: **35 passed**.
- Chromium notification settings, readiness and native bridge fixtures:
  **52 passed**. Initial run: 49 passed, 3 failed because older tests attempted
  controls inside the now-collapsed connection options. Those tests now expand
  that section through the UI; preference, cleanup, failure and ordering
  assertions and timeouts remain unchanged.
- The same executable revision already passed the Mac release's full source
  gate: **316 files, 4,174 passed, 1 Windows-only skipped**. This is reused source
  evidence, not a new full-gate run for a configuration-only Android build.
- APK delivered to the current App conversation with byte/hash receipt.
- Google OAuth and FCM validation succeeded; private sender credentials were
  checked absent from all APK archive entries.

No physical phone is connected over USB. Actual registration, background and
lock-screen receipt, per-notification click navigation and normal task-completion
delivery remain to be verified on the user's phone. Browser fixtures and Google
validation do not close those gates. No Windows or iOS release is implied.

## Phone activation

1. Install the provided APK over the existing App.
2. Wait for example-mac to reconnect after configuration activation.
3. Open Settings → Notifications, enable notifications and allow the Android prompt.
4. Leave the App or lock the phone. The one-time test sends a generic notification
   after registration, with a 20-second delay; tap it to verify the target conversation.

Official integration references: [FCM Android setup](https://firebase.google.com/docs/cloud-messaging/android/get-started)
and [HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api).
