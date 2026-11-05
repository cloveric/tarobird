# Bounded message update replay history

## Revised requirements and boundaries

The storage report identifies redundant full `message.updated` snapshots, not
large user messages. Bound this replay history by age, payload bytes and count;
never apply these quotas to canonical messages, attachments, read markers,
personal deletion records, request/delivery idempotency or group state. Preserve
public run details under their existing, independent policy. Do not assume that
a small database after manual cleanup proves the growth problem is fixed.

Only updates with an existing canonical message are eligible. Retain each
conversation's journal head so sequence allocation stays monotonic. Unknown or
unrecoverable rows are protected, as are other event kinds such as reactions
which do not yet have a complete canonical projection. This is consequently a
limit on reclaimable update history, not a hard quota on the whole database.
The minimum retained current-state checkpoints grow with real conversations;
corrupt/uncovered state is reported/protected rather than deleted to meet a cap.

Sparse deletion must atomically advance a durable replay floor with accounting
and event deletion. Clients whose cursor is below that floor must resynchronize via an exact
snapshot, never skip a gap or declare catch-up complete. New and
legacy snapshot clients receive full replacement. Delta-capable clients may
receive an exact merge across the recorded floor only when the compact activity
index is fully covered, all changed messages have canonical rows, and personal
hide records are retained. Unknown gaps still require full replacement. Check
the floor again on every replay page, including after the initial handshake.
Snapshots freeze a WAL read view while writes and maintenance continue. A new
snapshot resets per-connection streaming delta bases. Compact activity must be
fully covered before retirement and must never be rebuilt destructively from
an already truncated journal.

Physical file shrinkage is separate from logical deletion. New databases use
incremental auto-vacuum. Existing databases keep their format until an explicit
offline maintenance operation; neither opening the App nor a backup preference
change starts a blocking full vacuum. Retain each user's backup switch/days and
the existing default. Production migration, restarts, installation and releases
remain separate operator steps.

## Implementation

- `event-history-sql.ts`: small per-update byte metadata and transactional
  counters; durable per-conversation floor. Triggers cover committed writes.
- `event-history.ts`: resumable backfill outside the writer queue, bounded
  retirement transactions, canonical-row/activity coverage checks and yields.
- `store.ts` / `server.ts`: floor-aware replay planning, page-race recovery,
  full replacement for expired cursors, per-conversation delta-base reset.
- `message-activity.ts`: fail closed if compact metadata is missing or behind
  the reclaimed floor; do not fabricate historical order/unread transitions.
- `maintenance.ts` / `cli.ts`: independent one-second history pressure checks,
  also before daily maintenance/backup. Slow backup readers do not monopolize
  the cleanup scheduler. Shutdown awaits both paths.
- `storage-space.ts`: small incremental vacuum batches and passive checkpoint;
  explicit offline conversion uses SQLite's atomic VACUUM, without renaming a
  database/WAL pair. Insufficient disk or a busy checkpoint refuses conversion.

The canonical message and every live event are still persisted before publish.
This iteration deliberately does not throttle text persistence or replace the
journal with a new delta-only format: doing so would add crash/replay/version
semantics unrelated to bounding retained history. Write amplification remains
an optimization opportunity; retained history no longer grows indefinitely
under a supported, healthy collector whose throughput keeps up with writes.

## Configuration and compatibility

`config.json` accepts an optional `eventHistory` object shared by App-managed and
headless Hosts:

```json
{
  "eventHistory": {
    "retentionDays": 7,
    "maxBytes": 268435456,
    "maxRows": 50000
  }
}
```

A row is eligible once old enough **or** either quota is exceeded. Defaults give
recent reconnects a replay window while capping large streamed snapshots; the
byte ceiling handles large replies and the count ceiling handles tiny ones.
Validation allows 1–365 days, 1 MiB–1 TiB and 128–10,000,000 rows. These are replay
policy settings, independent of the default one-day automatic backup policy.
Normal config changes take effect on the next separately authorized Host start.

Limits are Host-wide maintenance targets, not per-conversation or admission limits: incoming messages are not
rejected to meet a history quota. Between one-second passes there can be a
burst; initialization, index repair, an exceptionally large single event,
protected checkpoints and I/O failure can delay convergence. Each writer turn
retires at most 32 events / 4 MiB of payload (one larger event is allowed), and
a pass yields after its time budget. The byte metric is UTF-8 payload bytes,
not an assertion about SQLite page/index/WAL overhead.

Schema **22** fences older Hosts which would ignore a sparse replay floor.
Use a matching App-bundled Host and standalone CLI on eventual release. A Host
downgrade requires the existing backup/restore procedure, not reopening schema
22 with old code. Snapshot-capable old clients can recover normally without a
new frame format; delta-only clients below the floor receive an explicit update
requirement. Long-offline clients without snapshot-delta capability may spend more
network/time downloading a complete current snapshot; modern clients retain
exact changed-message catch-up when coverage proves it safe. No current conversation content is expired.

