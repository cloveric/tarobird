# TaroBird naming, upload privacy and versioning

The owner selected TaroBird as the product name and requested merging the three
brand PRs: #112 (phoenix App icons/covers), #113 (line-style Mac tray bird), and
#114 (unused alternate icon). The alternate remains unused. The shared icon
manifest and brand documentation are regenerated/resolved together.

Current App labels, Chinese/English help, window/menu/notification copy, mobile
display names, share extension and READMEs use TaroBird. The same Host is also
available through the `tarobird` CLI alias. Persisted/native bridge identities,
existing QR filenames, bundle/disk/install identifiers and update URLs keep
compatibility. No new repository, production installation or release is made.

The product version becomes the unified **1.1.0 development** line, managed by
`release-version.json` and [the version policy](versioning.md), with native store
build counters kept separately. Existing published versions remain untouched.

The upload gate adds outgoing-commit metadata/intermediate-blob scans, personal
path/name/email/address detection, exact-byte media review records, safe local
hook setup, PR text scanning and version consistency to the existing full-history
Gitleaks/retired-ancestry checks. See [repository privacy](repository-privacy.md).
Historical residue from the private audit is still outstanding and is not made
safe by these controls. The private evidence and sensitive values stay outside Git.

Validation receipts are retained outside Git. Source/icon validation, focused
privacy/version negative regressions, host/client builds and browser/native
tests are distinct from installed-App or physical-device acceptance. The PRs'
GitHub jobs did not start because of the account billing/spending restriction;
that state must remain reported as not run, never passed.

Local verification: 84 generated icon files verified; 20 privacy/version tests;
11 Playwright brand/pairing/palette flows (Chinese/English, desktop/phone layouts);
64 Electron regressions; 15 old-path/startup compatibility tests; 8 Windows
installer contract tests; 33 native Electron notification/screen library tests;
45 Gateway service regressions plus App-context/environment and QR-save tests.
Host/client builds and full ordinary reachable-history Gitleaks passed. The
initial Gateway/native notification assertions still expected the old label;
their corrected expectations passed. Initial commands targeting the retired
Tauri shell required a packaged Host; final native verification used the actual
Electron native library. No installed-App, real Windows or physical-phone
acceptance is claimed by these local results.


## Rename follow-up audit

Audited the rename at `25fc484205060bede329730cdcddc8ccfcebf34e` before any
TaroBird release. Focused negative tests reproduced three missed contracts:

- The iOS App/share-extension validator still required the old display name,
  rejecting otherwise correct TaroBird bundles. It now requires TaroBird while
  still enforcing the original bundle IDs, platform, version and build counter.
- The Windows acceptance runner compared the visible uninstall label with the
  retained installation identifier. It now validates TaroBird separately and
  still tests old registry paths, shortcuts, deep links and upgrade cleanup.
- APNs alerts still displayed TaroBot. The visible title is now TaroBird; payload
  literals, subscription tokens and APNs topics retain compatibility.

App command help/status/config cards, notification fallback text, Google Docs
authorization pages, capability sources, new CLI controller labels and service
descriptions, Android share errors, and release titles/default notes also had
old display copy. These now use TaroBird. Existing user names are not rewritten.
Release tags, manifests, assets, package identity, OS task/shortcut names,
keychain entries, certificate identities and model/state markers are unchanged.
The CLI remains the same host; both command aliases and the unified 1.1.0
version survive an isolated upgrade from the old 0.1.475 package layout without
changing host identity, private-network data or Bot workspace bytes.

Verification: 55 focused command/card/controller/APNs/publication tests; 400
other host, service, package, notification, Google Docs and adapter regressions;
47 host-update cases; 15 iOS-plan/Windows-acceptance cases; 81 Electron
compatibility cases; and 8 Windows installer contract cases passed. The first
host-update run correctly rejected the Homebrew Node external-library runtime.
With the independent release Node, 46 cases passed; the new case's overly strict
result-object assertion was corrected and its targeted retake passed. This is
not a change to the runtime dependency guard. Host/client builds and built CLI
help commands passed. Android Java compilation passed after generating the
clean checkout's missing Capacitor files; its initial compile attempt and sync
retake are retained. Local test receipts retain the negative runs and retakes.

These are source, simulated-provider/installer and local-process checks. They do
not establish real APNs delivery, signed-package upgrades, Windows-machine or
physical-phone acceptance. No release, installation or repository migration is
performed by this audit. GitHub check status and the exact outgoing privacy
scan range are recorded separately in the private completion receipt.

## Visible-label follow-up audit

Reviewed the current shared App, native display metadata, notifications, Host
responses, CLI help and operating-system service descriptions after the homepage
updates. The welcome/pairing screens, sidebars, new-Bot page, settings and current
native display-name sources already use TaroBird. Additional visible omissions
were found in Bot service status, route-failure alerts, newly exported Google
document titles, Hub CLI help/errors, relay service descriptions, the Linux
Google Docs secret label and Android UnifiedPush registration descriptions.
These display strings now use TaroBird.

UnifiedPush's third registration argument is its
[distributor-facing description](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector/-unified-push/register.html),
not the registration identity. Registration IDs, wire payloads, keychain lookup
attributes, service names, stored paths, bridge names, package/install IDs,
update channels, CLI commands and user-owned Bot/conversation names are unchanged.
All ten changed source/test files differ only by product-name substitutions.
The retained legacy web console still contains historical copy, but its server
and generated HTML are absent from the current standalone build graph; it is
not the shipping App interface.

Verification: 187 focused Host/Google Docs/relay/service tests, 15 Android JVM
tests, 15 Chromium flows and 8 WebKit flows passed. Browser coverage includes
desktop/phone branding, Chinese/English pairing, settings-language persistence,
the new-Bot catalog and conversation-isolated Workbench routing. Host and client
builds, Android Java compilation and built Hub CLI help passed. The initial
Android run exposed three failing tests with four stale notification-body
expectations; only those expected display strings were corrected before the
successful retake. Explicit legacy caller-supplied fallback assertions remain.

These results cover source, browser fixtures and local compilation/tests, not
physical-phone notification delivery, a live relay deployment or installed-App
acceptance. The inspected local Mac installation remains 1.0.130 with its old
display name. No version bump, release or installation is performed by this
audit. Private screenshots and raw test logs are not uploaded.
