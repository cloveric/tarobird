# Android foreground recovery investigation — 2026-10-29

The reported device is vivo Android over mobile data. Switching back into TaroBot
repeatedly shows a disconnection, with variable recovery time. Earlier reports
also included disconnections while foregrounded; that observation is retained.

This change repairs four reproduced client defects. It does not establish which
event closes every socket on this particular phone. No production service,
network setting, animation preference, pairing or installed App was changed.

## Reproduced defects and changes

### Idle HTTP connections delay route recovery on Android

The real Android `HubTls` / `HubTransport` implementation uses OkHttp with HTTP/1.1
and automatic retries disabled. Its pool retained idle connections for 60 seconds;
the bundled Node 24.14 Hub uses the default 5-second HTTP keep-alive timeout.
A GET could reuse a peer-closed connection and fail instead of opening a new one.

Opus 5.5 independently compiled the production Java sources and exercised them
against the isolated real Hub fixture. After warming three pooled connections,
a control GET after 1.5 seconds succeeded. After another 6.5 seconds, three GETs
failed with `Connection reset`; the fourth, using a fresh connection, succeeded.
With the pool idle lifetime reduced to 4 seconds, the first GET succeeded.

Each failure in that reproduction took only 1–2 ms. The additional recovery delay
comes from route selection: when the only reachable cellular route fails its
health probe, selection can wait for unreachable LAN/Tailscale candidates and
then back off. A route probe has a 6-second timeout. This is a code-path explanation,
not a measured per-stage timing from the vivo handset.

The pool now retires idle connections after 4 seconds, below the Hub's timeout.
Certificate pinning, hostname checks and request retry semantics are unchanged.
In particular, uncertain POSTs must not be replayed. A connection can still fail
for other reasons, such as a fresh network reset; the existing reconnect path
handles those failures.

### Suspended JavaScript could cause native socket cancellation

The Android bridge permits at most eight outstanding incoming events and 1 MiB
of outstanding payload per socket. Previously it cancelled the socket if no
JavaScript acknowledgement released credit within ten seconds, including time
spent suspended in the background.

Opus reproduced this using the actual Java core: after eight unacknowledged
messages, the isolated JVM was stopped for eleven seconds and resumed. An immediate
acknowledgement was rejected and the healthy socket closed with code 1006. The
two-second, non-frozen control delivered the ninth message successfully. This
models process suspension; it does not identify the phone's OS policy.

The reader now waits for credit without that ten-second cancellation. The event
count, byte bound, socket quota and overall slot lifetime remain intact. It holds
one bounded message while blocked, applies TCP backpressure, and releases its
monitor while waiting. Acknowledgement, close, explicit cancellation and document
retirement wake the waiter. The production socket slot still has its existing
twenty-minute absolute lifetime; this change does not create an unbounded lease.

### Foreground wake could skip already received frames

When native close arrived before a foreground wake, close began draining received
frames. The wake could immediately replace the socket generation while a cache
write was pending, so later received frames were skipped. A deterministic test
observed only the first of two received events being applied.

Foreground/manual retries now record their intent while the receive chain drains.
The completion is scoped to that socket and resets retry backoff when a wake is
waiting. Closing the connection during the drain cannot reopen it. This preserves
receipt and event ordering; uncommitted events previously replayed on reconnect,
so this finding is not evidence of permanent message loss or the cause of slow
recovery by itself. Cache or signing work can still delay an ordered drain.

### Queued old pongs could extend a dead socket's grace

Socket receipt already records liveness before the cache queue. Processing a
queued pong recorded it again, making an old reply appear fresh after a slow
cache write. A baseline test held an event write, queued an old pong, resumed,
then released the write: the stale connection remained alive too long. Removing
the second timestamp makes the test pass. A genuinely new pong still preserves
the connection. The 3-second heartbeat and 15-second steady-state threshold are
unchanged.

## Field evidence and limits

- The Mac Host stayed running during the observed incident. A bounded
  Mac → public relay → Mac health sample succeeded 20/20 times (154–220 ms).
  This is not a test of the vivo cellular path or its long-lived WebSocket.
