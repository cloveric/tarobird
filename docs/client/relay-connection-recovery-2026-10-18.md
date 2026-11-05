# Relay connection cleanup and cellular reliability

## Report and measured boundary

The reported symptom was intermittent poor connectivity from the phone while
using cellular data. A Mac-side probe of the same public relay completed 20 ICMP
probes without loss (11.5 ms average) and 12 verified HTTPS health requests without
failure (108–163 ms). The VPS had CPU, memory and disk headroom. These observations
do not measure the phone's cellular carrier path and do not establish that the
carrier path was healthy when the incident happened.

Host warnings aggregate control- and data-connection failures. Counting them is
not a count of control-tunnel disconnects. Similarly, cumulative TCP counters
since VPS boot are not a measurement of today's packet loss. There is no evidence
from these checks that buying more VPS CPU or memory would solve the report.

## Confirmed defect

`coupleSockets` preserved queued writes on a normal EOF, which is necessary to
avoid truncating encrypted downloads. However, when the destination of a pipe
closed, its source could remain paused. Its remaining readable EOF was then not
consumed, leaving a finished public connection in the relay's socket set and
connection quota until the ten-minute idle timeout.

In an isolated relay with a quota of 32, fresh, explicitly closed HTTPS requests
accumulated connections and request 32 failed with `ECONNRESET`. The first request
also reproduced the leak in the new regression: connection count was two instead
of the one persistent control connection. Live inspection found finished public
socket descriptors consistent with this mechanism. The observed live count was
below its configured quota; reaching the quota during the user's incident has
not been established.

On clean close, the helper resumes its peer's readable side so buffered EOF
can be consumed while queued writes finish normally. The follow-up explicitly
unpipes the closed destination first: otherwise its later `close` listener can
pause the peer again if readable EOF preceded an unfinished write and destruction.
Aborted/error closes still
destroy their peer. It does not increase connection quotas, disable limits,
weaken TLS validation or change message replay semantics. This follows Node's
[readable stream consumption semantics](https://nodejs.org/download/release/v24.20.0/docs/api/stream.html#readableresume).

## Validation

- Added an integration regression with a quota of eight and 24 fresh HTTPS
  requests; each must release capacity back to the control-connection baseline.
  It failed before the fix and passes afterward.
- The original 32-connection isolated reproduction completes 40 requests after
  the fix, returning to one control connection with no tunnel warnings.
- The first mixed-version fixture, using explicitly closed requests and the
  installed App's tunnel, completes 40 requests without residual sockets.
  **That fixture did not cover every close order.** Broader keep-alive/client-FIN
  reproduction with the actual installed tunnel leaves host counts at seven and
  then thirteen while the patched VPS stays at one. With both source components
  updated, both sides return to one. VPS deployment helps existing Apps but does
  not finish the host-side rollout.
- Five relay suites pass: 44 tests, including delayed encrypted download,
  aborted peers, mutual TLS, source attribution, multiple relays and updates.
- Capacity regressions now cover explicit request close, server idle close and
  client FIN, asserting socket cleanup on both relay and host. Two deterministic
  stream tests cover close after readable EOF but before writable finish, in both
  directions.
- Standalone TypeScript compilation, relay bundle and dependency-graph check pass.
- Final pre-complete gate passes: local history secret scanning, standalone
  build and 331 host suites; 4,416 tests pass and one platform-specific test is
  skipped.

## Independent review and remaining work

Opus 5.5 reviewed the transport and client routing independently; the collaborating
Bot was configured for `xhigh`. Its isolated keep-alive reproduction used seven
requests spaced 6.5 seconds apart. Before this fix, completed-connection counts
rose from two to eight; afterward, every sample returned to the one-control-socket
baseline. These were independent fixture results, not phone measurements.
The second review approved the deployed `resume()` change and confirmed the
unfinished-write ordering edge and the missing host-side deployment. The edge
fix and both-end regressions are in source; the live VPS currently runs the first
reviewed cleanup fix from commit `2b20577`.

The review also demonstrated two existing recovery limitations in isolated
fault injection: loss of the control connection destroys established data
streams on the host; a silent stale control connection on the VPS can delay a
replacement until its heartbeat deadline (roughly 46–61 seconds in the fixture).
Neither was correlated with the reported cellular incident. They are not changed
by this patch. A follow-up design must define authenticated control takeover,
duplicate-owner/replacement-rate protection, ownership of pending stream requests
and host-side preservation of already paired streams. A successful small
prototype is not sufficient to ship those different lifecycle semantics.

More precise, bounded control/data error telemetry and route-probe measurements
are useful follow-ups. Blindly increasing quotas, shortening heartbeats or
increasing retries would obscure the confirmed defect or amplify disconnects.

## Operation and CLI scope

The deployed relay bundle differs only in the socket-coupling helper. A narrow
relay update uses a separate release directory, verifies the bundle checksum and
syntax, preserves the existing Node/configuration/certificates, and atomically
switches the release link. Health failure must restore the previous release.
Only the relay service needs a brief restart; the shared VPS's other services and
the local Hub do not need restarting.

The production relay was updated on 2026-10-18 with its previous release retained
for rollback. Configuration, Node and certificate bytes were checked unchanged;
the process and control tunnel were healthy after the switch. Bundle SHA-256:
`39921ce530c5f7b209ce51096e965cfabf3eaf91465e8a1ec8e932f5c4f48cf1`.
Forty subsequent public HTTPS requests all succeeded and matched the prior Hub
public identity. Latency was 105–140 ms (median 123 ms), and all six relay samples
showed one connection and zero pending requests. This is a Mac-to-public-relay
verification, not a cellular phone acceptance result.
Three subsequent live keep-alive cycles also succeed with a stable connection
count. Socket inspection then reports three established TCP streams, consistent
with the relay's count rather than accumulating finished requests.

GitHub source and secret-scanning jobs for `2b20577` did not start: GitHub reports
an account payment/spending-limit restriction. Local tests and local history
secret scanning are separate evidence and do not turn those CI jobs green.

CLI impact: this is shared transport cleanup, with no new command or protocol.
CLI callers and Apps using the public relay benefit from the server deployment.
The shared helper is also bundled into the host-side tunnel; source/build
validation does not mean already-installed host/CLI binaries have been updated.
App/standalone CLI publication is a separate release gate. The installed Mac
host/CLI has **not** been replaced by this VPS-only operation; its matching
cleanup fix still requires a host/CLI release and runtime upgrade. Do not report
this as completed end-to-end deployment.

The phone's actual cellular reconnect and conversation round trip remain a
separate acceptance boundary. If symptoms continue after this fix, collect
time-correlated route/handshake/heartbeat outcomes before changing retry timing
or attributing the problem to the carrier or VPS bandwidth.
