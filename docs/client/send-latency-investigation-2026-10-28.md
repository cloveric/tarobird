# Outgoing-message latency investigation — 2026-10-28

Status: two production queue blockers are identified and source repairs are implemented.
Installed Mac/phone acceptance is **not complete**; no release or installation was performed.
The owner reports at least one second of “等待发送” on phone and local Mac. Codex and
actual Opus 5.5 (`claude-opus-5-5[1m]`) investigated click → send → ACK separately
from Host → Bot admission and model output.

## Confirmed blocker and repair

`HubLinkPreviews.tick()` runs every **500 ms**. Its `HubStore.pendingLinkPreviews()`
query searched historical message rows for unfinished link previews while holding
the same serialized database queue needed by message sends and session validation.
It had no index matching that global candidate search and chronological ordering.
An empty pending-preview result could still require a history scan and sort.

A bounded **40-second** live timing capture on the installed Host recorded:

- **19** preview sweeps exceeding 50 ms, totaling **4,652 ms** of queue execution.
- The slowest sweeps took **567, 537, 453, 449 and 428 ms**. Their own enqueue waits
  were approximately 1 ms; the time was inside their `SELECT`, not waiting to start.
- Session validation behind a sweep waited **567.5 ms**, then executed in **1.8 ms**.
  Other queued reads waited about **486–492 ms**, then executed in under 1 ms.
- No `run` or `exec` operation exceeded 50 ms in that capture. A journal-size read
  took 83.6 ms; it was not the largest blocker.

This directly identifies a recurring background query that delays shared Host work,
including sending from both desktop and phone. It does **not** prove that every
reported delay, the earlier eight-second outlier, or the entire delivery-floor shift
has this one cause. The query predates the latest update; timing alone does not
establish a newly introduced source regression.

The repair adds an additive partial index, `messages_pending_link_previews`, on
`messages(created_at)` with the query's exact pending-user-preview predicate. SQLite's
implicit rowid suffix retains `created_at,rowid` order. The existing membership check,
selection limit, retry behavior, preview parsing, message writes and send ACK semantics
are unchanged. The index is created **after** legacy preview columns are added, so
both fresh and existing schema-22 stores receive it. No schema/protocol bump or data
rewrite is needed; older compatible Hosts can maintain the additive index normally.

## Second blocker: a full history scan during prompt dispatch

A subsequent **100-second** bounded capture instrumented the existing Host and two
active workers. Actual Opus 5.5 independently traced the delivery code and identified
another unindexed history scan; the live timing then confirmed its cost. No process
was restarted. Temporary wrappers restored automatically, all debugger listeners
closed, and isolated Host/worker fixtures first checked return values, rejected
promises, restoration and clean exit. Logs contain timings and operation classes,
not message contents, SQL arguments, device identities or credentials.

Before dispatch, `HubPromptQueue.claim` cancelled legacy deleted messages with:

```sql
UPDATE deliveries SET status='cancelled'
WHERE bot_id=? AND status='pending' AND dispatched=0
  AND message_id IN (SELECT id FROM messages WHERE status='deleted')
```

The subquery builds its candidate list from the entire `messages` table, inside
the shared database transaction. It ran for **422.6 ms** during an ordinary,
authorized collaboration input. The enclosing claim waited **11.4 ms** to start,
then executed for **428.6 ms**. During that interval:

- A Bot's conversation lookup waited **399.7 ms**, then executed in **1.0 ms**.
- Outgoing-event session checks waited approximately **439 ms**, then executed
  in **0.2–0.6 ms**.
- Another publication waited **349.8 ms** before approximately **20.0 ms** of
  transaction work. An authenticated HTTP request also waited behind the claim.

This is a distinct blocker from preview discovery. The existing preview index
does not cover this tombstone predicate. Dispatch checks all connected Bots;
pending inputs held behind a running turn can therefore expose the scan again
when unrelated inputs trigger another dispatch cycle. No fixed one-second timer
exists on the ordinary admission path. A separate two-second retry applies only
when native input is explicitly blocked; its contribution here is unverified.

The repair correlates the check to each pending delivery:

```sql
AND EXISTS (
  SELECT 1 FROM messages m
  WHERE m.id=deliveries.message_id AND m.status='deleted'
)
```

The plan now searches the message primary key for each candidate delivery instead
of scanning history. Bot, pending-status and dispatch-fence filters, transaction
boundaries, permissions, replay and cancellation semantics are unchanged. There
is no new index, schema migration, protocol or CLI command for this second repair.
Desktop/mobile and standalone CLI Hosts execute the same `HubPromptQueue` code.

