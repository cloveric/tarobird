# Pi RPC efficiency and lifecycle verification

Scope: ordinary Pi Bots, shared by App and headless Host CLI. No changes to
other engines, dependencies, model/provider selection, permissions, session
ownership or the exclusion of Pi from Superagent roles. No release or installed
App update is part of this change.

## Behavior

- Assemble fragmented JSONL records once instead of repeatedly scanning and
  copying a growing transcript. Keep the 256 MiB limit, measured in UTF-8 bytes,
  including Unicode and unterminated records at EOF. Complete small events keep
  a fast path.
- Drop an RPC request cancelled or timed out while waiting to write to stdin.
  A request already written can still take effect; cancellation is not rollback
  and never triggers an automatic retry.
- Do not start Pi for an already-aborted startup request. Recheck message
  cancellation after workspace/shared-startup waits so no prompt starts late.
  Preserve a ready worker for other callers.
- Retiring the adapter interrupts unfinished model and native-command turns.
  Do not return partial output or `/session` failure text as successful results.
  Do not publish a process that exited during final startup registration.

Session-store caching was considered but left unchanged: this patch does not
trade correctness or freshness for a speculative speedup.

## Verification

On macOS with Node 24.22.3, 22 Pi, Host CLI, Hub and gateway test files passed:
849 tests. New tests first demonstrated queued writes after cancellation,
UTF-8 limit errors, lost startup cancellation, dead-worker publication and false
success on adapter destruction. Tests also preserve completed replies with an
unconfirmed-queue warning, native session transitions and shared-worker reuse.

Host and client builds and the production TypeScript check passed. The broader
test-inclusive TypeScript check still reports the same 181 baseline diagnostics,
with no new diagnostics after normalizing source line numbers. It is not a
passing full-project type check.

Real isolated Pi 1.5.2 and 1.6.0 processes passed exact 8 MiB Unicode history
reads, queued cancellation/timeout without the abandoned mutation, subsequent
reads and process exit. Loopback provider fixtures reproduced and verified
warm-start cancellation and interrupted streaming. Native `/session` destruction
was also reproduced and verified. These probes use synthetic data, not live
commercial-provider credentials or an installed App.

Windows verification used the existing isolated test tree with all six changed
TypeScript source/test files checked by SHA-256 before and after testing. The
three RPC test files passed 330 tests; one POSIX-only bare-command lookup test
was skipped. Real Pi 1.5.2 and 1.6.0 each passed six RPC checks and four loopback
lifecycle checks: warm/shared-startup cancellation with no provider request,
interrupted streaming and interrupted `/session` without a successful result,
and process exit. This was an isolated source/process check, not an installed
Windows package or full-checkout attestation.

Decoder-only benchmark: three trials per payload, 64 KiB chunks, same Node and
machine. Median times were:

| Payload | Before | After |
| --- | ---: | ---: |
| 8 MiB | 71.68 ms | 3.52 ms |
| 16 MiB | 266.51 ms | 8.92 ms |
| 32 MiB | 992.01 ms | 13.44 ms |

These are synthetic decoding measurements, not model latency, App startup time
or an end-to-end speed guarantee. Alternating small-event measurements showed
no observed regression. Seeded byte/string fragmentation checks include Chinese,
emoji, split surrogate pairs, CRLF and EOF.
An independent review also compared the two decoders across 60,000 seeded
byte/string fragmentation and ASCII-limit cases, with no unexpected differences.
The UTF-8 limit intentionally rejects non-ASCII records whose byte size exceeds
256 MiB even when their UTF-16 length would have passed the previous check.

Installed-App, physical mobile-device and real-provider acceptance remain
separate from this source and isolated-process verification.
