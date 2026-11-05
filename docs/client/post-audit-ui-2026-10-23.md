# Post-audit navigation and connection UI repairs, 2026-10-23

Baseline: `361fa7e`, App 1.0.104 / Host 0.1.451. This is source/native
verification for the follow-up release, not a publication or tailnet receipt.

## Confirmed repairs

- WebKit does not automatically focus a pointer-clicked button. The network's
  Add device action opened an invitation while the preceding connections button
  still had focus; closing the invitation returned to that wrong control. Focus
  the actual trigger before opening. The existing full desktop and phone
  settings journeys failed before and passed after the one-line repair.
- The read-only Host route panel had no saved three-way merge base. Its add-only
  capacity estimate treated an intentionally deleted Host route as a new route
  and warned about a false overflow. The panel now observes the synchronizer's
  actual merge result, separately for Host and network publications, instead of
  estimating from listener addresses. Successful route edits clear stale
  diagnostics and retry self-publication after the existing 30-second minimum.
  Identity, registration and route-configuration fences reject late results.
  Reproduction: four saved direct routes, a fifth route
  in the saved Host base and current Host publication, but deliberately absent
  locally. The real merge retains four routes without overflow; the old status
  estimate falsely flagged it. A real IndexedDB browser journey also covers a
  genuine capacity limit, freeing a slot, automatic adoption, and deliberately
  removing that route without another false warning. The final route suite
  passed 68 unit cases and 10 journeys each in WebKit and Chromium.

## Native Mac observation control

Opening the App in the automation tool's background mode produced absent panel
pixels and stale virtual-message positions. Removing retained animation fill did
not resolve it; disabling entrance animations made the background panels visible
but did not resolve the message overlap. The decisive control was normal launch
through Finder: the original, unmodified signed App 1.0.104 rendered settings and
message rows correctly in the foreground. The animation workaround and its
policy-only test were therefore withdrawn; this is not counted as a product fix.
The backend retained its PID and identical Host distribution through GUI-only
candidate swaps. The original App was restored pending the final release.

A real Hub browser harness independently exercised 45 history rows, a growing
streaming reply, a later question card, six side-panel cycles and window widths
1000–1440. Chromium and WebKit had no persistent row overlap; resize-observer
reconciliation produced only a short transient gap (up to about 56 ms). This
supported checking the native foreground state instead of changing virtual-list
measurement based on screenshots alone.

## Coverage and boundaries

The existing iPhone overlay-keyboard test also now moves focus to a second lower
field while the keyboard is already open, without a second keyboard-show event.
It passed before any viewport implementation change; no speculative viewport
fix was made. This is WebKit emulation, not physical iPhone keyboard acceptance.

The six-area WebKit review (phone panels, side conversations, backup settings,
model controls, device invites and Tailscale pairing) passed 58 cases during the
initial review. The subsequent settings/Tailscale/side run passed
31 cases and exposed the two focus failures above; both full journeys passed
again after repair. Final integrated gates are recorded with the release.

All changes here are client presentation or browser coverage. They add no Host
capability and need no new CLI command. Shared route validation, identity,
permissions and headless diagnostics are unchanged.

Tailscale issues [53](https://github.com/cloveric/tarobot/issues/53) and
[59](https://github.com/cloveric/tarobot/issues/59) distinguish automatic recovery
for already authorized devices from first-time authorization, and keep the
physical phone/cellular/P2P/DERP/multiple-host matrix open. The attached iPhone
and a native Mac panel are not evidence that those network scenarios passed.

A connected iPhone 15 Pro Max on iOS 27.0.1 was also exercised through Device
Hub: message home, open chat, show keyboard, type an unsent `test` draft, clear
it, then blur to dismiss the keyboard. The header remained in place and the
composer returned to the bottom safe area without the previously reported large
blank. Device metadata identified this as the pre-existing 1.0.100 build 12
development App. This is a physical-device observation of that installed build,
not final-release installation or tailnet acceptance. No test message was sent.

The final 1.0.105 (1) archive was subsequently installed on the same physical
iPhone using its provisioned ad-hoc distribution signature. Its installed
version was read back, and keyboard, attachment-menu and settings observations
were repeated. See the [release verification](../releases/1.0.105-verification.md)
for those results and their limits; the earlier 1.0.100 observation above is
retained as the chronological control.
