# Streaming latency audit — 2026-10-26

The report concerns public reply/commentary text and public process summaries,
not private reasoning. The user described visible progress arriving in bursts.
Source baseline: `32c9a707`; installed Host 0.1.459 / App 1.0.114 used the same
streaming paths. This change does not install, restart, or release that Host.

## Confirmed findings and changes

1. **The Hub's global broadcast queue amplified write contention.** A committed
   event waited for every earlier broadcast before even reserving its personal
   projection read. Each successive read then joined the database queue behind
   more concurrent Bot writes. A deterministic held-projection test reproduced
   the issue: only one of three committed events prepared its projection.
   The Hub now reserves these reads at commit notification, while retaining
   ordered publication, event sequence/cursor checks and per-user projections.
   Reads remain on the existing serial database queue. There is no new database
   connection, migration, event loss/coalescing, or durability relaxation.

   Recipients are captured before preparation. A connection authenticated later
   obtains the committed event through its own snapshot/replay, rather than an
   unprojected fallback. Send-time session validation still runs on every frame;
   both in-process and external revocation remain effective before delivery.

2. **An open process reader could wait for its one-second fallback after the
   final public-thinking delta.** Body metadata is published before its optional
   journal batch. If the details read returned the preceding journal revision
   and no more engine events arrived, the last text waited for the periodic read.
   Baseline browser probes measured tails of approximately 0.5–1.1 seconds,
   with only 9–15 ms between decoded HTTP content and DOM update. This is
   separate from provider cadence and from rendering stalls.

   The reader now schedules one 180 ms follow-up per observed summary revision
   when its current, unfiltered last page is behind a live thinking summary.
   It retains one request in flight; a newer summary supersedes the scheduled
   read. Closing, searching or switching pages cancels it. Historical/scoped
   views are excluded. The one-second compatibility fallback and journal
   durability remain: a sufficiently slow journal can still require that
   fallback. This is bounded catch-up, not continuous fast polling.

## Local transport measurements

Three sequential repetitions of each scenario, before and after the Hub change.
Values below are the median of the three per-run p95 values, in milliseconds.
Synthetic public events passed through the real controller, durable Gateway
outbox, SQLite Hub and authenticated WebSocket client. This excludes provider
CLI generation, network relays, browser layout and physical phone paint.
These are local samples under a shared Mac workload, not performance guarantees.

| Scenario | Before | After |
| --- | ---: | ---: |
| Short stream, one Bot | 124.8 | 128.3 |
| Five Bots, 100 historical tools each | 230.1 | 277.2 |
| Five Bots, 64 KiB answers | 314.3 | 298.5 |
| Five Bots, six tool results per 50 ms each | 1447.1 | 482.6 |
| Five Bots, 64 KiB tool outputs | 1599.9 | 502.6 |
| Gateway reconnect mid-stream | 265.4 | 270.5 |

The major improvement is under dense live-tool load (about 67–69% lower p95).
Short-stream and reconnect figures are similar; historical-tool results vary
within overlapping before/after sample ranges. There is no claim that every
scenario became faster. All 2,640 markers per measurement set reached the client;
final journal/tool state was checked. Instrumented after runs had zero RPC errors.
The controller retains its native 100 ms bounded coalescing policy.

## Independent Opus 5.5 xhigh adapter audit

Locally verified CLI versions: Codex 0.164.0, Claude Code 2.1.310,
Kimi Code 2.3.2, AGY 1.4.7, DeepSeek Harness 0.2.1-rc.3.

| Engine | Evidence and conclusion |
| --- | --- |
| Codex | Local isolated CLI probes already received text in bursts, roughly 0.23–0.26 s median between clusters, with longer gaps. The adapter forwards each delta without a display timer. This proves upstream cadence exists, not that it is the sole cause of the user's incident. |
| Claude | Partial text/thinking events are forwarded directly. An isolated short CLI probe had finer cadence than the Codex samples. Different prompts/settings and few samples do not establish a model speed ranking. Full-block sanitization per delta has measurable cost for exceptionally long single blocks; common-length samples were sub-millisecond per event. |
| Kimi | ACP text/thought chunks are streamed. A hook-drain routing fence can delay updates when an accepted hook is slow; it is not an intentional display throttle. The fence protects foreground/background attribution and must not simply be removed. See follow-up evidence and limits below. |
| Antigravity | `step_update` text deltas are forwarded directly. This stream-json path does not expose public reasoning text; absence of such text is not evidence of dropped output. No new live AGY timing run was performed. |
| DeepSeek | The harness forwards assistant-stream frames by session. Existing native chunk timing records and adapter tests support incremental output. This is not a new controlled live DeepSeek comparison. |

Codex's public commentary is ordinary assistant message text. Public reasoning
summaries are a separate optional output. We do not enable summaries, change
model/effort settings, or add a typewriter delay to make arrival look smoother.
Neither prompt queues nor background task ownership/cancellation are modified.

Kimi's hook fence was also tested with a controlled fake native process: with
no slow hook, six text/thought chunks passed in 0–3 ms; an intentionally slow
1.5-second hook handler delayed them about 1.35–1.5 seconds. Removing the fence
lost background-result review text in the attribution probe. This establishes
the mechanism, not its frequency or cost in real Kimi sessions. A safe redesign
would need to preserve hook, task-notification and result ordering; it remains
outside this focused fix. Exceptionally large Claude blocks and adjacent Codex
message-boundary presentation are also recorded as separate follow-ups, not
claimed fixed or established causes of this user's slowdown.

