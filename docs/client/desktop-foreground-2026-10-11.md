# Desktop foreground recovery — 2026-10-11

The desktop shell registered deep links but did not use its existing host-pool
resume callback when its native window became active. Mobile already had an
app-state listener. A user reopening the desktop window could therefore keep
waiting for an offline connection's scheduled retry.

`installNativeEvents` now registers the current Tauri window's `tauri://focus`
event through `ListenerScope`. It resumes every registered host. Existing
`HubConnection.resume()` preserves healthy sockets and HTTP requests and probes
liveness; disconnected hosts retry immediately. No permissions, pairing, TLS,
retry limits, or background policies are weakened. The single event registration
is independent of deep-link lookup, and late callbacks are fenced after disposal
or a rejected registration.

## Evidence

An isolated real loopback Hub recorded timestamps and frame types only (no keys,
tokens, signatures or message bodies). The ordinary native preview had the original
healthy preview host plus this diagnostic host. Tests used cached synthetic messages
and actual device pairing, WebView/IPC, Rust transport and system key storage.
No provider CLI or production service was used.

| Scenario | Hub restart to authenticated ready | Challenge to auth frame |
| --- | ---: | ---: |
| Visible window baseline | 6,273 ms | 9 ms |
| Minimized window | 6,497 ms | 15 ms |
| Concurrent root test suite | 2,697 ms | 15 ms |
| Window restoration sequence, updated build | 1,193 ms | 11 ms |

These are single local observations, not latency percentiles or a proof that
foreground activation caused the last timing: the scheduled reconnect can race
window restoration. They confirm that background recovery worked in these runs.
One cold start during the test suite separately spent about 4.3 seconds between
challenge and auth; these server timestamps alone cannot identify which native or
WebView step caused that delay.

Manual native checks also confirmed:

- A message queued during the first outage was acknowledged after restoration.
- Both registered hosts remained available, and a second message after window
  restoration appeared in authoritative Hub history.
- Minimizing and restoring an already healthy window produced no additional
  diagnostic-Hub socket and no close event. The existing connection was retained.
- After the second minimize/restore sequence, CUA could still read the window
  and the server saw a healthy connection, but activating the footer menu produced
  no visible change. The preview was restarted for cleanup. It is not established
  whether this was native window/input routing or app behavior; do not count that
  sequence as complete interactive foreground acceptance.
- A follow-up with only the original preview host completed two minimize/restore
  cycles. The footer menu responded after each cycle; after the second cycle,
  typing and clearing a temporary draft also worked. This did not reproduce the
  earlier input problem and does not establish its cause or resolution.
- Removing the diagnostic host reported zero drafts and zero queued items; the
  original preview host remained. The isolated Hub was stopped afterward.

Four new pure SDK-boundary unit cases passed: independent focus registration when
launch lookup fails, pending-registration deduplication and cleanup, retry with stale
callback fencing, and cancellation before import completion. These tests invoke the
real installer and listener scope with mocked native SDK boundaries, not OS events.

Client build and strict ad-hoc signature verification passed. The required root
pre-completion hook passed 239 suites / 3,832 tests with one skipped; the four new
unit cases were added after that run's test discovery and passed separately.
Browser lifecycle regression source was updated and syntax-checked; the automated
browser suite was not executed in this turn. Manual UI operations used CUA.

## Remaining boundary

The earlier native recovery roughly 136 seconds behind the browser was not reproduced
or explained. Keep the [earlier recovery limitation](offline-recipients-2026-10-11.md)
open; this foreground improvement is not evidence that its root cause is fixed.
Windows, macOS sleep/wake, physical mobile recovery, remote relay failover, sustained
load and latency budgets remain separate acceptance work.

Local-only redacted timing records and screenshots are in the temporary
`tarobot-reconnect-20261011` evidence directory. No pairing material is committed.