The regression first failed on the historical scan, then passed after the rewrite.
It uses 2,000 historical messages and captures the actual issued SQL. It verifies
primary-key lookup, cancellation of undispatched legacy tombstones, and retention
of live, personally hidden, dispatched, accepted and other-Bot deliveries.
Prompt queue, personal deletion, auth isolation and Gateway delivery recovery:
**65 tests passed** with a 20-second per-test execution budget. This explicitly
accommodates the existing slash-stop test whose default five-second budget was
already insufficient on unmodified source; no assertion or source timeout changed.
The Host/CLI build passed with **456 standalone modules**.

Actual Opus 5.5 reviewed the exact patch and regression: the replacement retains
the same selected deliveries and satisfies the deletion/dispatch invariants; no
change was requested. Its benchmark used the byte-identical repaired source.

### Isolated dispatch-query A/B

Opus compared installed source `5950ea65` with only this query rewrite applied.
Both variants had the preview index, isolating the second repair. A real Hub and
Gateway used fake engines, 6,691 synthetic messages and 2,000 retained updates of
about 30 KB each. One busy Bot held an undispatched input behind its current turn;
an unrelated Bot received 15 signed WebSocket messages per run, one second apart,
while a reader requested folders every 250 ms. All state was on the external disk
and removed afterward. There were two accepted runs per variant.

Ranges are the two runs' percentiles, not pooled percentiles:

| Measurement | Current `IN` | Repaired `EXISTS` |
| --- | ---: | ---: |
| Tombstone query median | 7.7–8.3 ms | 0.1 ms |
| Tombstone query p95 | 99.9–143.2 ms | 0.2 ms |
| Busy-Bot claim p95 | 163.4–167.8 ms | 15.0–20.6 ms |
| Target creation → worker input median | 88–97 ms | 57–59 ms |
| Target creation → worker input p95 | 223–256 ms | 90–134 ms |
| Sender ACK median | 45.6–66.1 ms | 17.2–17.9 ms |
| Database queue wait p95 | 13.5–16.8 ms | 2.2–2.4 ms |

The initial runner mis-split its zsh arguments: all four initial runs used repaired
source, including two mislabeled as current. Those raw records are preserved as
invalid comparison data. The two correctly sourced fixed runs were retained with
explicit label-correction metadata, and two actual current baselines were added.
The corrected harness checks the variant against the source predicate, requires
a valid repetition number and records the source hash; a negative check rejected
a mismatched variant. The fixed runs preceded the current baselines by a few
minutes, so this was **not** an alternating paired experiment.

These warm synthetic results independently support the query-work reduction and
lower dispatch/queue latency. They are not installed-device timings. Tail latency
remains: a repaired run still had a 124.9 ms ACK and a 126.3 ms folders response;
the HTTP tails varied between runs. The observed live 422.6 ms scan establishes
the production blocker, but improvement after installation is still unverified.

### What the wider timing capture does and does not establish

Preview discovery remained a substantial blocker: **190** calls, a maximum SQL
duration of **855.3 ms**, and a coincident publication RPC of **851.5 ms**. Network
metadata HTTP reached **873.8 ms**; these are related operations, not independent
delays to add together. A bounded auxiliary reader issued 70 folders requests,
one at a time with a 750 ms gap, while lightweight health reads overlapped. Its
maximum end-to-end folders time was **449.8 ms**. It generated no chat prompts or
settings changes.

On the two observed workers, file synchronization took at most **17.8 ms** and
**15.3 ms**; outbox persistence took at most **27.4 ms** and **43.2 ms**. Yet a
publication request waited **880.3 ms**, and a journal RPC waited **918.3 ms**,
consistent with waiting for the Host rather than a half-second worker fsync in
this window. This does not exclude disk/scheduling tails at other times.

Three journal ownership lookups took **138.2–146.1 ms**, inside transactions of
**158.5–164.5 ms**. The exact query already uses `UNION ALL ... LIMIT 1` and the
message-key indexes. These were **not** the byte-total `SUM` query from the earlier
40-second capture. The cause of these slower indexed reads remains unlocalized;
no ownership or quota check was weakened or speculatively rewritten. A separate
roughly 179 ms Host timer delay coincided with delays on both workers; its timing
did not overlap those three ownership reads. It does not prove a specific OS cause.

