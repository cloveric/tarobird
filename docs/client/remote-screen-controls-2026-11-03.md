# Remote screen controls and stream quality — 2026-11-03

## Scope

The expanded viewer reserved separate rows for its title, controls and status,
plus permanent shortcut/text controls. Its fullscreen request swallowed failure
and offered no explicit exit state. This change uses a compact toolbar, moves
secondary actions (display choice, shortcuts and text submission) into More, and
makes the actual viewer element fullscreen without remounting its decoder/canvas.
Fullscreen controls float above the picture and hide after 2.4 seconds while
viewing; focus, an open tools panel, or stale/disconnected video keeps them visible.
Moving to the top or pressing the small reveal button shows them again.

In-App expansion and OS fullscreen are separate buttons. Escape exits fullscreen
without also closing a containing dialog; Ctrl+Alt+Shift+Escape releases remote
control; More → Send shortcut → Esc explicitly sends Esc to the remote target
without leaving local fullscreen. Enter/exit/hide/unmount releases control. Permission failures are visible
and retryable, and cleanup only exits fullscreen owned by this viewer.

## Quality and lifecycle

The viewer offers Smooth, Balanced (default), and Sharp. This is capture/encoder
quality, independent of Fit/100%/150%/200% display scaling. A quality change closes
the old session before opening a new one, using new tickets and a new generation.
It never carries a control lease across the change. Failed cleanup stays pending
for retry; late opens are retired before a replacement can claim a viewing slot.

Quality is negotiated with both Host and target App. Old Hosts receive no new
field. An old target explicitly refuses quality selection; the user can choose
to connect with default quality. The UI requires the accepted profile in the join
receipt, rather than labelling an unconfirmed stream as the requested quality.
No viewer permission is granted by these controls.

The profile is immutable inside a session. Smooth keeps a 1280-pixel long edge
and 1280 × 800 area; Balanced keeps the legacy 1920 / 1920 × 1080 area. Sharp
permits up to a 3072-pixel long edge / 3072 × 1920 area, requires H.264, and probes
level 5.1 decoding in both landscape and portrait before opening. It does not
silently fall back to VP8 or a lower quality. The status shows actual stream
resolution, which can be lower than the cap when the target display is smaller.

Both the main-process bridge and renderer check stream metadata and binary
headers against the accepted session profile. Broadening the shared schema does
not broaden a legacy/Balanced session. Old peers cannot negotiate a Sharp session.
The shared ACK, lease, freshness, control permission and generation rules remain.

Fit now grows as well as shrinks the canvas proportionally, using the actual
picture rectangle for input coordinates (no input over synthetic letterboxing).
100% retains the existing stream-pixel-to-CSS-pixel display scale. The fullscreen
top-edge reveal avoids a layout read on every pointer movement.

Review also caught a cleanup coupling: an unavailable old Host could block the
newly selected Host. Opening/retirement ledgers now belong to each connection;
cleanup from another Host cannot block or retire the current Host's sessions.
The ledgers are held in a connection-keyed WeakMap rather than a disposable
React memo cache. Switching Hosts clears remote-text drafts and open tool panels;
Disconnect and a stream ending on its own clear the legacy-quality fallback,
so an updated target can be negotiated again. Opening More with the mouse keeps
the canvas focused and the current control lease; editing local text or moving
keyboard focus away still releases control. Remote shortcuts do not need a new
control handshake just to open the menu.

## Capture efficiency and stability review

Opus 5.5 (`claude-opus-5-5`, confirmed in the execution log) reviewed the
capture/Host path and independently reviewed the UI; root reproduced findings
and reviewed the fixes. The final pass corrected these concrete problems:

- The old 16:10 Retina default size, 1820 × 1138, exceeded H.264 level 4.0's
  8192 macroblock frame limit. Profile-aware sizing now fits the level (1818 ×
  1136 for that display), preserving the legacy codec string. Encoder probes
  verify support; they do not prove which hardware backend was selected.
- A frame-credit limit alone did not bound bytes. The target now admits raw
  frames using a byte estimate and paces encoded packets by their **actual** size.
  Root's counterexample (three delayed 400 KiB outputs, 1,228,896 bytes at once)
  broke the first prediction-only implementation; the corrected FIFO passes.
  Its at-most-three packets retain their capture time and reference order.
  Reset, pause and stop retire the entire queue; an unsendable stale head ends
  the session instead of dropping a delta and corrupting later frames.
- Encoder output is matched to input timestamps; skipped inputs return credits.
  A generation cannot begin with a delta. Encoder-drop regressions use a double;
  the real encoder did not reproduce dropped input in the measured samples.
- Screen status/open/stop now have a 15-second bound instead of inheriting the
  general five-minute request timeout. There is no automatic retry of an
  uncertain open. A lost open receipt may leave an unattached Host session until
  the Host's 30-second connection deadline; the UI does not claim it was undone.
  A failed stop keeps its session for the next explicit retry and is not
  redundantly retried by the same failed opening attempt. The deadline runs
  inside HTTP cleanup: an unresponsive transport or response body cannot leave
  the connection permanently busy. Late answers cannot decrement the counter
  twice, reopen the viewer, or trigger another request; route cancellation is
  reported separately from a timeout.

