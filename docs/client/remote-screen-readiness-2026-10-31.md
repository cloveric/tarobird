# Remote screen readiness and macOS permissions — 2026-10-31

## Scope and installation boundary

This change repairs the desktop target service, selected-Host viewer entry points
and explicit macOS permission requests. Work was coordinated with Claude Opus 5.5.
It does not change the screen policy protocol, grant devices, release an App,
replace `/Applications/TaroBot.app`, or restart the production Host.

The inspected installation is App **1.0.122**, Host/CLI **0.1.467**, source
`2aee119c15deec1917113ccff16db048a4d6bb65`, on macOS **26.6.2 (25G83)**.
The App, native addon and core are signed by the same Developer ID team,
`7TP234YKWW`; the App bundle ID is `com.tarobot.client`.
`codesign --verify --deep --strict` passed. Installed `app.asar`, addon, native
core and bundled Host package metadata hashes match the signed release backup.
This rules out a mixed installed bundle as the cause observed here.

The worktree started at `c2933bff3902160efeec6155cad0c526a82258c2`.
Local detailed evidence is retained under
`/Volumes/gdrive/taro-tmp.noindex/remote-screen-readiness-20261031/`.

## Reproduction and root causes

1. **Host online, but `desktop=null`.** Both CLI status and the GUI showed the
   screen service absent while the Host and relay were online and the feature
   was enabled. Electron passed the App state parent to `screenServiceTicket`,
   which expected the actual Host directory. It looked for
   `com.tarobot.client/hub-control.sock`; the actual installed Host uses the
   retained `com.tarocub.client/host/hub-control.sock`. Even a clean installation
   requires the missing `/host` component. The faulty source call returned
   `screen_host_unavailable` in about 2 ms. A read-only status request to the
   canonical socket confirmed a running Host supporting screen service tickets.
   No production registration ticket was issued by that probe.
2. **Silent and unrecoverable startup/registration failures.** The initial
   `start()` rejection was discarded after marking the service started. Several
   later WebSocket/description errors could end the retry chain or discard the
   rejection reason. This is a separate confirmed code defect: the observed
   installation had already created `screen-desktop.json`, so its immediate
   problem was the wrong socket path, not initial state-file creation.
3. **Missing viewer entry.** Settings only rendered the view button for an
   already-authorized device and only when its caller supplied a callback.
   Preferences, network host details, ADHD tools and board connection settings
   did not supply that callback. The normal chat entry did. A browser baseline
   reproduced both missing-button paths before modification.
4. **Recording request never reached.** The previous capture permission code
   requested access only for `not-determined`. Electron's macOS screen status
   implementation delegates to Chromium's CG preflight check and returns
   `granted`/`denied`, so that first-request branch was unreachable. Existing
   native `CGRequestScreenCaptureAccess` support was present; no Rust permission
   bypass or new event tap is needed.
5. **Already-granted buttons appeared broken.** Recording and Accessibility
   actions returned immediately when granted, although their labels said
   “Settings”. Errors opening a settings pane also lacked usable feedback.

The CLI's device permission is **not** the GUI's permission. Production policy
had no viewer grants. New UI status comes from the selected `HubConnection`
using its own GUI device identity; local native queries require a matching Host
public key from `desktop_host`, not merely a loopback URL.

## Implementation

- `desktopScreenTicket` resolves fresh, migrated and isolated App layouts using
  the native core's directory rules; conflicting or redirected directories fail
  closed. The lower-level `screenServiceTicket` still accepts a Host directory.
- Target service status exposes registration phase, bounded error and next
  retry time, plus separately preflighted OS permissions. Initial startup can
  retry; ticket/WebSocket/registration failures retain diagnostic codes and
  bounded reconnect backoff. Startup/retry share one initialization promise,
  so a concurrent retry cannot issue a ticket before the desktop ID is known.
  Starting an update while a ticket/connection is pending prevents a late
  registration; cancellation can later resume the normal retry path.
  Explicit retry does not request permissions,
  capture a display or modify any screen grant.
- All desktop ConnectionPanel callers keep a visible “View screen” entry with
  the applicable disabled reason. Existing chat opens its pane; other callers
  use a shared viewer inside the same dialog, bound to its selected connection.
  No meaningless “expand into chat” button is shown in that standalone viewer.
  Unsaved route edits and ongoing operations prevent opening it.
- The viewer refreshes displays after service recovery while disconnected and
  rechecks the selected Host's policy/permissions when connecting. Returning to
  settings or switching Hosts does not carry over grants or native operations.
- Each permission button requests only its own ungranted OS permission and
  opens that exact settings pane. An opened pane is a receipt, not a grant.
  Settings refreshes actual Host/native state on return/focus and periodically
  while visible. Permission-help text follows the latest preflight rather than
  the click-time snapshot; a failed later action clears the earlier receipt.
  Local service retry remains available even if the Host status read fails,
  and is disabled while an attempt or installation is in progress.
  The desktop-only section does not poll Host/native status in
  mobile or web renderers. Request/open failures have separate actionable diagnostics.
- View needs Screen Recording. Remote control additionally needs the device's
  `control` grant, Accessibility and a healthy Input Monitoring/takeover path.
  The global switch, pairing, OS grants and per-device screen grants remain
  independent. Input Monitoring is not added to the strict desktop wire schema
  in this change, preserving compatibility with the installed Host.

## Actual native observations

The installed App's three buttons were clicked separately with CUA. No setting
was toggled, no TCC database read or edited, no reset performed, no app replaced.

