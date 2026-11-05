# Hub shutdown: stalled peers and completion ownership

An HTTP client that sent a partial request body could keep `HubServer.close()`
pending indefinitely. An HTTPS client that only opened TCP, without starting its
TLS handshake, reproduced the same problem even with `closeAllConnections()`.
Concurrent callers could also observe `close()` returning before the original
shutdown finished.

The Hub now shares one close promise, rejects new HTTP and WebSocket work once
shutdown begins, and tracks the TCP connections accepted by all listeners. After
stopping workers and cancelling downloads, it stops listening and disconnects the
remaining peers. Accepted HTTP handlers drain before SQLite closes, preserving
their final bookkeeping even if the client no longer receives the response.

Focused verification covers idle sockets, partial headers and bodies, incomplete
TLS handshakes, concurrent close callers, completion of an accepted pairing
operation, and rejection of new pairing work. The relevant transport suite also
retains its real 120 MiB restart/resume upload and revocation checks. No certificate
validation or request authorization rules were relaxed.

The lifecycle regression and related transport tests passed (59 tests). The full
pre-completion build and suite passed: 241 files, 3,842 tests passed and one skipped.
This does not prove every browser journey or native-device acceptance gate. The broader
browser run on the preceding `ff6db45` revision still reported failures, including
reading/streaming, recovery, upload selectors, and Linux WebKit recording. Those
need separate diagnosis; the shutdown fix is not assumed to explain them.
