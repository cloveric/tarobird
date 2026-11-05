# App run-update latency

**Current policy (2026-10-15): prioritize response latency.** Native long and
short replies both use a 100 ms coalescing interval. The size-dependent
100–400 ms policy tested below was removed after the user clarified that lower
network traffic must not come at the cost of slower visible updates. Retry,
recovery, bounded pending work and full-answer preservation remain in place.
This follow-up changes shared desktop/headless host code, not installed Apps.

The native App inherited the legacy card update delay. Its native managed-card
handle also entered the Feishu element-stream path, which cannot update native
elements. A consecutive narration event therefore waited about 150 ms for the
unsupported path and another 400 ms for the full-card fallback.

Native handles now skip that path and coalesce full updates at 100 ms. The first
event remains immediate. Legacy cards retain their existing 400 ms full-card and
150 ms element-stream cadence. Slow delivery permits one active full patch and
one coalesced pending patch; the pending patch renders the latest state when it
starts. Terminal transitions discard pending live frames and remain serialized
after the active write. This prevents obsolete progress from delaying or
overwriting the final reply.

## Measurement

`scripts/benchmark-run-latency.mts` feeds public narration events into the actual
shared controller and records receipt at `channel.updateCard`, using the normal
platform context. Five independent runs per transport, measured with real timers:

| Transport | Before (ms) | After (ms) |
| --- | --- | --- |
| Native App | 550.3, 549.5, 550.3, 551.1, 550.7 | 100.6, 99.9, 100.4, 100.0, 100.5 |
| Legacy inline fallback | 400.7, 399.4, 399.4, 400.2, 400.6 | 400.1, 400.8, 400.4, 400.2, 399.8 |

This measures only controller scheduling/rendering to a local channel stub. It
does **not** measure model generation, real CLI events, Hub persistence, VPS RTT,
phone rendering or lock-screen delivery, and is not an overall speedup claim.
The shared path serves Codex, Claude, Antigravity, Kimi and DeepSeek after their
adapters produce events; no provider-specific generation latency was measured.

Each sample above starts a fresh controller and measures the second event. It
exercises the old unsupported-element path, not the average delay of every
token in a steady stream. The first event was already sent immediately. A
separate 40-event local callback test at 20 events/second measured median
294→100 ms and P95 453→103 ms; both versions delivered all 40 markers. Its
updates increased from 6 to 21, so lower scheduling delay has a load tradeoff.

## Verification and CLI impact

Four focused cadence/backpressure regressions cover legacy cadence, event bursts,
slow writes, final-frame ordering, late events and retaining the last delta with
no further engine event. Together with run presentation and gateway card state
tests: 30 passed. Final complete host suite: 271 files, 3,564 passed, one skipped.
The standalone build and client production build passed.

The same host core is bundled in App 1.0.69 and CLI 0.1.422. Headless hosts benefit
without a desktop window or new CLI command; no identity or network semantics
change. Package smoke verification now performs the native controller challenge
and signature required by the current host, rather than using its obsolete
unsigned enrollment fixture.

## Follow-up hardening (source, not a new installer release)

Fault injection reproduced missing automatic recovery after the last live
patch failed, and a duplicate snapshot after a slow receiver had caught up.
The native App path now:

- Retries a failed live snapshot without requiring another engine event. It
  makes at most three automatic retries, with increasing delays; incoming
  events also respect failure backoff (capped at two seconds). Success clears
  backoff. Brief failures do not permanently switch native runs to a compact
  legacy card. Ordinary socket disconnects still use the existing durable
  outbox and reconnect replay, rather than fabricating successful receipts.
- Tracks the revision captured before each write. A waiting patch already
  covered by the successful in-flight snapshot is skipped. Newer revisions
  still reach the receiver, including when no subsequent event arrives.
- Cancels retries on completion, failure, interruption and idle timeout. A
  write that fails after terminal delivery starts cannot rearm a live retry.
  Stop remains `stopping` until explicit confirmation. Retry deadlines use a
  monotonic clock so system clock corrections cannot freeze progress.