- Between 08:30 and 09:49 the bounded audit sample showed 32 vivo authentications,
  compared with six each for iPhone and Mac. Authentication counts prove repeated
  connections, not their cause.
- A header-only relay capture showed five client-direction resets in about 1 ms,
  roughly ten seconds after a vivo authentication. Device attribution is timing
  correlation; reset direction cannot distinguish App, OS or intermediary.
- [Android's cached-app freezer documentation](https://source.android.com/docs/core/perf/cached-apps-freezer)
  describes TCP termination when cached processes freeze. That is consistent with
  the observation, but the handset's freezer/process logs were not available.
- Animation code did not call the transport or restart connections. A dedicated
  browser check with motion enabled, navigation and incoming messages retained the
  connection and draft. This does not measure indirect WebView load on the phone.

The 15–18 second silent-socket detection window, planned session-renewal UX and
rare cancellation waits during route preparation remain separate improvements.
They were reviewed with Opus and are not silently described as fixed here.

## Validation

Tested against base `213d1a31eb32ab0d0e0d36f69c8db877d0d92e72`.
Installed 1.0.119 remains bound to `022868b5baea02bafbb90e8b061e68b79fcf8e3a`.
Browser and JVM results are explicitly distinct from Android APK/device acceptance.

| Verification | Result |
| --- | --- |
| Foreground recovery, startup and switchback unit suites | 53 passed, including five new cases |
| Independent sync, route updates and desktop foreground unit suites | 19 passed |
| Android Java core / real TLS audit | `ok=true`; 79 boolean checks passed |
| Opus independent Java idle-pool and whole-process pause reruns | Both passed on the final production source |
| Chromium handshake, host concurrency, mobile bridge and Android/iOS SDK contracts | Initial run: 43 passed, one fixture failure; corrected case: 3/3 passed |
| Corrected renewal fixture with unchanged base connection source | 1/1 passed |
| Client translation check, TypeScript and Vite build | Passed |
| Standalone Host build | Passed |

The new close/drain baseline applied only the first of two received events; the
patched path applies both before reconnecting. The old-pong baseline failed the
no-fresh-reply case, while the patched old/new reply cases both pass. An initial
test-harness timing error checked a zero-delay reconnect exactly at its timer
boundary; the corrected baseline and candidate use the next event-loop tick.

The browser failure was deterministic on both the candidate and unchanged base
(three failures each): the invitation fixture's own authentications inflated the
login count and consumed the shortened session expiry. The test now installs its
authentication interception after invitation setup, so it measures the actual
client's renewal and still asserts that the held HTTP response succeeds. All 44
distinct browser cases passed across the initial run and corrected-case reruns;
the initial failing result is retained rather than labelled a clean full run.

Reproduction entry points: `client/tests/connection-foreground-recovery.test.ts`,
`client/scripts/android-transport-audit.mjs`, and browser suites `handshake`,
`host-concurrency`, `mobile-network`, `android-transport`. The JVM audit compiles
the same production Java core against pinned dependencies with process-local
test trust; it does not install an APK or change system trust.

The native audit's pairing fixture was also updated to send the current invitation
and idempotency request ID. It previously failed at pairing before reaching the
transport checks; no production pairing rule was weakened.

CLI impact: none to headless commands, Host identity, protocol or session state.
The production changes are in App connection recovery and Android transport.
The standalone Host build is checked for repository compatibility, without
publishing or replacing the installed CLI.

## Delivery boundary

The source repair is intended for a separate PR from the existing pairing/UI PR
#95. Physical acceptance still requires an Android build and the user's actual
foreground/background round trip, including pending messages, drafts, connection
status and recovery timing. Source and isolated tests alone do not update the
phone or establish that its reported symptom is gone.

Opus's final source review approved the repair with no blocking findings. Two
existing limits remain: very high RTT can still race the server's idle close,
and an error callback or forced abandonment can retire a generation before its
receive queue drains. The new drain guard covers close followed by foreground
wake, not every abandonment path. Durable cursors, idempotent outbox IDs and
signed reconnect denials remain the recovery mechanisms for those paths.