The capture did not include a complete timed ordinary click-to-`input.received`
journey, so it cannot assign the entire historical 583 ms admission median to the
new scan. It does directly show the scan blocking conversation reads, outgoing
events and publication. Neither source repair is installed in the running Host;
the overall lag and physical phone experience remain unaccepted.

## Observed installation and scope

- Installed App **1.0.117**, Host/CLI **0.1.462**, source
  `5950ea656c74150498f41b44dc52f613d5c68fb8`.
- Investigation source: `9c0c40c664b38522bdf6c2423dc324efa964f4ac` on an isolated worktree.
  That later notification/device UI source was not installed and cannot explain this report.
- Native Mac connection panel: **主机直连**, `http://127.0.0.1:54534`, displayed latency
  **19 ms**. The observed desktop route did not use the Internet relay.
- Production message history/settings were not directly edited, apart from requested collaboration
  messages. After read-only probes could not attribute the wait, temporary in-memory
  timing wrappers observed database methods for 40 seconds. They recorded durations,
  source call sites and SQL templates, never arguments, rows, messages or credentials.
  The wrappers restored automatically, the loopback debugger closed, and the Host PID
  stayed unchanged. An isolated inspector fixture first verified behavior and cleanup.
  No restart, installation, cleanup, real-model test prompt or test message in the
  owner's existing chat was performed.
- Synthetic Hosts, fake engine bridges, temporary browser profiles and builds lived on
  the external project disk. No authentication or durability checks were removed.

## Confirmed production symptoms

### Local authenticated requests can stall while the Host remains responsive

A read-only request to `/api/conversation-folders` uses authorization and the shared
serialized database path. The first extended probe made **600** requests, each preceded
by `/health`, between **01:07:55 and 01:10:01 Asia/Shanghai**:

| Request | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| `/health` (no DB access) | 1.9 ms | 4.1 ms | 50.7 ms |
| Authenticated folders read | 2.5 ms | 60.9 ms | 8,096.6 ms |

The reads were sequential, so the fast health result **before** a long folders read
cannot prove that the event loop stayed responsive **throughout** that long read.
The 8.1-second observation is an HTTP business-path duration, not a measured SQL
statement or queue-wait duration. Earlier working notes claiming otherwise are superseded.

A separate, bounded **40-request** probe ran health reads concurrently while each
folders request was pending. It captured:

- **635.9 ms** folders read, with successful health responses at approximately +0,
  +203, +407 and +609 ms, each taking **1.8–2.4 ms**.
- **492.0 ms** folders read, with health responses at approximately +0, +203 and
  +407 ms, each taking **1.6–2.3 ms**.

These two samples established a slow authenticated/database path while networking
and main-loop health responses continued. The later method timing above separated
query execution from queue waiting and identified the preview sweep.

The long-read cluster followed an Android authentication; a later 1.05-second read
followed iPhone authentication. This is **temporal correlation**, not proof that
reconnection or snapshot sync caused it. Ordinary `message.send` traverses the same
serialized database path several times, so it is a plausible source of delayed ACKs
across both desktop and phone. No timed production message-send trace was captured.

### Host-to-Bot admission is also slower

Matching existing Host message creation timestamps to worker `input.received` records,
excluding observations of five seconds or longer, yielded:

| Existing plain-user-message records | n | Median | p95 |
| --- | ---: | ---: | ---: |
| Before the 1.0.116 installation window | 621 | 181 ms | 501 ms |
| After that window, including 1.0.117 | 59 | 583 ms | 2,407 ms |

This is a separate delivery interval; it is not click-to-ACK or model first-token
latency. The time windows differ in workload and state. They support the owner's
observation that delivery became slower, but do not prove the update caused it.
The Host source diff from 1.0.115 to 1.0.116 is empty; 1.0.117 has no inbound-path
change explaining this step. Installed Node is native arm64 v24.14.0.

## Controlled comparisons

### Follow-up: whole-App lag and the previous streaming changes

The owner clarified that several interactions feel slow, resembling a network
problem, and asked whether the previous output-cadence optimization caused it.
The confirmed queue blocker is not limited to message sending: authenticated
HTTP reads, incoming WebSocket commands and outgoing frames share database-backed
session checks. Even WebSocket pong publication revalidates the session. In the
existing live capture, a Host-profile read waited **181.7 ms** and then ran in
**0.9 ms**; the 19 slow session-validation records accumulated **4,673.5 ms** of
waiting versus **14.1 ms** of execution. These are selected slow records, not
all-call percentiles; overlapping waits must not be added as elapsed wall time.