- Retries only the remaining backoff if a native timer fires fractionally
  early, instead of adding another coalescing window. Native finalization
  always attempts the full card, even after delivery previously fell back to
  compact; compact native cards also retain the complete answer text.
- Skips CardKit structure comparison for native updates. It retains the real
  150 ms managed-element and 400 ms inline/full-card legacy paths.
- Originally kept normal short-answer coalescing at 100 ms. Large visible cards coalesced
  at 100–400 ms, using 256 KiB/second as a sizing hint, not a guaranteed network
  bandwidth ceiling. The incrementally stored process journal is excluded
  from this size estimate. Phase changes can bring a timer forward, never
  postpone an already earlier deadline; final delivery bypasses coalescing.
  The size-dependent delay was removed on 2026-10-15; native replies now all
  use 100 ms regardless of card size, with failure backoff still respected.
- Rejects a new oversized request before writing it to the outbox when the
  connected Hub is known not to support fragmentation. The size check runs
  again inside the serialized write queue, so repeated retries cannot fill
  the journal with known-undeliverable copies. An already durable request
  captured while offline is retained for delivery after the Hub is upgraded;
  it remains pending and is never silently deleted or acknowledged.

The retry budget is deliberate: persistent errors do not produce an infinite
background retry loop. After automatic retries are exhausted, a new engine
event or terminal delivery can try again. These changes are in the shared
desktop/headless host; they require no new CLI command, protocol or schema.
Bot, device and network identity are unchanged. Existing installed versions
do not acquire these source changes automatically.

## Real local transport benchmark

This section records the 2026-10-14 size-dependent policy at `988f922`; its
traffic/latency tradeoff is historical and is not the current scheduling policy.

`scripts/benchmark-run-transport.mts` creates disposable Hub and Bot directories,
uses real SQLite, Gateway WebSockets and outbox persistence, pairs a signed
client, verifies the Hub signature, and applies the same message-delta reducer
as clients. It checks every marker and each terminal receipt, then removes its
own fixture. It does not touch a running host or invoke a provider CLI.

It covers a short answer, five concurrent Bots with 100 completed tool records
each, five concurrent 64 KiB answers, and a forced Gateway reconnect. Events
arrive at 20/second/Bot. Measurement ends at reconstructed client receipt,
before UI painting. Client bytes count WebSocket protocol payloads, excluding
TCP/TLS overhead. CPU includes the benchmark client and Hub in one process.

The comparison baseline is `728c55a` (already using the initial 100 ms fix).
This is separate from the earlier 550→100 ms controller-only comparison.
Single-run numbers are diagnostics, not a performance guarantee. The long
answer policy intentionally exchanges some incremental refresh latency for
lower traffic; it does not truncate the final answer.

| Local scenario | Received markers (before / after) | Median ms (before → after) | P95 ms (before → after) | Client payload bytes (before → after) |
| --- | --- | --- | --- | --- |
| Short answer, one Bot | 40 / 40 | 95.4 → 95.0 | 146.1 → 145.4 | 30,893 → 28,877 |
| 100 tool records each, five Bots | 200 / 200 | 191.2 → 200.5 | 259.3 → 282.3 | 446,946 → 429,409 |
| 64 KiB answer each, five Bots | 200 / 200 | 207.6 → 297.7 | 287.1 → 410.6 | 4,925,942 → 2,367,430 |
| Forced Gateway reconnect, one Bot | 40 / 40 | 113.8 → 91.6 | 281.5 → 234.3 | 29,480 → 29,357 |

All 480 markers and 12 final states arrived in each revision. The long-answer
case reduced protocol payload by about 52% and publications from 78 to 40, with
about 120 ms higher P95 incremental refresh latency. The historical-tool case
did not demonstrate a latency improvement; small differences between these
single runs must not be advertised as a speedup. See the [machine-readable
results](run-update-transport-benchmark-2026-10-14.json) for RPC, update and CPU
measurements.

