# Remote Mac screen and manual control — issue #99

Status: source implementation and isolated integration verified; real remote
desktop acceptance remains pending. This document does
not establish signed-App, physical-device, public-network or Windows acceptance.
No release or installation is part of this change. Issue #99 remains open.

## Entry points and ownership

The target is the current macOS GUI login session. A paired device gets neither
screen viewing nor control automatically. The target Host stores an initially
disabled policy with explicit per-device `view` / `control` grants, bound to the
exact device public key. Only a local owner controller can change it, using the
shared signed `screen-grant` action and a persisted revision compare-and-swap.

In the desktop device/Host settings, enable Remote screen, grant the intended
paired computer access, and separately allow screen recording, Accessibility and Input Monitoring
on the target Mac. A remote viewer opens the right pane for that specific Host.
It starts in view mode; control requires an explicit action and confirmation of
a new keyframe. It does not switch targets when a chat or Bot selection changes.
Phones retain their existing chat/connection functionality; this issue does not
add phone remote-control UI.

`RemoteScreenPanel` uses the existing right-pane/expansion container. The canvas
owns remote input focus. Moving focus to local chat releases control. Escape
is forwarded to the remote Mac; Ctrl+Alt+Shift+Escape explicitly releases control.
App menu shortcuts are ignored only during focused, confirmed remote control;
release, hide and document retirement restore local menu handling. This does
not bypass operating-system shortcuts. Text is
submitted explicitly from a separate text field; no continuous clipboard sync
or input-text logging occurs. Windows defaults to Ctrl→Command, Win→Control,
Alt→Option, with an explicit physical-modifier option and a shortcut menu.
Display geometry includes stable identity, revision, scale and rotation;
normalized coordinate 1 maps to the final physical pixel, not a neighboring
screen. Changes retire the old session.

The headless CLI uses the same Host APIs, identity and authorization:

```sh
tarobot screens status --json
tarobot screens enable --yes
tarobot screens allow DEVICE_ID --permission view --yes
tarobot screens allow DEVICE_ID --permission control --yes
tarobot screens revoke DEVICE_ID --yes
tarobot screens stop SESSION_ID --yes
tarobot screens stop --yes
tarobot screens disable --yes
```

`configure` also accepts the shared versioned policy command (see CLI help).
Enabling the policy does not start a GUI or capture loop on a headless Host.
The status distinguishes Host availability, target desktop registration, capture
permission, control permission and active sessions.

## Selected transport and lifetime

Electron `desktopCapturer` binds a specific display to an isolated capture
renderer. WebCodecs supplies H.264 Annex B, with VP8 fallback. Dedicated binary
WebSocket media and bounded JSON control sockets reuse existing TLS identity
verification and RelayTunnel routing. RelayTunnel remains a TCP/TLS tunnel; it
is not TURN. The relay does not terminate the pinned Host TLS connection.
There is no video JSON/Base64, frame message persistence or Bot inference queue.

The target service belongs to the App lifetime, not the chat document. Its
registration requires a short one-use ticket obtained from the authenticated
private Host control socket; remote TLS clients arriving on loopback cannot
register a target. Each target-media socket has its own session-bound ticket.
A viewer and its MessagePorts belong to the initiating NativeOwner document.
Retiring that document aborts both viewer sockets and prevents late callbacks
from reaching its replacement.

The capture origin has no App bridge, Node access or general network access.
Only its main-selected source may satisfy a display-capture request. Screen
recording and Accessibility remain OS-controlled permissions of the distributed
App. Capture construction tests and test doubles do not prove either permission.
The raw mouse/key adapter uses CoreGraphics; `CGEventPost` and
`CGEventPostToPid` both constitute actual system input.

## Canonical protocol

`src/client-protocol/remote-screen.ts`, `screen-wire.ts` and the pure browser-safe
`screen-keys.ts` are the shared App/CLI/Host/target contract. Native commands are
`screen_service_status`, `screen_service_permission`, `screen_service_stop`,
`screen_viewer_open`, `screen_viewer_close`, `screen_viewer_visibility`.

- HTTP management: `/api/screens/status`, `/configure`, `/sessions`, `/stop`.
- Target sockets: `/screen/v1/target`, `/screen/v1/target-media`; private instance
  listener only. Viewer sockets: `/screen/v1/control`, `/screen/v1/media`.
- Media has a 32-byte little-endian header: version/flags/codec, frame sequence,
  geometry revision, stream generation, target capture Unix milliseconds,
  dimensions and payload length. Maximum packet size is 1 MiB.