The App's displayed route latency measures `/health`, which does not use this
database queue. A low route-latency number therefore does not establish responsive
message/history/settings operations. The previously observed Mac route was
loopback, but this does not rule out additional phone-network or native-client
delays.

Two streaming changes were checked separately:

- `2e8f6345` reduces an idle burst's aggregation delay from 100 to 16 ms while
  retaining at least 100 ms between actual nonterminal live-patch starts. It can
  change batching and actual patch counts for some event spacings, so the rate
  limit alone cannot rule out a load-dependent regression. It does not change
  incoming message admission, route selection or provider settings.
- `051b61b6` reserves each event's existing projection read earlier on the same
  database queue. It changes queue ordering, not the number of projections per
  event. Its client change adds a bounded 180 ms follow-up only for an open,
  current, unfiltered process reader with a stale public-thinking tail; this is
  not an unconditional whole-App polling interval.

The existing multi-version pressure matrix cannot isolate either change. Opus
therefore ran **20** sequential, alternating controls using installed source
`5950ea65`, with only the `2e8f6345` production hunk reversed for the OFF variant.
There were two repetitions of five workloads in each variant: one/three streaming
Bots with burst/continuous inputs, plus three burst Bots with simulated process
readers. Three authenticated devices shared a real Hub and Gateway controllers;
an unrelated conversation sent 40 messages per run and read its folders over HTTP.
The burst fixture delivered four deltas 15 ms apart followed by a 230 ms idle
period; each answer began with about 30 KB of synthetic text. Continuous deltas
arrived every 20 ms. No provider or production traffic was generated by the harness.

Ranges below cover the two repetitions; they are not pooled percentiles.

| Workload | Optimization | Publications/second/Bot | DB queue execution / measured interval | Other-chat ACK p95 |
| --- | --- | ---: | ---: | ---: |
| One burst Bot | OFF | 3.40 | 12% | 29.8–33.4 ms |
| One burst Bot | ON | 6.72–6.81 | 18% | 30.2–39.3 ms |
| Three burst Bots | OFF | 3.41 | 32–33% | 69.5–72.4 ms |
| Three burst Bots | ON | 6.74–6.82 | 58–62% | 84.1–105.3 ms |
| Three continuous Bots | OFF | 8.70–9.04 | 87–88% | 233.2–284.5 ms |
| Three continuous Bots | ON | 9.00–9.20 | 86–89% | 224.6–242.5 ms |

This confirms a tradeoff missed by checking only the maximum refresh rate: the
short aggregation window can split one burst into two publications, increasing
full-snapshot persistence and projection work. The three-burst-Bot ACK p95 was
higher in both ON repetitions. It does **not** establish uniform slowdown: HTTP
p95 and the reader-enabled ACK comparisons were mixed, and continuous-load ACKs
did not regress in this sample. `run.write` counts stayed similar; publication
doubling must not be described as doubling journal batches. Across all 800 ACKs,
the maximum was **311.4 ms**; the largest folders read was **427.4 ms**. This did
not reproduce the owner's consistent one-second wait or the prior eight-second
production outlier.

The controls used synthetic compact databases and ran Hub, workers and clients
in one process. Despite the external-storage project rule, this harness inherited
the OS temporary directory and used internal APFS. Both variants used that same
location; the temporary databases were removed by per-run cleanup. The recorded
harness is retained, and future runs require an explicit external-disk temporary
path. This limitation must not be silently relabeled as an external-disk test or
as native/physical-phone acceptance.

Four additional external-disk controls repeated only the three-burst-Bot case,
with explicit `TMPDIR`. ON publication rates were **6.82–6.85/s/Bot**, versus
**3.30–3.41** OFF; queue execution occupied **66–67%** ON versus **38–56%** OFF.
The ON ACK p95 was **109.9–116.2 ms**. OFF had one **75.1 ms** p95 run and one
outlier run with **819.4 ms** p95 / **1,047.2 ms** maximum. This outlier is retained:
the throughput difference reproduced, but single-run latency tails cannot be
attributed solely to the cadence switch. These four runs add 160 synthetic ACKs;
they do not establish the cause of production stalls.

Simulated readers exercised revision-driven
reads and a one-second poll; they did not isolate the 180 ms follow-up added by
`051b61b6`, so this is not a separate A/B of that change.

The evidence supports **increased load from burst publication**, alongside the
separately traced preview-query blocker, rather than a claim that the streaming
optimization explains all sluggishness. No production rollback, new cadence
policy or installation was performed. Installed validation after the confirmed
index repair remains necessary before claiming the overall problem resolved.