Final local build and full suite: **272 files passed, 3,583 tests passed, one
skipped**. The native cadence
suite includes 21 cases; the old-Hub transport
suite adds two real WebSocket tests. Legacy managed-element regression uses
the transport port directly and needs no optional Feishu SDK. Provider adapter
tests are included in the full suite; they are not live provider benchmarks.

## Independent review and follow-up

Two completed reviews used the actual local Claude CLI with
`--model claude-opus-5-5 --effort xhigh`; both receipts identify
`claude-opus-5-5`. Tools were disabled for these reviews. Opus findings are
static review, and reproductions/builds/benchmarks below were run separately
by the implementing agent.

Confirmed and repaired findings:

- Old Hub capability checks could leave new undeliverable large requests in
  the outbox. The real WebSocket regression reproduced this and now verifies
  preflight rejection, a warning, a clean outbox and retained earlier durable
  output. We deliberately did not adopt deletion of existing pending output.
- `beginDelivery` could latch compact rendering after one transient failure,
  preventing `finish` from trying the full card. The regression now covers
  the restored process panel and the complete long answer in compact fallback.
- Early retry timer callbacks could add another 100–400 ms. A real Node timing
  probe observed one early callback in 30 samples; a controlled half-millisecond
  regression failed before the fix and now recovers within the remaining wait.

The revision ownership and terminal ordering concerns were checked against the
complete controller and failure tests. The suggested stale-version rejection
was not reproduced: Hub returns the current message for an older version, and
the channel remembers that response. The final fixes above were verified by
local regression; there was no third Opus review after those fixes.

Repeat with `npx tsx scripts/benchmark-run-transport.mts`. To compare a separate
source snapshot, set `TAROBOT_BENCH_SOURCE` to that checkout. Neither synthetic
engine events nor local WebSocket receipt constitute real Codex/Claude/AGY/
Kimi/DeepSeek, VPS/cellular, phone-rendering or lock-screen acceptance.

## Response-first follow-up (2026-10-15)

User priority is timely output, not reduced network usage. Removed the
card-size-dependent delay and its extra JSON serialization. Native replies now
use the same 100 ms interval for short and long bodies; the first live update
remains immediate. Slow receivers still have at most one active and one pending
patch. Revision deduplication, bounded retries, reconnect replay, terminal
ordering and complete answers remain unchanged. Failure backoff still applies.

The cadence regression now exercises both 64 KiB ASCII and approximately
192 kB Chinese bodies: each must publish its next delta at 100 ms, preserve an
existing deadline through repeated phase notifications, and retain the complete
final answer. Both cases failed under the old size policy and pass with the fix.
The focused cadence, old-Hub transport-limit and Gateway card-state suites pass
(33 tests). The full pre-complete gate also passes: standalone build (332
modules), 272 test files, 3,584 tests passed and one skipped.

The same disposable transport benchmark was run sequentially before and after:

| Scenario | Median ms (before → after) | P95 ms (before → after) |
| --- | --- | --- |
| Short answer, one Bot | 96.3 → 97.7 | 146.5 → 146.4 |
| 100 tool records each, five Bots | 194.1 → 195.5 | 267.9 → 265.7 |
| 64 KiB answer each, five Bots | 284.1 → 193.3 | 407.2 → 276.7 |
| Forced Gateway reconnect, one Bot | 93.4 → 95.3 | 230.5 → 232.4 |

All 480 content markers and 12 terminal states arrived in each revision. Long
answer client payload increases from 2,367,430 to 5,060,653 bytes, consistent
with the requested latency preference; these are diagnostic single-run results,
not an end-to-end latency guarantee. See the [recorded measurements](run-response-priority-benchmark-2026-10-15.json).

CLI impact: desktop hosts and headless CLI hosts use this same controller after
Codex, Claude, Antigravity, Kimi or DeepSeek adapters emit events. No new CLI
command, protocol/schema, host identity or network membership change is needed.
The change remains source-only until new matching App/CLI artifacts are built
and installed. This follow-up did not perform another independent Opus review.
