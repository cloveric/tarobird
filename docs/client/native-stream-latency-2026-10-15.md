# Native streaming latency: body first, bounded evidence

The response path still uses the existing cards, Markdown renderer, tables and
code blocks. No extra body throttle, shorter answer, or invented progress was
introduced. The existing 100 ms coalescing policy remains in place.

## Implementation

- Live body snapshots reach the durable Hub publication before optional
  `run.write` batches. One journal request is active per worker, with pending
  revisions coalesced by conversation/message/run/entry identity. Only changed
  entries are validated/copied; the full journal is not cloned each body frame.
  A batch has up to four entries and targets 256 KiB; a larger individual entry
  goes alone.
- Only duplicate body-text **detail-journal** revisions coalesce for up to
  200 ms. The body has already been published and retains its 100 ms cadence.
  Public thoughts, tools, terminal flushes and shutdown bypass this evidence-only
  delay. This avoids making live body writes contend with a journal write on every frame;
  it does not delay a reply to save network traffic.
- Terminal publication flushes its own journal first, with scheduling priority.
  A failed detail write does not swallow the answer and is marked unavailable.
  Failed revisions retry on a subsequent normal update/terminal flush, without
  a spinning retry loop.
- Normal shutdown queues unsent evidence on the durable outbox before closing
  the transport, including evidence captured while a body publication still
  awaits acknowledgement. Real-Hub tests hold a publication or a detail write,
  stop the channel, inspect all
  pending disk records, reconnects and verifies all old plus newly written rows.
  Permanently rejected evidence is not retried on every live body frame. Large
  continuously updated entries rotate behind other pending entries after ACK.
- Durable outbox acknowledgments, Hub snapshot storage, authorization, message
  versions and replay fences remain authoritative. Not-yet-submitted in-memory
  detail revisions can be lost on a hard worker crash; this is not a claim of
  crash-safe storage for every raw CLI event. Submitted requests replay normally.
- `streaming.card-extra.v1` lets capable clients replace just card metadata while
  appending text. Old clients receive compatible original operations/snapshots.
  First/replayed bases and terminal messages remain complete snapshots.
- An open process panel refreshes active details once per second, coalescing
  concurrent reads. It catches journal updates arriving after the live summary;
  expanded rows and reading position remain intact. Closed panels do not poll.
- Desktop and headless CLI hosts share this Gateway implementation. Codex,
  Claude, Antigravity, Kimi and DeepSeek retain their existing event adapters.
  This does not add a CLI-specific command or alter private-network membership.

## Local transport measurements

Baseline: `abd255a1a73ddc08206b19ad18ccad0fe5ac5683`.
`scripts/benchmark-run-transport.mts` ran three baseline trials and three final
implementation trials in separate windows, with warmup evidence fully drained
and no concurrent build/test work. It uses synthetic public
engine events, actual Gateway durable outboxes, an isolated Hub/SQLite and an
authenticated WebSocket receiver. Each row below is the median of the three
trial percentiles, in milliseconds; it is **not** provider generation time,
cellular/VPS latency, browser paint or physical-phone acceptance.

| Scenario | P50 before → after | P95 before → after | P99 before → after |
| --- | --- | --- | --- |
| One Bot, short reply | 94.6 → 68.8 | 146.2 → 120.3 | 147.9 → 122.2 |
| Five Bots, 100 prior tool records each | 212.3 → 131.9 | 297.9 → 189.3 | 307.9 → 215.6 |
| Five Bots, 64 KiB reply each | 227.0 → 142.7 | 308.9 → 204.7 | 337.0 → 239.6 |
| Five Bots, six tool completions per 50 ms tick each | 3957.5 → 239.6 | 4856.3 → 324.8 | 4943.9 → 334.3 |
| Five Bots, one 64 KiB tool result per 50 ms tick each | 522.1 → 238.1 | 792.9 → 311.3 | 872.3 → 330.6 |
| One Bot, forced Gateway reconnect | 96.3 → 74.9 | 230.7 → 262.6 | 331.0 → 364.1 |

All 2,640 measured text markers, 5,700 final tool records and 66 terminal receipts
arrived per version across the three trials. With long answers, full-card
transmissions fell from 70 to 5 per trial (medians), with the five retained
terminal snapshots intact. This avoids redundant reconstruction; bandwidth
savings are incidental, not the acceptance objective.

The stress case intentionally exceeds ordinary interaction: five Bots each
produce 240 tool completions in about two seconds. More body frames become
visible during this burst. Total scenario time **including final journal drain**
rose from 5.857 s to 5.987 s. With 64 KiB tool outputs it rose from 2.541 s to
2.714 s. The final wait after the last body receipt is longer because the body
now arrives ahead of the journal. Evidence is still flushed before publishing
completion. Body latency improved substantially, but this is not an
across-the-board improvement in terminal throughput.