### Installed frontend assets in WebKit

The actual installed bundled frontend assets were served to an isolated Playwright
WebKit browser. The fixture had 149 conversations, 2,134 synthetic cached history
messages (about 4 MB), 50 synthetic tool events, and a live synthetic Bot response.
Each size had **20 samples**, with every sample required to contain its own click,
WebSocket send, raw ACK, accepted DOM and next-frame timestamps.

| Viewport | Click → WS send median/p95 | Click → raw ACK median/p95 | Click → accepted DOM median/p95 | Click → next frame median/p95 |
| --- | ---: | ---: | ---: | ---: |
| 1360 px | 7 / 23 ms | 23 / 55 ms | 30 / 58 ms | 93 / 110 ms |
| 390 px | 5 / 18 ms | 24 / 65 ms | 26 / 67 ms | 95 / 111 ms |

This excludes a universal one-second delay in the installed frontend under this
fixture. It does **not** measure native Tauri/Capacitor transport, the owner's real
browser cache, or a physical iPhone. Width alone is not an iOS platform test.

Earlier Vite development-build and Chromium measurements were confounded by React
development overhead/software rendering. An early next-frame observer also captured
a mutable sample reference; it was corrected before the measurements above. Those
earlier numbers must not be used as evidence of a frontend regression.

### Host version and load comparisons

Opus ran 40 isolated combinations: five revisions (1.0.112, 1.0.114, 1.0.115,
installed `5950ea65`, investigation `9c0c40c6`) × four workloads × two repetitions.
Idle ACK medians were about **7–11 ms** across versions. Heavy concurrent streaming
could cause multi-second ACKs on every revision, with high shared-queue utilization.
The small sample count and workload variance do not establish a version regression.

A separate realistic reconnect fixture used 149 conversations, 2,134 messages and
about 272 MB of retained update history. Stale-cursor catch-up took 0.3 seconds and
full catch-up 2.7 seconds; another device's maximum ACK remained under 45 ms.
**Snapshot catch-up alone did not reproduce the production stall.**

With the installed Node and a real Gateway connected to a fake engine, isolated
Host-created-message → worker-input median was **39 ms**. Four durable file syncs
accounted for about 17 ms. This does not explain the production median of 583 ms.

Installed-frontend initial/reconnect HTTP capture showed network/profile/notification/
Agent Bus requests and selected-conversation task, queue, side and steer polling.
The fixture did not reveal an unbounded request fan-out across all conversations.
A bounded production metadata read found all 149 activity-index cursors current.

## Isolated preview-index A/B

Opus used the same temporary database before and after adding the candidate index:
6,722 synthetic messages, 913 historical link messages, no pending previews, and
about 272 MB of retained update history. The production database was not copied or
modified. The benchmark used a singular spelling for the index name; its columns
and predicate match the source repair.

| Measurement | Before index | After index |
| --- | ---: | ---: |
| Preview query median, 18 sweeps per phase | 9.0 ms | 0.4 ms |
| Preview query p95/max | 16.2 ms | 1.5 ms |
| Total preview-query execution | 166 ms | 9 ms |
| Session-validation queue wait p95 | 18.0 ms | 0.4 ms |
| Message ACK median, 30 sends per phase | 11.8 ms | 10.8 ms |
| Message ACK p95 | 45.8 ms | 53.7 ms |

The plan changed from `SCAN m` plus `USE TEMP B-TREE FOR ORDER BY` to scanning only
the partial index, with the membership lookup retained. Index creation took 13 ms
in this fixture. Both phases returned the same empty pending set, with no protocol
errors. The query work reduction is clear; the ACK tail did **not** improve in this
single synthetic run. This fixture's warm compact data does not reproduce the live
0.25–0.57-second scans, and these timings are not installed-device improvement claims.

## Validation and remaining boundaries

The new regression first failed on the missing query-plan index, then passed after
the repair. It checks the actual discovery query, no temporary ordering B-tree,
chronological/rowid order, complete/error eligibility, opt-out/null/completed/deleted/
Bot/nonmember exclusions, index maintenance after settlement/deletion, and index
creation when reopening an existing schema-22 database. Existing preview tests cover
schema-7 migration, cover authorization, forwarding, restart and no redispatch.

