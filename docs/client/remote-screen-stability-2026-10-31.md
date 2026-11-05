# Remote screen stability and efficiency follow-up

Baseline: `43da47f8f1e9835ff7f1c6771093e2e279217748` (#99 source checkpoint).
The feature is implemented in source; actual remote-desktop acceptance is still
pending. This audit changes neither the installed App nor its permissions and
publishes no release. Root reviewed Hub/network/viewer behavior; Opus 5.5
independently investigated the target service and synthetic Electron capture.

## Confirmed connection failures

- A quiet/paused screen socket had no liveness check after authentication. A
  real loopback WebSocket peer that stopped responding remained OPEN after
  16 seconds; no session-close callback ran and no ping was sent. Frame credits
  bound video memory, but did not reclaim this dead connection's session slot.
  Both Hub and Electron viewer now use matched ping/pong probes: one probe per
  five seconds, ten seconds allowed for its response. A timeout terminates the
  channel and retires its screen session. Pong does not confirm a frame, renew
  a control lease, reconnect or replay input. Listener/timer cleanup is bounded.
- WebSocket upgrade success also lacked a viewer-side deadline for the actual
  `attached` receipt. A server that answered pings but never completed the App
  handshake left the viewer connecting. There is now a separate five-second
  post-upgrade attachment deadline. Timeout uses the existing actionable
  connection-error message; successful attachment/close clears the deadline.

The network tests exercise quiet healthy peers, mismatched pongs, ordinary
traffic without a pong, timeout on either endpoint, and grouped-channel cleanup.
An additional real-time test starts a real isolated Hub with authenticated
viewer channels, pauses the viewer and disables one channel's pong responses.
Both channels close in approximately 15 seconds, the session is removed and the
healthy target service remains registered. No capture or native input is used.

## Viewer efficiency

A real Electron process used the production viewer/main modules, WebCodecs,
loopback WebSockets and copied MessagePorts to present 40 synthetic frames.
The same test counted these operations before and after the change:

| Operation | Before | After |
| --- | ---: | ---: |
| Decoded frames / source packets | 40 / 40 | 40 / 40 |
| Canvas width/height assignments | 80 | 2 |
| UI state callbacks | 42 | 3 |
| Pixel read-back and buffer-copy check | passed | passed |

Only changed dimensions reset the canvas backing store. Only changed public
viewer state notifies React. Every frame receipt/draw/ACK and latest-picture
update is retained; native menu/input focus is checked even when public state
is unchanged. The smoke asserts the resize/update budget as well as decoded
pixels. This measures eliminated work, not an end-to-end latency improvement.
The final run's main-loop maximum gap was 223.3 ms; it is a liveness check, not
a production frame-latency benchmark.

## Target lifecycle fixes and cross-review

Opus reproduced and fixed the following target-side failures. Root independently
reproduced the cancellation/queue cases and the real Hub pause/resume contract.

- A source lookup or unfinished renderer opening could stay pending forever and
  block the next start. One active-start deadline now covers opening, source
  lookup and the page's start receipt. Cancelling removes the request immediately;
  an abandoned await cannot retain the request ID or later stop its replacement.
  Cancelling an unfinished opening retires that opening without cancelling the
  requests queued behind it. Existing active sessions and queue ordering remain
  protected. Root's two negative probes changed from timeout/duplicate and a
  blocked successor to successful retry and a fresh successor opening.
- Pause/reset commands arriving during startup were lost. The service now tracks
  the latest requested state separately from commands the capture page has
  received, then reconciles them after startup. Hide announces the next stream
  generation; show resumes that **same** generation. Cross-review caught and
  corrected an intermediate implementation which incorrectly rejected this
  resume. The real Hub test verifies hide/show followed by a new frame ACK,
  with no restored control lease; duplicate resume does not restart a reference
  chain.
- Each renderer reopening added another download-denial listener to the shared
  Electron session. In 25 real Electron synthetic capture cycles, the count
  after closing grew to 25 and emitted a listener-leak warning. It now returns
  to zero after every close, without removing anyone else's listener. Window
  and process counts stayed constant in that run; this is a 25-cycle sample,
  not a long-duration memory guarantee.
- Target registration and media attachment now have separate ten-second
  deadlines. Unanswered registration terminates and retries; unanswered media
  attachment ends the screen session without starting capture. Matching receipts
  and close clear the timers. The original 1.2-second probe alone was not proof
  of an indefinite wait; source inspection and deadline-based regression tests
  establish this missing bound.

The real Electron source-binding/cancel-order samples did not reproduce
cross-session source substitution. Target renderer CPU while paused was zero
in the small synthetic sample; this excludes other Electron/GPU processes.
Read-only geometry lookup was approximately 36 microseconds per input on the
sample two-display machine. Neither result justified adding caches or changing
input validation. Actual native input was not posted.

## Verification records

Evidence root: `/Volumes/gdrive/taro-tmp.noindex/remote-screen-audit-20261031`.

- `logs/half-open-before.json`, `logs/viewer-unattached-before.json`: negative
  connection probes on actual loopback transports (synthetic session authority
  for the first probe).
- `logs/network-final-tests.txt`: 18 focused tests across heartbeat, pinned TLS,
  viewer/window handshake, copy/credits and retirement files passed.
- `logs/real-time-heartbeat.txt`: five actual Hub/transport/CLI tests passed,
  including the real-time paused-channel timeout above. This replaces, rather
  than adds to, the earlier four-case transport run.
- `logs/hub-service-final.txt`: nine real Hub/target-service integration cases
  passed, including same-generation hide/show and new-frame confirmation.
- `logs/root-request-retention-green.txt` and `logs/root-real-resume-final.txt`:
  root's independent cancellation and resume probes passed (Electron/WS doubles).
- `logs/opus-test-electron-full.txt`: all 223 Electron unit cases passed after
  target changes. This includes, rather than adds to, focused target test counts.
- `logs/e2.json` / `logs/e2-after.json`: real Electron 25-cycle listener comparison.
- Opus's capture smoke `probes/screen-capture-Iy2cEh/result.json`: 41 synthetic
  frames / 41 decoded, three keyframe-led generations, maximum main gap 3 ms.
  This uses a synthetic WebFrameMain source, not a captured desktop. It is
  separate from the viewer's 40-frame run and the earlier implementation smoke.
- `logs/browser.txt`: all 13 browser UI cases passed after the viewer change,
  including control/blur, hide/resume, late callbacks, Escape, IME and wheel
  behavior. Decoder and Host in this UI fixture are doubles.
- `viewer-before/verification.json` and `viewer-final/verification.json`: the
  specific real Electron runs used in the table. Synthetic pixels only; the
  display-media permission-routing probe denies its source.
- `logs/package-import.txt`: production ESM bundle import passed. Client build
  (including client TypeScript/translations) and standalone Host build passed.
- The extra repository-wide `tsc --noEmit` is **not passing**: it reports 152
  diagnostics. An isolated unchanged baseline worktree reports the identical
  152 normalized diagnostics (`logs/typecheck-comparison.json`), with no added
  diagnostics from this change. These existing type-check issues are not fixed
  or represented as successful checks by this remote-screen audit.

## Low-bandwidth transport check

Opus identified a possible heartbeat false-positive when pongs queue behind
video. Root tested a real throttled TCP proxy at 128 and 256 kbit/s downstream,
with both endpoint heartbeats and three encoded-looking payloads sized 170 KB,
20 KB and 20 KB. All three packets arrived at both rates, no timeout occurred,
and both channels remained open through the 21-second observation
(`logs/slow-media.json`). This tests transport queueing only: the bytes are not
valid decoded video, the stream is not continuous, and the result does not
promise usable control or immunity from timeouts on every congested network.
Fresh-frame and lease safeguards are unchanged.

## Acceptance boundaries

This work has not exercised the user's desktop capture, native event tap,
CGEvent posting, TCC prompts, keyboard/mouse takeover on a real target, or a
physical off-network viewing/control round trip. The previously requested
owner-selected VM or dedicated native test window remains unanswered. Synthetic
Electron capture and transport tests do not substitute for that acceptance.
Windows physical acceptance also remains deferred. #99 must not be declared
fully accepted from this source-only follow-up.