The byte gate targets 425 B/ms with a 768 KiB local burst, below the Host's
500 B/ms and 1 MiB. Large legal packets wait for a full budget and no earlier
unacknowledged packet. This is a source-side budget, **not** a guarantee against
network-delayed packets arriving in a burst. Relay/high-RTT behavior remains a
real-network acceptance item; freshness and Host limits remain enforced.

Generated-frame measurements with the final gate used production capture core,
WebCodecs and simulated 10/200 ms ACKs. The final runs had no budget cut, all
encoded outputs were sent, and outbox wait p95 was ≤0.4 ms. Source generation was
CPU-limited in those runs (also with the old core), so these are not claims of
15 fps capture or physical-device end-to-end latency.

## CLI and compatibility

The headless CLI has no screen renderer. `tarobot screens status/enable/allow/
revoke/stop/configure` continue using the same Host policy. Presentation controls
need no parallel CLI command. The Host protocol adds a capability-gated optional
open-time quality; existing status/session payloads remain unchanged.

## Verification boundary

Source/browser checks, generated-frame Electron checks, and installed-App or
real remote-device acceptance are separate. This work does not publish a release,
replace the installed App, change system permissions, capture a real desktop or
send native remote input. Real-network bandwidth and physical-target latency
remain unmeasured by generated-frame checks.

## Verified UI and decoder evidence

- `client/e2e/remote-screen.spec.ts`: final complete run **32/32 passed**
  (`freeze-ui.log`), including quality replacement/confirmation/refusal, decoder
  availability and stream bounds, Host changes, fullscreen denial/retry, pending
  entry cancellation, modal Escape, hidden controls and preserved drafts.
  The last two regressions first failed on lost control when opening More and
  disabled quality after a legacy stream ended, then passed with the fixes.
  Earlier Fit/input coverage initially read an async port receipt too soon;
  it now polls the receipt and passed in the final complete run.
- `tests/client-image-viewer-native.test.ts`: 13 controller regressions passed.
  `tests/electron-screen-viewer-regression.test.ts`: 5 production-bridge tests
  with transport/port doubles passed, including the per-session quality bounds.
- `screen-controls.smoke.mjs`: real isolated Electron 45.1.0 under the production
  `secureSession`/`secureContents` policy received both HTML and native fullscreen
  enter/leave events; picture geometry (including actual picture fit), idle controls, original window bounds and
  draft editing after exit were verified (`native-controls-fit.noindex/verification.json`).
  Synthetic frames advanced during and after fullscreen; the fixture resumed
  viewing with the document visible. This does not establish a real desktop
  capture or native-input session across fullscreen.
- `screen-viewer.smoke.mjs`: production main/renderer viewer pipeline, real
  MessagePort/WebSocket/WebCodecs, generated pixels: Balanced 640 × 360 decoded
  41 frames from 42 source packets; Sharp 3072 × 1920 decoded 40 from 42. Both
  verified pixels/copy semantics, 2 canvas dimension changes and 3 state changes.
  The smoke terminates after reaching 40 decoded frames; remaining packets are
  not evidence of decoder loss. Main-heartbeat maxima include process startup
  and are not active-stream latency measurements.
- Opus's frozen backend checks: full Electron suite 366/366 (`freeze-electron-all.log`),
  Host/screen suites passed in the 94-test run (`freeze-root.log`, including the
  initial six timeout cases); after the resource fix, the expanded timeout suite
  passed 10/10 (`timeout-resource-green.log`). Quality-specific tests were 23/23;
  generated capture smoke decoded 34/34 in that run (`gate-capture-smoke.log`).
  Earlier 57/57 and 42/41 viewer samples are separate runs, not summed coverage.
- Root's independent output-budget probe passed delayed output, drain, stop,
  reset and a 900 KiB key (`probe-output-budget-green.log`); the preceding red
  probe overflowed the replayed Host bucket. Production tests include the same
  counterexample and seeded randomized output bursts. The fix is required by
  those tests, not inferred from average bitrate.
- Root's final wire/viewer/fullscreen focused check passed 21 tests
  (`root-final-viewer-unit.log`). The two final UI findings were re-reviewed
  read-only by Opus and the HTTP resource fix was independently inspected by root.
- Final Host build and production Electron main/capture bundles passed
  (`freeze-host-build.log`, `freeze-electron-bundle.log`). Final client build
  passed translation checks, TypeScript and Vite (`freeze-client-build.log`);
  existing large-chunk and mixed Capacitor Keyboard import warnings remain.
  These checks create no installer and replace no installed application.

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/remote-screen-controls-20261103`.
Electron's [fullscreen window events](https://www.electronjs.org/docs/latest/api/browser-window)
are corroborated by the native smoke rather than inferred from the HTML API call.
