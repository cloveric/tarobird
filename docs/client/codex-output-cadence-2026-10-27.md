# Codex public-output cadence — 2026-10-27

Baseline: `108a82db`. This follow-up concerns public reply text and public
process summaries, not private reasoning. Actual Opus 5.5 xhigh independently
reviewed the controller and transport, using disposable probes. There was no
production database maintenance/migration, model or reasoning-effort change.

## What is established

The reported existing reply waited about 48 seconds for its first body update,
then delivered 542 characters over about 19 seconds. Most visible state changes
were roughly 250 ms apart. Native state timestamp to Hub event timestamp had a
115 ms median and one 1007 ms outlier. These timestamps do not measure browser
paint or locate the outlier within the transport pipeline.

The App controller added a fresh 100 ms delay to every burst after the first
update, including bursts arriving after an idle gap. This was bounded trailing
coalescing, not a debounce that could starve under continuous events. Opus's
controller probe reproduced the extra delay with Codex-like 250 ms clusters.
This is avoidable App latency even when upstream chunk timing is unchanged.

The shared Gateway outbox, per-Bot request chain and Hub database queue can
also accumulate delay under concurrent tool traffic. Root's isolated five-Bot
dense-tool stage probes reproduced stacked waits; Opus's single-Bot probes did
not show a comparable tool-load penalty. Neither established which stage caused the historical one-second
outlier. The surviving event window contains only eight small message updates;
journal rows are revision-replaced, so their current timestamps cannot establish
the absence of earlier journal writes. There was no matching stage trace.

## Narrow fix

- Native App live publication intervals are measured from the **actual patch
  start**, with a 16 ms minimum aggregation window after an idle gap. Continuous
  streams retain at most one live patch start per 100 ms; the first live patch
  remains immediate.
- A waiting patch rechecks cadence when it actually starts. Otherwise a slow
  previous write can leave a stale timer that releases another patch too soon.
- An early timer waits only the remaining monotonic deadline, rather than
  adding another aggregation interval. Failed writes retain the existing retry
  backoff and bounded autonomous retry count.
- The existing serial chain, one in-flight plus one waiting update, latest-state
  capture, duplicate-revision suppression and terminal fences are retained.
  Terminal finish, interrupt/stop and error delivery do not wait for the live
  cadence limit. The nonterminal `stopping` status still observes that limit.

There is no client-side typewriter, artificial character insertion, reduced
reasoning effort, protocol/schema change or relaxation of fsync, authorization,
run-journal capacity, task ownership or recovery. Native App presentation is
shared by all five engines; adapter ordering and provider generation are unchanged.
The standalone/headless Host uses this same controller. No new CLI command is
needed. Retained legacy-channel cadence is unchanged.

## Regression and measurement contract

The new fake-clock cases first failed on the baseline for sparse body/public
summary bursts and delayed patch starts, then passed after the fix. They also
cover fractional early timers. Existing cadence, backoff, long-answer, terminal,
slow receiver and recovery cases remain part of validation.

`client/e2e/streaming-latency.spec.ts` now accepts
`TAROBOT_STREAMING_PERF_INTERVAL_MS` (default 50; bounded 20–500) to exercise
Codex-like 250 ms input separately from dense streams. It checks all synthetic
body/process markers and terminal state through a real isolated Hub, durable
Gateway and built client. Desktop 1360 and touch viewport 390 are tested with
and without two concurrent background Bots. The pressure process includes 50
foreground tool receipts. Measurements are opt-in, not machine-speed CI gates.

Evidence is retained in the local `codex-stream-fix-20261027/` directory
(machine-specific parent path omitted from this public report).
Measurements, final suite totals and independent review are recorded below.

## Independent paired transport measurements

Opus ran four sequential cases on the external-volume temporary directory,
using the pinned baseline and final controller SHA-256
`ba2af91d5cc67eb1ea6d3eb44145fd3f9ccb0f1b8140aa72c25bb84883d6116c`.
Each injects 40 Codex-like clusters through the real Gateway outbox, instance
socket and SQLite Hub. Root did not run browser/build/performance suites in
this window; normal production activity was not suspended. Times below are
milliseconds from native state timestamp to **Hub event timestamp**, not commit
completion, ACK receipt, provider latency or browser paint.

| Workload | Baseline p50 / p95 / max | Fixed p50 / p95 / max |
| --- | ---: | ---: |
| Sparse short answer | 125 / 130 / 137 | 38 / 97 / 392 |
| Sparse answer with 60 prior tool receipts and intermittent live tools | 129 / 133 / 140 | 44 / 48 / 50 |

