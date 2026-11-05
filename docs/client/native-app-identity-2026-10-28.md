# Native TaroBot application identity

The owner explicitly selected **all platforms** on 2026-10-28. This change
replaces the application/package identifier with `com.tarobot.client` on
Android, iOS, macOS and Windows. It does not publish a release or replace any
installed application. Source base: `28915df20b8b4975aa4fd632f7135e43b1567a07`.

## Identities and compatibility

| Surface | New identity |
| --- | --- |
| Android application ID / namespace / Java packages | `com.tarobot.client` |
| iOS App | `com.tarobot.client` |
| iOS share extension | `com.tarobot.client.share` |
| iOS App Group | `group.com.tarobot.client` |
| Tauri macOS / Windows ID and Windows notification App ID | `com.tarobot.client` |
| Desktop device and update vault services | `com.tarobot.client.device`, `com.tarobot.client.github-updates` |
| Mobile native identity vault namespace | `com.tarobot.native-identity.v1` |

A new mobile package is a separate App and must pair again. No old device key,
remote-host binding or client installation marker is copied. The existing native
reinstall protections continue to apply. Desktop client preferences, remote
pairing, notification permission and private update authorization may need to be
set up again under the new identity.

The desktop Host is different from the client identity: its database, host key,
Bot workspaces and absolute paths must survive. A fresh default uses the new
application root. If only the former `com.tarocub.client/host` exists, desktop
startup, the macOS updater's Host pause and CLI resolution reuse it in place.
No data is moved, copied, merged or deleted. Both Host directories present,
symlinks/reparse points or malformed roots fail closed; explicit CLI directory
selection remains available for deliberate recovery. Audit App IDs retain their
isolated directories and never discover the real Host.

Windows admission also checks virtualized legacy package state before creating
a new Host. An explicitly requested Windows fresh start backs up both fixed
application roots after checking that neither Host/service is active; rollback
retains client installation keys, while a successful reset removes those keys
from recovery backups. It does not reset another computer.

Internal executable/package names, existing CLI service labels, saved shortcut
receipts and `tarocub://` links remain compatibility boundaries. Renaming them is
not required to change OS App IDs and must not break existing service ownership,
updaters, protocol links or stored routing/signature formats.

## External registration

On 2026-10-29, the existing Firebase project registered an additional Android App
for `com.tarobot.client`. The downloaded configuration contains both old and new
package registrations. The new APK build selects the new Firebase App ID. The
private config and its pre-change backup remain outside Git; the old app/project
and live Host push configuration were not removed or changed.

Apple accepted the new main/share bundle IDs, App Groups capabilities on both,
and Push Notifications on the main App. On 2026-10-29, after the owner completed
Developer sign-in, `group.com.tarobot.client` was registered and associated with
both new bundle IDs. The old group and bundle IDs remain intact.

Both new App Store distribution profiles were generated and read back as active.
Decoded profiles contain the exact new application identifiers and only
`group.com.tarobot.client`; both match the existing distribution certificate and
have `get-task-allow=false`. The main profile contains `aps-environment=production`.
Both expire on 2027-10-22. Profiles, API receipts and certificate details remain
outside Git. This establishes signing configuration, not a signed release,
physical-device sharing or push delivery.

The new App Store Connect record is created with the formal name **TaroBot**,
bundle ID and SKU `com.tarobot.client`, and primary locale `zh-Hans`. Apple
initially rejected the name because the old record owned it. With the owner's
explicit approval, the old record was renamed **TaroBot Legacy**; its bundle ID
was retained and its 16 historical builds remain readable. The new record then
accepted **TaroBot** without a temporary name. Both records were read back from
the API and the new identity was checked in the web UI. No old App or build was
deleted. New TestFlight upload and publication remain pending.

## Verification

Evidence is local under `/Volumes/gdrive/taro-tmp/native-identity-20261028`;
private credentials, API records, downloads, builds and screenshots are not
committed.

