# Incremental cross-device catch-up

A returning device used to rebuild activity metadata from every historical
message update, and then either replay each update or replace all cached
messages. A large early conversation also held up other conversations and
outgoing messages. This repair follows the [reproduction audit](sync-catchup-audit-2026-10-22.md).

## Behavior and compatibility

- `message-activity-sql.ts` maintains compact message activity and personal-hide
  metadata in the same SQLite transaction as journal insertion. Additive tables
  and triggers remain compatible with older writers; schema stays at 21.
  `message-activity.ts` rebuilds missing coverage in bounded, yielding batches.
  The first upgrade still has a one-time indexing cost; warm snapshots read the
  compact metadata. Historical event bodies and sequence numbers are retained.
- `snapshot.delta.v1` negotiates merge snapshots for a cached, usable cursor.
  Only changed messages and that user's new tombstones travel. The begin frame
  carries `mode: "merge"`; messages, read state, attention, drafts and cursor
  commit atomically after the matching end. A disconnected partial transfer
  leaves the committed cache intact. Fresh devices, invalid cursors, missing
  journal prefixes and older clients receive replacement snapshots.
- The new client uses snapshots above 64 missed events, avoiding hundreds of
  intermediate writes for a few changed replies. Legacy clients retain the
  previous 1,000-event threshold and strict frame shapes.
- Snapshot acknowledgements release a sliding window of up to 32 messages and
  1 MiB of logical message frames. A larger fragmented message travels alone.
  Final completion still waits for all receipt counts. The 10-second receipt
  timeout measures stalled progress; duplicate ACKs cannot extend it.
- `sync.conversations.v1` prioritizes the last selected conversation, followed by
  recent conversation creation order. Completed conversations resume live
  delivery and their durable outbox independently while other histories sync.
  Authentication, revocation, membership and idempotent send checks still apply.
  The client displays completed/total conversations while catch-up remains.
  Older clients keep the serial synchronization contract.

The journal remains authoritative. The compact tables are rebuildable derived
state; `conversation_activity.through_seq` denotes contiguous folded coverage.
Restore, missing-trigger writes and cold backfill are covered separately from
normal trigger-maintained updates. No retention/deletion policy is introduced.

## Controlled measurements

`scripts/benchmark-sync-catchup.mts` uses an isolated real Hub, signed WebSockets
and synthetic content. Processing and ACK delay are injected, not measured
physical-phone latency. Runs below use 400 already cached messages, 1,200 missed
updates producing four messages, and 5 ms of emulated processing per message.

| Injected ACK delay | Before: completion | After: completion | After: live reply during catch-up |
| --- | ---: | ---: | ---: |
| 0 ms | 2.48 s | 29 ms | 7 ms |
| 100 ms | 7.78 s | 133 ms | 7 ms |
| 250 ms | 15.42 s | 284 ms | 8 ms |

Transferred message count fell from 404 to 4, with logical history traffic from
about 0.54 MiB to 0.08 MiB. A legacy client under the new server still transfers
404 messages, but the sliding window completes the 250 ms case in 3.48 s.
The 900-update / 15 ms processing case now sends three final messages and applies
catch-up in 70 ms, compared with the prior 15.10 s event replay.
These are samples from this Mac, not production latency guarantees. The earlier
30-second production metadata query is a different measurement and is not added
to or divided by these transport timings.

An independent Opus 5.5 xhigh check used an isolated skeleton of the daily
backup: 58 conversations, 3,062 messages and 131,974 events, with every body
replaced by equal-length filler. The largest conversation had 67,258 events.
Its indexed activity read took 2.1–5.7 ms versus 7.7–19.0 seconds for the old
query. The first on-demand index build took 4.5–4.8 seconds; subsequent reads
avoid that cost. All 58 conversations matched the original activity query,
with zero discrepancies across two independent runs. These measurements retain
IO volume but simpler filler can parse faster than real content.

Cold backfill yields between bounded batches. In the skeleton test the maximum
observed transaction folded 442 events; the write probe's p99 was 23.3 ms during
on-demand backfill and 13.8 ms during background backfill. If coverage repair
fails, an exact journal-tail fallback still exists and may be slow. This repair
does not remove the journal's disk growth or maintenance/backup pauses.

## Verification and delivery boundary

Focused transport tests cover partial cumulative ACKs, byte bounds, impossible
receipts, selected-conversation priority, live replies and sends while another
snapshot stalls, legacy fallback and incremental negotiation. Activity tests
compare trigger, cold rebuild and uncovered-tail results with the original SQL
query, including personal deletion, read state, rollback, old writers and
concurrent writes. Browser coverage exercises atomic merge, interruption,
outbox preservation and cross-device messages, files and cards.
The visible history progress indicator is checked in the rendered page; merely
finding hidden text in the online connection icon is insufficient.

CLI impact: shared Hub behavior changes equally for headless and App-managed
hosts. The management client remains history-free; no new user CLI command is
needed. All five engine adapters publish through the same host journal and
transport. This change does not alter provider-specific execution or credentials.

This is a source repair, not an App/CLI release or installed-host replacement.
Physical phone, native desktop and real-network acceptance remain separate from
browser and simulated-network results. A release must package the matching host
and client revisions; older installed clients do not acquire merge support from
a source commit.
