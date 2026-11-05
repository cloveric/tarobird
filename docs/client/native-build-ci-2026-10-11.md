# Native build matrix — 2026-10-11

The first manual [client workflow run](https://github.com/cloveric/tarobot/actions/runs/38111428847)
used commit `413b686`. Source checks passed separately, but native packaging found
two prerequisites that the ordinary local workspace had masked:

- macOS, both Windows targets, and iOS failed during the client TypeScript build.
  The client included every protocol file, including the Node WebSocket helper,
  and imported Bot creation types from the Hub process manager. This dragged in
  the server database and other dependencies not installed by native jobs.
- Android's SDK setup requested the action's default `tools` package, which the
  SDK repository no longer provided. It failed before the application build.

The client now checks its source and transitively imported shared contracts.
The Bot creation schema and catalog types live in a shared protocol module, with
the same validation and a compatibility re-export from the Hub manager. Node-only
code remains covered by the root build. Android setup requests `platform-tools`
explicitly. The workflow can select `native`, `web`, or `all` so a native retry
does not duplicate an already running protocol/browser job.

## Local verification

An isolated archived checkout, with no root `node_modules`, reproduced the same
missing `ws`/`sqlite3` errors using only the client install on Node 24. Applying the
contract and configuration changes made its full client build pass. The root
TypeScript/relay build and seven focused Bot-management/desktop-lifecycle tests
also passed. No SDK checks, type checks, TLS rules, or runtime permissions were
disabled. Temporary logs remain in the local `tarobot-ci-20261011` directory.

The corrected [native run](https://github.com/cloveric/tarobot/actions/runs/38111701436)
at `7f6f979` compiled the iOS Simulator application for arm64 and x86_64 and passed
the real Swift share-inbox storage checks. The universal macOS job also passed.
Its downloaded DMG passed `hdiutil verify`, and a read-only mount confirmed an
`x86_64 arm64` executable. The application is unsigned, as this workflow promises;
it is not the ad-hoc signed local preview or a notarized release. DMG SHA-256:
`e448c90aad9a57d9cbf602bb5a48943a168bdce9a4224afbcd60ab2a99b3caeb`.
Both Windows jobs also passed and uploaded NSIS installers for x64 and ARM64.
This is native compilation/packaging evidence; neither installer has been run on
a Windows desktop. The ARM64 installer was downloaded and hashed locally:
`0cce1e490290cacc7b7a8089de447ee5f2a1eea328df65dc629aed9b470febb4`.
The downloaded x64 installer SHA-256 is
`af0390dde2aab6b59e01c690faea7cf07362b53e3a6b1ccbb3b3ccabc549f440`.
Android passed setup but reached an AAR requirement that its
OkHttp 5.5 Android dependency needs compile SDK 37.

Android's compile SDK is now 37, with AGP 9.1.1 and Gradle 9.3.1, the combination
documented in the [Android compatibility matrix](https://developer.android.com/build/releases/agp-9-1-0-release-notes).
The runtime target and minimum SDK are unchanged. Capacitor 8 plugins still apply
`kotlin-android` and the legacy DSL, so the documented
[Kotlin compatibility opt-out](https://developer.android.com/build/migrate-to-built-in-kotlin)
is used. Dependency metadata and lint checks remain enabled. The workflow now
also supports one-platform retries, so this Android fix need not restart the
ongoing desktop jobs. AGP 9 also rejected the legacy non-optimizing default
ProGuard rules file. It now references the supported optimizing default; release
minification remains disabled, as before.

The subsequent SDK build identified an actual Java bridge compile error: the
Capacitor JSON conversion throws a checked exception and was inside an unchecked
`Runnable`. Conversion now occurs before queueing, within the existing transport
emission error boundary. The UI epoch fence is retained. The existing production
Android transport JVM audit passed using the locally cached JDK; this audit does
not instantiate the Capacitor plugin. The final
[Android run](https://github.com/cloveric/tarobot/actions/runs/38112539202) at
`39b1526` passed `assembleDebug`, `testDebugUnitTest`, and `lintDebug` and uploaded
`android-development-apk`. The downloaded APK passed ZIP integrity checks and
contains the Android manifest, bytecode, and 309 web asset entries. Its SHA-256 is
`8831e1903204b54e16636be1fcb2f02efd71c9cbf657ea729c36c0afa047461b`.
The development APK still needs real-device
installation, permission, sharing, lifecycle, and provider acceptance. It is not
a release-signed package and no push provider credentials were supplied.

## Other regression boundaries

The first combined browser job exceeded its 20-minute limit. Its trace artifacts
also contain seven failed scenarios, including controls relocated by the desktop
simplification, an operations-page expectation, a collaboration restart check,
and temporary download cleanup. These require separate diagnosis and reruns; the
workflow is not recorded as a full browser pass. WebKit did not start.

The local full root suite first encountered internal-disk `ENOSPC`. Moving its
temporary directory to the external disk exposed two reproducible portability
issues: the installer harness's fake `mv` did not support cross-volume moves,
and missing example files under a configured nonstandard temp directory were
not recognized as placeholders. The harness now preserves modes when copying
across volumes, and placeholder detection includes the actual system temp root.
The focused installer and file-delivery checks passed. A Kimi startup wait also
timed out once under load and passed in isolation; its cause is not established.
The final required pre-completion hook passed with one worker and the external
temporary directory: **240 suites, 3,836 passed, one skipped**, plus the root
TypeScript/relay build. The earlier failures remain recorded above rather than
being counted as successful runs.

A successful package build is not physical-device, notification, signing, or
release acceptance.