Focused suites: link previews, prompt queue, auth isolation and state backup.
The default run passed 83/84 tests; the existing slash-stop integration test exceeded
its five-second budget and its still-running cleanup then reported ENOTEMPTY.
The unchanged test passed with a 20-second per-test budget (7.25 seconds of test work);
the unmodified base also took 7.54 seconds and passed with that budget. No test timeout
or assertion was weakened in source. `npm run build` passed: 456 standalone modules, no legacy
transport/Feishu SDK in the dependency graph.

The Host/worker processes showed low scheduling priority (PRI 4), while the App had
PRI 46–54. Effective Host disk policy and its causal role were not established;
quiet OS samples did not capture a stall. A proposed QoS experiment was deferred
when the live preview-query trace supplied a concrete repair target. No temporary
launchd job or production scheduling change was made.

Installed/native Mac and physical phone click-to-ACK acceptance remains outstanding.
The partial index has **not** been installed into the live database. A release must
carry this source change into the bundled Host and standalone CLI; database open then
adds the index. Keep the distinction between repaired source, published package,
activated Host and physical-device validation.

The earlier eight-second episode and the remaining Host-to-worker delay may have
additional causes. Do not clear history, weaken durability or bypass revocation/
membership checks based on these measurements. The existing heavy-streaming load
cliff is separate from this bounded-query repair.

CLI impact: all entry points share `HubDatabase.open`, so desktop/mobile and standalone
CLI Hosts receive the same index. No CLI command, authentication or protocol changed.

## Local evidence

Local evidence directory: `send-latency-20261028/` (not committed).
Private runtime IDs, message contents and credentials are not committed here.

- `live-host-stages.json`, `live-host-stages-cleanup.json`: production method timing,
  automatic restoration and debugger closure; no message/SQL argument data.
- `detailed-live-*.json`, `detailed-read-probe.json`, `DETAILED-CAPTURE-SUMMARY.json`:
  subsequent 100-second Host/two-worker observation, dispatch-scan timing, worker
  persistence and restoration receipts. SQL method durations include scheduling
  and I/O; they are not pure SQLite CPU measurements.
- `opus-second-stages.md`, `opus-claim-fix-review.md`: independent delivery-path
  audit, tombstone-query semantics/plan and exact-patch review.
- `claim-regression-before.log`, `claim-focused-tests.log`, `claim-build.log`:
  failing-before plan guard, 65 passing focused cases and Host/CLI build.
- `opus-claim-fix-ab.jsonl`, `opus-claim-fix-ab-summary.md`, `claim-fix-ab-bench.mts`:
  corrected external-disk comparison of the exact dispatch-query repair.
  `opus-claim-fix-ab.invalid-labels.raw.jsonl` and its README preserve the invalid
  initial comparison and correction provenance; no mislabeled baseline is used.
- `inspector-selftest.json`: isolated instrumentation/cleanup verification.
- `native-route-readback.json`: CUA connection-panel observations.
- `opus-prod-queue-probe-2.json`: sequential 600-request samples; limitations above.
- `prod-overlap-probe.json`: bounded concurrent health/business-path measurements.
- `opus-prod-dispatch-by-origin.txt`, `opus-prod-dispatch-by-host.txt`: existing-record
  delivery interval distributions.
- `webkit-installed-client/**/send-latency.json`: valid 20-sample frontend runs.
- `post-reconnect-webkit/**/post-reconnect-requests.json`: synthetic request routes.
- `opus-matrix.jsonl`, `opus-matrix-summary.md`, `opus-reconnect.jsonl`: isolated runs.
- `opus-preview-index-ab.jsonl`: paired preview-index query-plan and latency evidence.
- `opus-global-ab.jsonl`, `opus-global-followup.md`, `global-ab-bench.mts`:
  20 same-source cadence controls and their independent interpretation; actual
  temporary-storage location and reader-emulation limits are recorded above.
- `opus-global-ab-gdrive.jsonl`: four external-disk confirmations, including
  the retained OFF-variant one-second ACK outlier.
- `global-lag-code-review.md`: shared HTTP/WebSocket queue consumers and the
  route-latency measurement boundary, checked against source and the prior trace.
- `prod-activity-coverage.json`: narrow read-only activity metadata.
- `send-latency.perf.spec.ts`, `prod-overlap-probe.mjs`, `reconnect-sync-bench.mts`,
  `worker-dispatch-bench.mts`: retained diagnostic scripts, not default CI tests.

No latency threshold was added to CI; machine-speed observations are not correctness
assertions. The diagnostic harness uses synthetic content and verifies complete stage
records. The report was checked against saved JSON and current source.
