# iPhone foreground recovery

Returning from the background could briefly show a disconnected phone, then
recover without restarting the App. This symptom does not establish a failed
Host task or a bad relay. The supplied report has no device-side close reason;
the following reproduction establishes a code defect, not that report's exact
network history.

## Native receive credit

The iOS transport previously cancelled a socket after ten seconds without a
JavaScript delivery acknowledgement. A suspended WebView cannot acknowledge.
The native process can also resume with that cancellation already overdue,
before the WebView has a chance to return its credit.

`HubTransport.swift` now waits for receive credit without that separate timer,
as Android already does. The existing eight-event / 1 MiB credit limit, single
pending message, suspended URLSession task and twenty-minute socket lifetime
remain. Acknowledgement resumes delivery; local close, cancellation, document
retirement and destruction still release the slot. TLS pinning, authentication,
request limits and Host event replay are unchanged.

The Foundation regression stops its own test process for eleven seconds with
SIGSTOP/SIGCONT while a separate fixture Host remains running. On the old code,
the first resumed acknowledgement fails with `native_request_cancelled` after
`native_socket_receipt_timeout`. On the repaired code it succeeds, delivers the
ninth event in order and completes another round trip. Further checks cover a
31-second acknowledgement delay, byte bounds, cancellation, local/peer close
and document retirement. The fixture now uses the required owner-issued pairing
invitation; this corrects the old audit setup, without weakening production
pairing.

## Foreground detection and presentation

For iOS only, an apparently open, authenticated socket gets one five-second
foreground liveness probe. Any arriving traffic cancels it immediately, even
while earlier events are still being written to the cache. Repeated wake events
cannot extend it, and it does not interrupt a pending handshake. Socket,
generation and timer ownership prevent an old callback from closing a successor.
An unanswered probe replaces the socket without penalizing the route solely for
iOS suspension. This is a detection deadline, not a guarantee that authentication
and catch-up finish within five seconds.

Traffic buffered by the native bridge before suspension may arrive only after
the wake and therefore cancel this probe. A link that remains silently broken
after that buffered traffic still uses the ordinary fifteen-second heartbeat
window. Focus notifications also use the existing resume path; weak networks
that take more than five seconds to answer can incur an extra authenticated
reconnect, without a route penalty. System overlays and cellular wake-up latency
remain part of the physical-device checks, rather than a five-second guarantee.

An actual hidden transition cancels the earlier probe, allowing a fresh window
on the next foreground. This avoids premature replacement during rapid App
switching; repeated visible wake signals still cannot renew the deadline.
The probe does not run its replacement while the document is hidden. A timer
delivered more than three seconds late falls back to the existing heartbeat, so
a blocked or suspended JavaScript thread is not treated as a punctual failed
probe. The shared three-second heartbeat and fifteen-second silence threshold
remain unchanged for all platforms. Closed-socket receive queues still drain
before a foreground reconnect, preserving received receipts and signed denials.

The compact phone notice labels an actual retry as connecting and explains that
phone disconnection does not cancel tasks already submitted to the Host. Cached
reading, drafts, pending-send counts, trust errors and the expanded details remain
available. This shared phone wording is intentional; no phone geometry, Duo
layout, Android transport or desktop behavior changes.

## Verification boundary

Focused connection tests cover the failing iOS detection case, fresh versus
queued old traffic, duplicate wakes, hidden/visible changes, delayed timers,
owner closure, successor sockets and Android controls. Browser checks cover
native listener recovery, transport ordering/cancellation, trust failures and
the compact notice through a real disposable Host stop/restart.

Run `client/scripts/ios-transport-audit.mjs` for Apple Foundation/Security checks
and Capacitor-header typechecking on macOS. These are neither an iOS build nor
physical-device acceptance. Browser WebKit is also not the installed iPhone App.
Native transport acknowledgement releases delivery credit; it is distinct from
the durable application event cursor and the outbox's idempotency receipts.

The local connection suites passed 101 checks and Chromium passed all 89 related
browser checks. The integrated Foundation audit passed 76 checks, including the
real process suspension regression; Capacitor-header typechecking passed too.
WebKit passed 88; the real-Host notice journey was blocked before
pairing, including on a serial retry. A separate page without product code also
stalled when storing an Ed25519 `CryptoKey` in IndexedDB, while a plain native-key
reference control succeeded. This is not a passing WebKit notice receipt. The
installed iOS App uses a native key reference; its acceptance remains separate.

An installed iPhone still needs short/long background, Wi-Fi-to-cellular and
temporary-offline checks, including catch-up order and pending sends. iOS can
suspend background Apps; persistent background WebSockets are not promised.
See [Apple DTS on background WebSockets](https://developer.apple.com/forums/thread/716118).

Host/CLI APIs and execution ownership are unchanged, so no new CLI command is
needed. This source repair does not release or install an App.