| Button | Observed installed behavior | System Settings identity/status |
| --- | --- | --- |
| Screen Recording | Clicking made no visible navigation | TaroBot is present and on in Screen & System Audio Recording |
| Accessibility | Clicking made no visible navigation | TaroBot is present and on in Accessibility |
| Input Monitoring | Opens the correct Input Monitoring page | Empty list (“No items”), including on a later read-back |

An older `.TaroBot-before-1.0.118` backup also appeared in the recording and
Accessibility lists. It was not modified. The current installed bundle is
`/Applications/TaroBot.app`, identifier `com.tarobot.client`. The addon loads
inside Electron's main process; the Host Node process does not own these OS
permission requests. The no-navigation behavior is consistent with the granted preflight branch in
the installed source. We did not substitute a CLI/Node-process permission query
for the GUI process, or infer Input Monitoring access from opening its pane.

If a request leaves the list empty, the UI directs the user to the corresponding
Privacy & Security pane, click **+**, and choose **Applications → TaroBot.app**.
It explicitly excludes old backups/Node, and explains saving work and reopening
the App if macOS requests it. We do not start a monitoring tap simply to force a
list entry. Each permission must still be approved by the user.

## Verification

| Check | Result | Boundary |
| --- | --- | --- |
| Electron main/preload/service suite | 246/246 passed | `opus/electron-full-round3.log`; includes startup/retry race, denied permission retries, request/open errors, registration failures, update races and existing capture lifecycle |
| Root screen suites | 58/58 passed across 5 files | Real Hub/control socket/WebSocket with fake native/capture adapters; `opus/root-round3.log` |
| Chromium UI | 43 distinct cases passed | 14 settings + 13 screen viewer + 16 connection/relay; final settings rerun after review |
| WebKit UI | 14/14 settings cases passed | Same entry, permission, recovery, host isolation and no-mobile-poll cases |
| Client build | Passed | Translation checks, TypeScript and production Vite build; existing size/Capacitor import warnings remain |
| Host standalone build | Passed | 478-module graph; no legacy transport/Feishu SDK |
| Production main bundling | Passed | Opus rebuilt the main bundle with production options, without creating/installing an App |
| Installed signature/hash read-back | Passed | Existing 1.0.122 matches its release, not the new repair |

The final Opus five-file SHA-256 manifest was independently verified (5/5).
The independent review also exposed the startup/retry race; its red test and the
two update-registration races became green after correction. Root UI review
suggestions were incorporated: clear old permission receipts, follow live
permission state, and keep local retry available when Host reads fail.

The final loopback experiment (`opus/integrated-registration-round3.json`) used
an isolated legacy directory layout: `desktop:null` before start, registration in
23 ms, automatic re-registration 475 ms after Host restart, and explicit retry
registration in 22 ms. These are single-run diagnostic timings, not performance
promises. Viewer grants remained empty and permission-request count stayed zero.

Earlier browser runs included a wrong Vite working directory, an in-progress JSX
edit and a hot-reload interruption. These were not counted as passes. After
freezing edits, the affected suites passed; no unresolved test failure is being
hidden by a retry. Browser/service fixtures use synthetic frames/native adapters;
they are not proof of real screen capture or native remote input.

## Remaining real-device acceptance

- The installed 1.0.122 was deliberately left unchanged, so repaired buttons and
  registration must still be checked in a subsequent authorized build/install.
- No production device currently has a viewer grant. We did not grant one as a
  side effect of fixing the entry. Actual remote picture updates, stopping real
  capture after close, and reconnecting remain unverified in this run.
- Input Monitoring has no TaroBot entry and a successful grant has not been
  verified on this Mac. No real remote keyboard/mouse
  events were sent; a dedicated, explicitly agreed test window is still required.
- Tests of rejection/retry and permissions are isolated regressions, not evidence
  that a new TCC grant has succeeded. Windows physical acceptance is outside this
  macOS target fix; its viewer uses the shared UI.

## CLI impact and official mechanisms

`tarobot screens` already uses the canonical Host and the same signed policy
operations. No new Host capability or CLI grant command is needed. CLI status
remains its own identity's view of that policy. This repair aligns desktop target
registration with the existing headless Host rather than creating a second Host.

- [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences):
  `getMediaAccessStatus`, asynchronous Accessibility trust prompt; Electron's
  `askForMediaAccess` is for microphone/camera, not a screen-recording request.
- [Electron 45.1.0 screen preflight implementation](https://github.com/electron/electron/blob/v45.1.0/shell/browser/api/electron_api_system_preferences_mac.mm#L616-L618),
  [Chromium 156 permission mapping](https://github.com/chromium/chromium/blob/156.0.8078.49/chrome/browser/permissions/system/system_media_capture_permissions_mac.mm#L132-L135)
  and [CG preflight wrapper](https://github.com/chromium/chromium/blob/156.0.8078.49/ui/base/cocoa/permissions_utils.mm#L105-L107)
  explain the missing `not-determined` branch for this version.
- [Apple CGRequestScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess())
  and [CGRequestListenEventAccess](https://developer.apple.com/documentation/coregraphics/cgrequestlisteneventaccess())
  are invoked by the existing native addon only from the relevant user action.
- [Apple Input Monitoring settings](https://support.apple.com/guide/mac-help/control-access-to-input-monitoring-on-mac-mchl4cedafb6/mac)
  and [Screen & System Audio Recording](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)
  document the OS-owned approval controls.
