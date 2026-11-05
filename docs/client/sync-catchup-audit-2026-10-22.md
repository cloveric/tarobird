# Desktop / phone catch-up latency audit

The reported scenario is several hours of activity on one device, followed by
opening the other device. The confirmed bottlenecks are in history catch-up.
Normal live delivery and recovery of a large backlog must be measured separately.
The primary audit was cross-checked by the configured CC1 reviewer using
`claude-opus-5-5[1m]` with `xhigh` effort. The isolated Hub benchmark originated
in that independent review and its 100 ms ACK-delay case was rerun separately.

This audit changes the diagnostic benchmark and stale browser test fixtures.
It does **not** change the synchronization protocol or install an App update.

## Confirmed causes

### Repeated parsing of the entire historical event journal

`HubStore.snapshotFrames()` in `src/hub/store.ts` computes content order, content
timestamps and unread transitions from `events.payload_json`, using JSON
extraction and a window function over every historical message update. A stream
creates many durable updates for one final message. Every full snapshot repeats
this computation, including for messages the returning device already has.

The current conversation had 1,185 messages and about 72,450 journal events at
measurement time. Running the existing metadata query against a **read-only**
connection to the live Hub database took **29,971 ms**, returning 1,185 metadata
rows. Preliminary bounded probes exceeded eight seconds. No production row was
changed and no private message bodies were printed or copied to this report.
This is one host-side preparation measurement, not a measured phone round trip.
The review also measured 6.6–9.1 seconds on an earlier read-only backup of that
conversation (67,258 events / 1,117 messages). Snapshot preparation is sensitive
to journal size, disk/cache state and concurrent load; 30 seconds is an observed
sample, not a universal or minimum duration.

The journal retains full bodies for intermediate streaming updates and currently
has no event-retention pass. This increases historical scan work over time. It
must not be addressed by deleting arbitrary sequence numbers: current clients
require contiguous replay, and activity/unread reconstruction uses this journal.

The installed 1.0.97 host and audited main revision both contain the same metadata
query, 1,000-event snapshot threshold, eight-message receipt window and serial
conversation catch-up. Merely installing the existing 1.0.98 release would not
remove these mechanisms.

### Full snapshots and a stop-and-wait receipt window

`src/client-protocol/snapshot.ts` selects a snapshot when a conversation is more
than 1,000 events behind (or its cursor cannot be replayed). The snapshot includes
the whole conversation. In `src/hub/server.ts`, every eight unacknowledged snapshot
messages stop transmission until **all** sent messages have been acknowledged.
This bounds queued browser work but repeatedly pays the receipt round trip.

An isolated signed-WebSocket benchmark used 400 previously cached messages and
1,200 missed stream updates producing four additional messages. All 404 messages
were transferred again (about 0.54 MiB). Each received message was assigned a
simulated five-millisecond processing cost:

| Injected ACK delay | Ready to catch-up complete | New message in another conversation |
| --- | ---: | ---: |
| 0 ms | 2.48 s | 2.45 s |
| 100 ms | 7.78 s | 7.74 s |
| 250 ms | 15.42 s | 15.39 s |

The ACK delay is injected after processing; it models additional confirmation
latency, not an observed cellular RTT. These figures must not be added to the
live-database query measurement and presented as one device measurement.

### Other conversations and new messages wait for historical work

`HubStore.conversations()` returns conversations in creation order. The server
synchronizes them serially, retains live changes in `pendingSync` until catch-up
finishes, and then sends `sync.complete`. The client also serializes received
frames and waits for `sync.complete` before flushing its durable outgoing queue.
A large early conversation can therefore delay a different currently viewed
conversation and newly sent messages. The benchmark above reproduces this
blocking with a new message in a separate conversation.

### Smaller gaps replay intermediate updates one by one

A gap of 900 updates replays 900 frames, even when they represent only a few
replies. With no injected processing delay, the isolated benchmark completed in
96 ms. With five milliseconds per frame, completion took 5.13 s; with fifteen
milliseconds per frame, it took 15.10 s. The client calls `ClientCache.apply()` in
one receive chain and commits each event/cursor transaction separately. Coalesced
UI notifications reduce renders but do not remove those writes.

### Connection status becomes online before history is ready

`client/src/connection.ts` publishes `status: "online"` on authenticated `ready`.
History replay/snapshots can still be pending. The user can therefore see an
online connection while the conversation is incomplete or a queued send waits.
An explicit catch-up state/progress would make this delay understandable, but
would not itself fix the work above.

## Secondary paths and evidence limits

- Foreground recovery keeps a healthy socket and pings it; remote/native paths
  use a 15-second stale timeout. A silent stale connection can add a delay before
  catch-up starts. This is a separate recovery case, not the primary explanation
  for the measured historical query.
- The host and its relay were online when checked. Historical relay failures do
  not establish the network conditions during the user's particular incident.
- Synthetic real-`ClientCache` browser runs on the Mac did not reproduce steadily
  accumulating lag at ten live updates per second: aggregate lag was around
  3–4 ms, while accepting a 1,117-message snapshot took about 0.43 s in Chromium
  and 1.03 s in WebKit. These are desktop browser results, not phone performance.
- No evidence from this audit attributes the backlog to the visualization tool,
  model reasoning, or a generic memory leak. A physical phone trace is still
  needed to apportion its real network, storage and rendering time.

## Repair order

1. Maintain compact activity metadata transactionally instead of reparsing all
   historical message bodies for every snapshot. Any derived index must preserve
   unread transitions, content timestamps, rollback compatibility and deletion
   semantics, and rebuild old gaps in bounded batches without monopolizing the
   Hub write queue.
2. Introduce bounded incremental catch-up for changed messages and independent
   conversation progress. Preserve cursor consistency, snapshot atomicity,
   revocation checks, user-scoped deletion and outgoing-message deduplication;
   do not simply discard intermediate event sequence numbers.
3. Replace the drain-all eight-frame receipt cycle with a bounded sliding window
   that also caps bytes. Verify both high-latency paths and slow/paused receivers.
4. Expose authentic catch-up progress, then measure foreground recovery on a
   physical phone. Avoid aggressive reconnects that restart a valid catch-up.

These repairs remain to be implemented and verified. This audit does not claim
that synchronization delay has been fixed.

## Reproduction and regression coverage

`scripts/benchmark-sync-catchup.mts` starts a disposable Hub, pairs an isolated
signed client, creates only synthetic data, and emits JSON timing records. Set
`TMPDIR` to an approved external temporary directory, then run:

```sh
npx tsx scripts/benchmark-sync-catchup.mts
npx tsx scripts/benchmark-sync-catchup.mts snapshot-1200-proc5-rtt100
```

The `procMs` and `ackDelayMs` columns are deliberately injected parameters. The
benchmark exercises the real server but emulates the client receive cost.

`client/e2e/cross-device.spec.ts` passed all four scenarios in both Chromium and
WebKit after two obsolete assumptions were corrected: ordinary group messages
must explicitly select their reply Bot, and canonical message comparison must
exclude client-only activity metadata. Coverage includes two separately paired
clients, bidirectional messages/files, closed-client catch-up, card decisions,
read state and remote renames. These fixes do not change production behavior.

CLI impact: diagnostics only. No host API, command contract, message format,
credentials, database state, installed App or running service was changed.