Forced reconnect is also not a uniform latency win: the median improved, but
P95/P99 were about 32–33 ms slower. These three local trials do not establish
improved reconnect latency or real network performance. No display wait was
added to save bandwidth; duplicate detail-text coalescing is described above.

## Verification

Focused coverage checks revision coalescing, fair byte-bounded batching,
failure/retry, stop while awaiting evidence, live body publication during a held
write, final revision fences, mixed old/new clients, duplicate/version/base
checks, replay and full terminal snapshots. Browser coverage checks late-arriving
process records, metadata deltas alongside existing code/table rendering,
five-engine desktop/phone layouts and reading/scroll behavior.

Validation completed:
- Root build and full pre-complete gate: 274 files, 3,601 passing tests, one skipped.
  A default-parallel run hit one host shutdown error and one existing 5-second
  service timeout. Both files then passed independently (48 tests), and the full
  suite passed with four workers, retaining the same assertions and timeouts.
- Client translation/type checks and production build passed.
- Chromium: 28 browser regressions passed, including all five engines on desktop
  and phone-sized touch layouts, delayed journal reads, code/table preservation,
  stable card identity, IndexedDB recovery and reading/scroll positions.
- Each final benchmark pass verified all 1,900 tool entries reached their final
  revisions, including 1,200 entries in the live-tool stress case and 200 entries
  in the large-output case.
- Native phone, real provider CLI generation, VPS/cellular paths and WebKit
  rendering were not verified in this change. Phone layouts above are Chromium
  emulation, not a physical-device delivery claim.

Source changes do not update an installed App or a published CLI package.

## Follow-up bug audit

Two regression cases were reproduced against the first implementation and fixed:

1. Stopping after the Hub stored a live body, but before its acknowledgement
   reached the worker, lost all captured-but-not-yet-scheduled details. The real
   Hub regression found zero of 13 expected entries in the outbox. The writer
   now owns those entries during publication, hands them to the durable outbox
   on stop, and releases them exactly once on a normal publication outcome.
   Reconnection verifies all 13 records, including channel reuse. Newer held
   revisions also survive an older in-flight detail write. Publication failure
   releases ownership through `finally`; optional evidence does not hold memory
   indefinitely after an unsuccessful publication.
2. An invalid optional run summary threw before the evidence error boundary and
   prevented the readable card from publishing. Invalid or unsupported summary
   metadata now falls back to the original card; no invented native status or
   process record is emitted.

These fixes use the shared Gateway for desktop and headless CLI hosts and all
five engine adapters. They do not change the body cadence, terminal journal
fence, negotiated delta format, or private-network identity and permissions.
The three-trial timing table above describes the initial performance change;
it is not a new three-trial measurement of this follow-up.

Follow-up validation: 78 focused regression tests passed. The root build and
full suite passed with four workers: 274 files, 3,605 tests passing and one
skipped, without changing assertions or test timeouts. All 26 selected Chromium
regressions passed, covering desktop/phone reading, delayed details, all five
engine presentations, nested-card deltas, recovery and code/table rendering.
These remain emulated layouts, not physical-phone acceptance.
One additional isolated transport pass covered all six scenarios and verified
880 text markers, 1,900 final tool entries and 22 terminal receipts. Short-reply
and live-tool P95 were 122.8 ms and 308.1 ms respectively; this is a smoke
measurement, not another three-trial comparative benchmark.

## Independent review of the initial performance change

Before the follow-up audit, a separate local Claude invocation requested and returned `claude-opus-5-5`
with `--effort xhigh`. It performed static review only, with tools disabled;
builds, browser tests and measurements above were run independently here.
Confirmed findings were repaired: unsent journal persistence during shutdown,
channel reuse, copying only changed entries, malformed-evidence isolation,
terminal batch priority, phase/status-sensitive process refresh, permanent-error
retry suppression and fairness for continuously growing entries.

The review also suggested a two-second terminal timeout. This was not adopted:
`HubServer.instanceSocket` already serializes requests per worker socket and
SQLite is shared, so a stalled journal RPC also holds a later publish. Merely
abandoning the wait cannot guarantee delivery and would remove the durable
terminal fence. This change makes no claim to recover an indefinitely stalled
Hub database. Existing reconnect/replay and verified storage acknowledgments
remain authoritative. Splitting the durable outbox into separate files is a
larger future change, not required for the measured body-latency improvement.