The **392 ms outlier is retained**. In that case enqueue-to-durable-outbox
completion reached 370 ms, while its median was 16 ms. This localizes an
additional delay to the persistence path (including its queue/event-loop waits),
but does not isolate fsync alone or prove it caused the historical 1007 ms event.
The measured improvement concerns typical added delay, not elimination of all
tails. Provider-like output gaps remained approximately 250 ms.

All 160 injected markers appeared in live output and the final visible cards;
final answer content, completed phase/status and drained outbox were asserted.
An initial probe incorrectly supplied a replacement terminal answer instead of
its streamed answer; that fixture could replace its final marker. Its results
remain labeled `v1-inconsistent-fixture`; the table uses the corrected, asserted
`v2-consistent-final-answer` cases. Product behavior was not changed to satisfy
that fixture.

Opus's isolated storage probes found roughly 1 ms for writing one short journal
entry even with 7.5 MiB already in that message's journal. This is a local sample,
not a bound under contention. There was insufficient evidence to justify changing
journal accounting, per-frame authorization or durable outbox recovery in this
fix. Experimental outbox group-commit shims were not adopted.

## Browser checks

All 16 after-change Chromium/WebKit cases passed: dense 50 ms and sparse 250 ms
public inputs, desktop 1360/touch viewport 390, ordinary/background-load cases.
The preliminary four Chromium baseline cases also passed. Some exploratory
measurements overlapped small independent probes, so they are not used as a
clean before/after performance claim.

After Opus's measurement window ended, five final Chromium cases ran without
another task-owned benchmark: one dense desktop repeat and four sparse cases.
All passed, including every marker and final state. For the sparse cases:

| View / load | Body event→DOM p95 / max (ms) | Public-summary event→DOM p95 / max (ms) |
| --- | ---: | ---: |
| Desktop, ordinary | 60 / 63 | 292 / 296 |
| Desktop, background Bots | 99 / 124 | 280 / 287 |
| Phone width, ordinary | 58 / 71 | 241 / 242 |
| Phone width, background Bots | 105 / 153 | 271 / 274 |

The dense desktop repeat had body p95 117 ms / max 278 ms and public-summary
p95 280 ms / max 331 ms. Its largest body sample took about 112 ms to reach the
socket and another 167 ms to reach the DOM, mainly before Markdown worker
submission. This is retained as an unresolved client-path tail, not labeled a
parser bottleneck or a universally smooth frame guarantee. The final Chromium
intervals reported zero Long Tasks and frame p95 near 16.7 ms. WebKit lacks the
Long Tasks API; its absence is not a zero-long-task measurement.

Actual Opus 5.5 xhigh reviewed the final controller and tests by SHA-256, with
no blocking finding. Root independently verified the regression failures on the
baseline, the fix, recovery cases, builds and the browser results. The optional
queued-timer micro-optimization, scoped/background-card cadence and Codex
adjacent-message boundary presentation remain separate work; they were not
silently included or claimed fixed here.

## Type-check boundary

The extra broad `tsc --noEmit` check includes historical tests and unused adapter
files that are outside the release entry graph. It is **not clean**: 121 type
diagnostics, including retained legacy-channel test fixtures. A TypeScript
CompilerHost comparison overlaid the two changed root TypeScript files with
their exact `108a82db` blobs; the full diagnostic multiset (file/code/message,
excluding shifted line offsets) was identical: 121 before, 121 after, zero added
or removed. This does not mark that broad check as passed or fix its existing
errors. The comparison is recorded in `typecheck-baseline-comparison.json`.
Release-entry compilation is verified separately by `npm run build`.

## Final validation

- Focused cadence, Gateway writer and recovery suites: **63 passed**.
- Full root suite after building the candidate: **506 test files passed;
  6,891 tests passed, 5 conditionally skipped** (443.74 seconds).
- Host/CLI release-graph build, client build and client `tsc --noEmit`: passed.
- After-change browser checks: **21 passed**, as detailed above. The paired
  transport probes verified all 160 markers and final state.

The initial full-suite attempt ran before compiled `dist` files existed. Its
14 failures were missing compiled CLI/Host entry or runtime files; its log is
retained as `full-tests.log`. After the normal build, the **entire** suite was
rerun successfully (`full-tests-built.log`), without product changes to bypass
those failures. The separate broad root type-check remains subject to the
unchanged 121 diagnostics described above.

## Limits

This reduces avoidable publication latency; it cannot make a provider's 250 ms
chunks become a continuous stream, reduce its first-token reasoning time, or
claim to fix an unlocated historical one-second stall. Synthetic public events
bypass native model generation. DOM observation and the next animation frame
are not compositor-paint proof. Native Mac/iPhone/Android, real mobile networks
and simultaneous live generation by all five engines are not newly accepted by
these measurements. No release or installed-App update is part of this change.