## Correctness and independent review

- Host unit suite: **504 files, 6,850 passed / 5 conditional skips**. The focused
  Host set passed 80 cases before the full run; the Host build also passed.
- New deterministic Hub cases first reproduced the blocked preparation on the
  baseline, then covered ordered revisions, hidden-message projection, late
  connections, local/external device revocation after preparation, early
  projection rejection and durable history recovery on reconnect.
- The reader's clock-controlled tests first failed on the stale-tail baseline,
  then passed with the fix. They cover bounded retries, the retained slow-Host
  fallback, coalescing behind an in-flight request, and cancellation/exclusion
  for closed, search and historical views. All 14 reader cases passed in both
  Chromium and WebKit. Client translation checks, TypeScript and Vite build pass.
- Actual **Opus 5.5 xhigh** independently inspected the five adapters and both
  fixes. No blocking issue remained. Opus did not alter the product or run the
  root's regression suite. Online recovery from an injected projection failure
  was not separately re-probed; the new test verifies reconnect recovery and
  the unchanged client sync-gap path remains covered by existing suites.

Opus's short native CLI probes ran at 19:43–19:45 despite an earlier request to
coordinate load. They may have affected exploratory measurements in that window;
those exploratory numbers are not the before/after table. The baseline table
run finished at 19:37 and the after run was 19:49–19:51. Production Bot workloads
remained active, so no measurement is described as globally idle-machine timing.

## Browser results and the slower phone-pressure sample

Chromium measurements below combine the Hub and reader fixes. Values are
event-to-expanded-DOM p95 / maximum in milliseconds; 60 synthetic markers per
phase. The pressure case has 50 foreground tool receipts and two concurrent
background Bot streams. These are individual samples, not a device benchmark.

| Public-thinking case | Before | After |
| --- | ---: | ---: |
| Desktop 1360, ordinary | 299 / 721 | 282 / 322 |
| Desktop 1360, pressure | 336 / 1112 | 322 / 336 |
| Phone 390, ordinary | 288 / 716 | 286 / 320 |
| Phone 390, pressure | 313 / 565 | 797 / 1497 |

The last row is deliberately retained. Two phone-pressure repeats gave p95
485 and 508 ms, with maxima 529 and 617 ms. Most of their wait occurred before
the text reached the browser's decoded response, not in its Markdown worker or
DOM update. Another independent sidebar Playwright suite was also running on
the shared Mac during these after samples. That is a confounder, not proof of
the cause. These results do **not** establish a uniform phone-pressure speedup.

To investigate a possible regression, a final four-case alternating control
used the same after client and only restored the old delayed projection
reservation in a disposable test shim. Old/new/new/old public-thinking p95 was
317 / 318 / 324 / 330 ms (maxima 333 / 345 / 375 / 397 ms), so the sustained
slowdown was not reproduced. One new-scheduling body phase still had a 400 ms
p95, versus 146–164 ms in the other three body phases; that outlier is retained
too. The shim compares scheduling only, not all historical Hub behavior.
It supports keeping the narrow fixes without claiming every remaining burst
is explained or every pressure scenario is faster.

All four after Chromium cases, four after WebKit cases, two repeated phone
cases and four scheduling controls passed marker/terminal-state completeness
and browser error checks: 1,680 timed markers in those fourteen runs. WebKit
has no before baseline; its after thinking p95 was 289–471 ms. Chromium
reported zero long tasks during the measured intervals and frame p95 around
16.7–16.8 ms. WebKit frame p95 was 18–19 ms; its Long Tasks API was unavailable,
so no zero-long-task claim is made for WebKit. Neither DOM observation nor a
subsequent animation frame proves compositor paint or physical-device fluidity.

## Reproduction and evidence

- `scripts/benchmark-run-transport.mts`: source-selectable isolated transport
  benchmark. Its trusted disposable fixture setup was updated for strict pairing;
  the production pairing route is unchanged. `TAROBOT_BENCH_REPEATS=3` repeats
  scenarios; `TAROBOT_BENCH_STAGES=1` adds publication-stage timings and RPC errors.
- `client/e2e/streaming-latency.spec.ts`: opt-in browser measurements with
  `TAROBOT_STREAMING_PERF=1`; desktop 1360 and phone 390, short and long-run plus
  two background Bots. Checks body/process marker completeness and records HTTP,
  Worker, DOM and next-animation-frame times. No machine-speed CI thresholds.
- Local evidence root:
  `/Volumes/gdrive/taro-tmp/streaming-latency-audit-20261026/`.
  Baseline/after transport NDJSON, deterministic regression logs, browser timing
  JSON and screenshots, and independent `opus/` findings/reviews are retained.
  Private existing-session copies used for aggregate timing were deleted.

Browser measurements are not native Mac/iPhone/Android acceptance. Real mobile
networks, low-end Android, thermal throttling, and all five engines generating
simultaneously remain unmeasured. Model service latency and native text batching
remain outside this fix. The standalone CLI uses the same Host broadcast code;
no CLI command or public protocol/schema change is required.
