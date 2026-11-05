# Connection continuity under local UI and Gateway load

## Reproduced defects and changes

The dashboard failure in [the full browser run](https://github.com/cloveric/tarobot/actions/runs/38118627000)
was an aborted HTTP request, not a missing navigation control. The connection
reopened while the large overview was being read. Two separate sources of
unnecessary load/loss were investigated without extending the assertions.

The heartbeat previously compared wall-clock time since the last received frame
every 350 ms. After a 1.4-second UI stall, its overdue callback could run before
already queued socket events and abandon a healthy connection, cancelling all
active HTTP reads. A controlled regression using the actual connection and a
held authenticated HTTP response failed in both Chromium and WebKit on
[2468b86](https://github.com/cloveric/tarobot/actions/runs/38120000052): the connection
became offline during the overdue tick.

Liveness now uses monotonic time. When more than two heartbeat ticks have been
missed, it sends a fresh probe before deciding that the link is lost. Ordinary
ticks retain their 1.1-second deadline. Retired socket callbacks cannot renew
the current connection's liveness. The new regression passes in both engines on
[d2feb34](https://github.com/cloveric/tarobot/actions/runs/38120139844), preserving
the held response and a single socket. WebKit passed all 32 focused cases;
Chromium still failed the large dashboard request, so this alone did not close
the dashboard failure.

The local Gateway reply carries approximately 5.44 MB for 5,000 jobs and their
50,000 history records. Profiling the actual authenticated HTTP/Gateway path
showed substantial time in the shared frame decoder's per-byte JavaScript
conversion. Node now uses its native Base64 decoder. Both readers still apply
the same envelope, alphabet, padding, decoded-length, UTF-8, sequence and final
SHA-256 validation. Native decoding must not inherit Buffer's permissive
acceptance of malformed padding; explicit regression cases compare it with the
browser reader on valid padded/unpadded Unicode and invalid inputs.

A six-read local A/B comparison alternated decoders in the same isolated
process while keeping all 5,000 jobs. JavaScript decoding gave total read times
of 630–700 ms; native decoding gave 453–498 ms. This is a local synthetic
measurement, not a VPS/mobile latency guarantee. The focused protocol, Hub,
Gateway recovery and dashboard suite passed 44 tests. Root build and regression
verification passed 241 files, 3,845 tests and one skipped test; the client
production build also passed.

## Verification limits

[The follow-up browser run](https://github.com/cloveric/tarobot/actions/runs/38120503976)
covers the dashboard, route failures, multiple VPS routes, snapshot recovery
and 5,000-line rendering. All **eight Chromium and seven WebKit cases passed**.
With 5,000 jobs, the visible task page rendered in 139/151 ms on Chromium
desktop/phone and 39/53 ms on WebKit. Concurrent phone stop reached the actual
Gateway abort controller in 122 ms (Chromium) and 152 ms (WebKit); maximum
Gateway loop gaps were 213/155 ms. The existing render, stop and loop-gap
budgets were not relaxed. Chromium's 5,000-line rendering measured input 32 ms,
frame P95 16.8 ms and longest task 68 ms, with complete ordered content checks.
A complete browser matrix, native-container load recovery and physical-device
testing remain separate acceptance gates.

The Markdown timeout fixture was also corrected: it had shortened the normal
Worker warm-up and healthy queued messages to 350 ms, even before the intended
fault. Only the deliberately held request now receives accelerated timing;
the five-second visible recovery assertions are unchanged.