- A stream configuration precedes its binary packets on the same socket.
  Reset/hidden transitions retire the entire encoder/decoder generation. Only
  a new keyframe starts the next generation. Encoded send failure terminates
  the session; it never drops a dependent delta then continues the old stream.
- Max two viewers, one controller. Encoding and delivery share a three-frame
  credit window, including submitted encodes whose output has not arrived.
  Hub media limits are 4 Mbps per source and 8 Mbps aggregate, with bounded
  keyframe bursts; control messages and queued control output are at most
  16 KiB. Congestion may discard raw frames before encoding.
- Decoder ACK follows decode, draw and animation-frame presentation. The target
  confirms it against an actually sent ledger and capture health; Hub arrival
  alone does not establish a usable fresh picture.
- Frames expire after two seconds. A control request resets the stream; only a
  confirmed post-reset keyframe can establish control. Lease duration is six
  seconds. Renewal challenges are one-use with fixed three-second validity and
  a fixed lease deadline derived when issued, never when a late reply arrives.
- Each input binds session, desktop, generation, display/revision, lease,
  sequence and confirmed frame deadline. An up may bypass picture/geometry
  freshness only for an input tracked as down in that same still-valid lease,
  with matching session/desktop and increasing sequence. The target uses its
  last validated pointer location for that release. Expiry/revocation still
  releases everything and never resurrects a lease.
- `lease-denied` binds the current service epoch, session and exact lease.
  Its bounded reason is one of `screen_frame_stale`, `screen_lease_invalid`,
  `screen_input_denied`, `screen_geometry_changed`, `screen_locked` and
  `screen_takeover_unavailable`. The target
  normalizes grant failures into these codes. It retains viewing and reports
  why control was refused; late denial cannot cancel a newer lease.
- Keyboard codes are the own properties of the shared Mac key table, including
  Numpad, F13–19 and international backslash. Button clicks are 1–3. Wheel deltas
  are W3C pixels; the UI converts line/page modes, and the target inverts the
  direction once for CoreGraphics. The viewer coalesces wheel bursts every
  34 ms and discards pending deltas on release or lease change.

The target starts its local-input monitor before announcing control. Missing
permission, monitor failure or interruption denies the lease; foreign local
input stops the screen session. Readiness polling is lease-bound and acts on
counts before checking `alive`, then checks health again after the crash-marker
write. The native implementation counts tagged/untagged events without recording
key codes or text. Its real tap and tag preservation remain unverified.

Hidden/minimized viewers retire the decoder and release input. Showing again
resumes only the requested visible pane, in view mode. It never restores a lease.
A valid install request stops screen resources before the updater replaces
files; target update-state checks must also reject new sessions during install.

## Verification and limits

The work uses focused protocol/authority/socket/CLI and native-boundary tests,
plus browser UI cases and an independent Electron process. Test totals below
refer to particular runs, not an additive count of distinct tests.

- Root authority/wire/viewer-window/copy regression: 39 passed across four
  files in `root-v7-tests.log`, including exact-lease rejection with
  `screen_takeover_unavailable`. Final combined protocol/authority/real Hub/
  transport/pinned TLS/viewer regression: **56 passed across seven files** in
  `integrated-final-tests.log`.
- Browser fixture: 13 passed in `browser13.log` for right-pane layout/draft
  preservation, explicit control, local typing, Chinese text submission,
  hide/resume, triple clicks, pixel wheel conversion, key repeat, IME isolation,
  Escape/exit chord, coalesced-wheel cancellation, late control/open callbacks
  and the unavailable-monitor explanation. Decoder and Host are test doubles.
- Actual Electron copy/decoder smoke `viewer-smoke/run5/verification.json`:
  40 synthetic frames decoded and pixel read-back verified, 40 source packets,
  268 main-heartbeat samples, maximum interval 250.2 ms. This run occurred
  alongside a development package build; it is a liveness regression, not a
  production latency benchmark. It exercises production `ScreenViewers` and
  `RemoteScreenViewer`, real WebCodecs, loopback WebSockets and MessagePort
  copying with an external watchdog. Its display-media denial probe denies
  the source; no real screen, TCC permission or native input is used.
- Viewer native-window/handshake and independent GG1 copy cases are included
  in the root regression. Early visibility/release commands wait in a queue
  bounded to eight commands / 16 KiB until authenticated control attachment.
  Native hide retires the decoder; an old open cannot restore a hidden pane.