## Offline space conversion

The matching CLI provides read-only diagnostics while running. Conversion
requires the owner to separately authorize and perform a clean stop (always
supply the existing state path):

```sh
tarobot hub storage --state-dir /path/to/existing-host
tarobot hub compact --state-dir /path/to/existing-host
```

`storage` reports physical pages and history accounting readiness; counters with
`ready: 0` are incomplete while migration backfill is running.

The existing offline compatibility check and process instance lock apply; a
running Host is refused. `compact` checks integrity and conservatively requires
twice the logical database file size plus 64 MiB available on its filesystem,
and a database-sized reserve plus 64 MiB on SQLite's selected temporary volume.
These conservative limits follow [SQLite VACUUM space guidance](https://www.sqlite.org/lang_vacuum.html)
and account for [temporary-file placement](https://www.sqlite.org/tempfiles.html).
Run ordinary history maintenance to convergence first: compact itself is a
format/physical-space operation and does not discard logical history. It
checkpoints, enables incremental auto-vacuum and vacuums in SQLite's own
transaction, then rechecks integrity. It does not change backup preferences or
delete exports to make room. If space is insufficient, free unrelated space or
plan a separately reviewed migration; do not bypass the guard. On interruption,
SQLite recovers the previous committed database or the completed new image at
next open; the operation can be retried. Do not remove a live WAL/SHM manually.

Running incremental reclamation moves at most 128 free pages per call and checkpoints after actual work, at most once every 30 seconds. A passive
checkpoint does not wait for readers; the journal size limit permits truncation
on later safe WAL resets. An active snapshot reader can delay file/WAL
truncation. Huge existing files require the explicit conversion first; logical
retirement alone already makes free pages reusable and reduces compact backups.

## Reproduction and validation

`tests/hub-event-history.test.ts` covers quota convergence, age expiration,
canonical messages/activity/reads, hidden messages, group attachments,
idempotency, unknown/protected rows, sparse boundaries, concurrent snapshots,
backfill restarts, transaction rollback, a real killed writer, backup on/off,
legacy-format conversion and insufficient-space refusal. Real WebSocket tests
in `hub-server.test.ts` exercise new/long-offline clients, replay-page races,
updates during a paused snapshot, version-base reset and unsupported clients.

Run the controlled benchmark with a temporary directory on an adequately sized
scratch volume; its fixture database and attachment are removed in `finally`:

```sh
TMPDIR=/path/to/scratch node_modules/.bin/tsx scripts/benchmark-event-history.mts /path/to/report.json
```

The local baseline used one 46,411-byte message and 1,500 updates: update payloads
47,448,395 bytes, database 49,532,928 bytes, compact backup 49,524,736 bytes.
Deleting obsolete rows left the database at 49,532,928 bytes with 11,859 free
4 KiB pages. This independently reproduces the reported mechanism; the owner's
previous 6.1 GB production database was not inspected or changed.

The candidate benchmark uses 1,800 updates, a real synthetic attachment, a 1 MiB
history budget and a legacy non-auto-vacuum database. The downscaled policy stresses repeated retirement cheaply; a second run uses
the actual default 256 MiB policy and 7,000 updates. Small fixtures do
not predict production 6 GB vacuum duration or every filesystem's latency.


### Review dispositions

Opus independently confirmed dense cursor requirements, non-reuse of journal
heads, atomic floors/deletes, activity coverage and backup independence. Its
catch-up performance finding led to exact snapshot deltas across known floors;
its maintenance findings led to candidate scans on separate readers, bounded
in-lock rechecks, less frequent checkpoints, temporary-volume space checks and
read-only storage diagnostics.

The suggested alternate encoding of intermediate updates as empty
`message.deleted` events was not adopted. It can preserve current consumers but
would make compaction depend on a deletion-frame compatibility convention and
would still need a second mechanism to bound row count. The explicit schema-22
floor has a clear downgrade cost, documented above. No minimum-age exemption
is added under sustained capacity pressure, because it could defeat the storage
bound. Activity corruption after reclamation is not silently repaired with
fabricated unread/order metadata: exact sync fails with non-retryable `history_metadata_unavailable`
(409), existing rows remain intact, and an intact backup or separately reviewed
repair is required. The error names the affected conversation and is audited
with its ID. The socket stays authenticated. Current clients continue sending
and receiving in healthy conversations; the failed conversation receives no
completion marker or live events and its outbox stays pending. Global
`sync.complete` is deliberately withheld: existing clients would otherwise
release every pending outbox. This leaves a partial sync progress indication
and delays preferred-route switching until repair/reconnect. Old clients
without per-conversation sync keep all sending/live updates blocked, with an
explicit error instead of a reconnect loop. This is a corruption boundary, not
a normal reconnect path. Other failures still use existing error handling.


## Measured results (2026-10-25/26, isolated local SQLite fixtures)

Sizes below are binary MiB (1,048,576 bytes), except where exact bytes are shown.
These are one-machine measurements, not production latency guarantees.

| Measurement | 1 MiB stress budget | Actual 256 MiB default budget |
| --- | ---: | ---: |
| Streamed updates | 1,800 | 7,000 |
| Update payload before retirement | 68.971 | 268.228 |
| Update payload after retirement | 0.307 | 255.967 |
| Database before / after logical retirement | 71.543 / 71.543 | 275.738 / 275.738 |
| Database after offline conversion | 1.160 | 263.332 |
| Compact backup after retirement | 1.156 | 263.008 |
| Retirement wall time | 231.3 ms | 324.7 ms |
| Offline conversion wall time | 13.6 ms | 2292.4 ms |
| Sampled database + WAL/SHM + backup peak | 75.458 | 804.152 |

Both runs then added five rounds of 200 updates with maintenance. Every measured
round converged within its configured byte budget; canonical messages, compact
activity, attachment bytes and integrity checks were unchanged by retirement.
The default-budget rounds ended at 267,438,458–268,407,555 payload bytes, below
268,435,456. The age and row thresholds are tested independently in unit tests;
7 days is a maximum age for eligible rows, not a guaranteed seven-day replay
window when the byte/count pressure limit is reached.

Peak sampling polls the named database/WAL/SHM/snapshot files every 20 ms; it
**excludes SQLite's private temporary VACUUM files** and can miss brief peaks.
The compact operation therefore uses conservative free-space guards rather than
this measured peak. Test fixtures, attachments and generated backup databases
were removed in `finally`; scripts and JSON/log evidence remain outside the
repository. A separate 40-update, 1 MiB-per-update sample compared the unchanged
baseline and candidate: median write 54.75 vs 52.23 ms, p95 69.11 vs 68.68 ms.
It showed no regression in that sample, not proof of a speedup.

Repeat the real-default run with:

```sh
TMPDIR=/path/to/scratch node_modules/.bin/tsx scripts/benchmark-event-history.mts /path/to/report.json --default-policy
```

### Future and unverified boundaries

- Current chat content, attachments, group state, message identity and retry
  deduplication have no new retention limit. Real user data still needs disk.
- Retired intermediate versions cannot serve as a permanent edit-history or
  time-travel API. Such a future feature needs its own explicit canonical
  version store and retention policy; current public process records keep their
  separate existing policy.
- No delta-only persistence or throttling was introduced. The latest canonical
  message remains durable before publication; reducing per-update write volume
  is a separate optimization.
- Tested: independent fixture schema migration, insufficient-space refusal,
  held-Host lock refusal, incremental page reclamation, concurrent WAL snapshot
  readers/writers and a real process killed before retention-transaction commit.
  VACUUM power-loss behavior relies on SQLite's documented atomic recovery;
  forced power loss during physical conversion was not simulated.
- Not measured: production-size 6 GB conversion, sustained weeks of load,
  disk/controller failure, Windows filesystem behavior or physical phone/network
  round trips. No production database was read, migrated, compacted or restarted;
  no App/CLI was installed or released by this change.


### Final review and checks

Actual Opus 5.5 xhigh independently reviewed the design and candidate, reproduced
sync races and damaged-metadata behavior over WebSocket, then independently
reran the final 82 focused tests. Its last review found no blocking issue.
Accepted fixes include exact delta catch-up across retained floors, bounded
writer work, read-only diagnostics, separate temporary-volume space checks and
isolation of a damaged conversation. A low-priority audit concern remains:
repeated damaged-conversation reconnects produce one diagnostic audit entry per
conversation/connection in the existing bounded trusted partition. Old-client
error handling and nonstandard direct group controls retain their existing
limitations; this change is not a general damaged-database recovery UI.

Host/standalone build and client build pass. The client build retains the existing
nonfatal Capacitor Keyboard static/dynamic import warning. The final
complete suite passed **6,776 tests across 500 files, with 5 conditional skips**
in 437.82 seconds. The focused set also passes 82 tests, including real socket
and client outbox isolation.
Initial verification also exposed stale schema-version fixtures (updated from
21 to 22) and two unrelated app-server startup timing failures; both timing
cases passed isolated reruns without adapter changes, and the subsequent full
suite above passed. No failed test was removed or converted into a skip.