- Standalone Host build: 462 modules, no retired transport/Feishu SDK.
- Client translation validation, TypeScript and Vite production build: passed.
- Read-only check using the newly bundled Node on this Mac: the CLI selected the
  existing legacy Host, its identity bytes stayed unchanged, and no new Host
  directory was created. No production Host was restarted.
- Native macOS Rust suite: 83 passed, including Host path selection, conflicting
  and malformed roots, fresh-reset rollback, installation-key handling and the
  existing updater checks.
- Windows x64 Host launcher: cross-built and PE/subsystem checked. Windows x64
  desktop `cargo xwin check --locked`: passed. This is not a Windows installation,
  NSIS execution or notification-delivery receipt.
- Android debug APK and JVM tests: 44 passed; a second build with the new Firebase
  config passed. Android instrumentation-test APK compilation also passed;
  those device tests were not executed. APK manifest is `com.tarobot.client`; generated Google Services
  resources select the new Firebase App. APK SHA-256:
  `12a7279d6ff667fd48577e61f2819fddccb0cefbcc3df164a31eb81287c54c10`.
- iOS release-plan tests: 6 passed. Simulator Release build passed; final App and
  share-extension metadata read back the new IDs. Simulator ad-hoc signatures
  contain no App Group entitlement, so this does not establish App Group runtime,
  production APNs, distribution signing or physical iPhone behavior.
- Host path/admission suites: 46 passed, 1 Windows-only native probe skipped on
  macOS. A serialized combined run with desktop lifecycle tests reports 55
  passed, 2 failed, 1 skipped. Earlier concurrent builds caused test timeouts;
  the serialized run removed those timeout failures. The two remaining failures
  concern real LAN listener readiness, not identity assertions. Main-baseline
  comparison also reproduced both cases: unchanged main reports 8 passed and
  3 LAN-readiness failures (including the same two). The test, desktop lifecycle,
  network and service source files match main byte-for-byte. This establishes
  a pre-existing/environment-sensitive blocker, not its root cause; the LAN
  suite remains unresolved and is not reported as passing.

## Release gates

1. Use the new App Store Connect record and verified distribution profiles for
   the next signed iOS release. Registration, App Group association and profiles
   are complete, but no new TestFlight build has been uploaded. Apple does not
   allow changing the bundle ID of the previously uploaded App.
2. Keep old macOS and Android updater identity checks strict. The first cross-ID
   release requires a one-time installer transition; do not advertise the new
   package as a normal same-ID update accepted by the old installed updater.
   New-ID builds use separate `<platform>-tarobot-v*` channels and desktop
   manifests; leave legacy tags/assets untouched. See the release checklist.
3. Plan the APNs transition explicitly. The [incremental audit repair](../post-audit-updates-2026-10-29.md)
   adds [capability-gated per-subscription topics](apns-topic-routing-2026-10-29.md). On an existing Host, keep its
   old `push.apns.topic` default for old subscriptions and add the new native
   identifier to `push.apns.topics`. New clients must confirm that the Host
   advertises their installed native identifier before registering. Verify both
   old and new signed clients with the same deployed Host before release; the
   routing code alone is not a delivery receipt. Do not change the live topic
   during source/build verification.
4. Release the App and matching standalone Host/CLI from the same frozen commit
   with incremented versions. These debug/simulator artifacts retain the source
   version only for verification and are not release assets.
5. Verify a real existing-Host upgrade, mobile fresh pairing, notifications,
   sharing, private updates and Windows installation/uninstallation with final
   signed/distributed artifacts. Preserve a rollback copy and existing Host data.

References: [Android application IDs](https://developer.android.com/build/configure-app-module),
[Apple bundle ID rules](https://help.apple.com/xcode/mac/current/en.lproj/deve70ea917b.html),
[Apple App Group registration](https://developer.apple.com/help/account/identifiers/register-an-app-group),
[Apple app name availability](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/),
[Apple app name editing](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/).