- Opus final target freeze v9: 26/26 file hashes independently matched in
  `root-freeze-v9-readback.json` before a trailing-blank-line-only cleanup of
  the capture smoke harness. Production source bytes remain frozen.
  Full Electron regression log records
  **216 passed**; native addon log records **33 passed**, including ten screen
  construction/fake-runner cases. These do not activate an event tap or post
  system input. The final source includes monitor-readiness, late attachment,
  cancelled opening and cancelled-queue recovery fixes. A cancelled queued
  request retains its predecessor barrier, so later connections cannot overtake
  a still-running earlier source lookup. Active cancellation still releases
  the queue promptly; both paths have independent negative regressions.
- Independent negative regressions: five late-attachment/monitor cases passed;
  ready-wait and unresolved-source cancellation probes both start the next
  session before the old operation completes. The old window/port/timer is
  retired; late protocol lookup cannot remove the replacement handler.
- Complete development packaging rebuilt Host, core, addon, updater and
  migration exporter. The final package uses the v9 production source,
  an ad-hoc signature and a separate acceptance identity.
  `freeze-v9-packaged-smoke/verification.json` passed fresh onboarding, an isolated
  bundled Host and local pairing, close-to-hide/Dock restore, temporary Host/key
  cleanup and the old-installation migration guard, with no renderer exceptions.
  No screen permission, tap or native input was requested. This is not the
  production signing/TCC acceptance. The installed App was not changed.
- All temporary Apps and caches used physical `.noindex` paths. The post-build
  Spotlight query contains no Apps from this task; no artifact cleanup or
  production installation was performed.
- The production ESM bundle import regression passed. Introducing `ws` exposed
  an actual packaged-startup failure (`Dynamic require of "events"`), fixed by
  supplying a module-local `createRequire` banner in the main bundle. The
  test executes the bundle with the production build options without creating
  a screen service or posting input. The final development package startup check above also passes; production
  signing and real desktop acceptance remain separate.
- That smoke reproduced a real VP8 failure when decoder configuration forced
  the hardware preference on this Mac. The viewer now uses `no-preference`
  and probes the actual H.264 profile and maximum resolution. The subsequent
  smoke passed. This does not prove every Windows/macOS decoder combination.

Reproduce the last smoke with a physically `.noindex` Electron binary and an
explicit isolated output directory:

```sh
node client/electron/tests/screen-viewer.smoke.mjs \
  /absolute/lab.noindex/Electron.app/Contents/MacOS/Electron \
  /absolute/lab.noindex/viewer-smoke
```

Opus's final synthetic capture smoke is
`smoke.noindex/screen-capture-LUcTU2/result.json`: 44 frames/44 decoded, three
keyframe-led generations, capture-to-main age p95 201 ms and maximum main gap
2 ms. This exact run differs from earlier runs (including another 44-frame run); their metrics
are not substituted. The source is a synthetic renderer, not the Mac desktop.

Opus's separate encoder prototype uses synthetic desktop content on one Mac,
including the actual RelayServer/RelayTunnel plus bandwidth/delay proxies. Only
the final QP matrix has zero decoder errors; early VP8 experiments recorded one
error. The final static sample contains just 15 decoded frames, with p95 1505 ms
including the first keyframe. Hardware/VideoToolbox attribution is an inference,
not a measured API identity. A periodically redrawn sharing indicator does not
establish a real capture rate; static, hidden, fullscreen and multi-display
behavior still require actual capture verification.

Still required before declaring issue #99 complete:

- Owner-selected VM or agreed dedicated-window/time for real native input;
  then editing/saving a test file, drag/context-menu/scroll/shortcuts, local
  takeover, emergency stop and no lingering held input.
- Signed isolated App capture/TCC grant/denial/revocation/upgrade checks, real
  cursor, multiple/Retina/rotated displays, static capture, lock/sleep/logout,
  and a Mac mini with no capturable display.
- Two physical computers across networks; forced relay and direct routes,
  weak-network/loss/reconnect behavior and TLS isolation, plus phone chat and
  reconnection while screens are active.
- Whole-process CPU/RSS/idle teardown, repeated sessions, package size,
  actual video/input latency and concurrent chat p95 against the current
  Electron chat baseline.
- Actual Windows viewer execution (owner currently has no test environment).

These gates must not be replaced by unit counts, loopback timing, an App launch
request or a collaborator's approval. The installed App remains untouched.

## Stability follow-up

The subsequent [connection and efficiency audit](remote-screen-stability-2026-10-31.md)
records additional timeout/lifecycle fixes, measured viewer work reduction and
the remaining native acceptance boundaries. Its results are separate runs from
the implementation checkpoint above.
