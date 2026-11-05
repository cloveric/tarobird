# Official restore and conversation synchronization

The official offline `backup` / `restore` flow previously preserved event
sequence numbers without identifying their timeline. After restoring an older
backup, fresh events could pass a phone or desktop cache's old cursor. The Hub
then sent an incremental merge that omitted the first fresh messages and left
messages from the discarded timeline visible.

`restoreHubState` now creates a fresh UUID in `meta.sync_lineage` only after all
copied state and attachments have passed validation, and before removing the
incomplete-restore marker. Restoring a backup of previously restored state
rotates the UUID again. Taking a backup never changes the live UUID. This is an
additive metadata key, with no Hub schema or protocol version change.

Clients negotiating `sync.lineage.v1` send the lineage committed with each
conversation's cursor. A restored Hub sends a replacement snapshot when that
lineage does not match, including empty conversations and cursors below, equal
to or above the new head. The cache commits messages, cursor and lineage in the
same IndexedDB transaction; interrupted staging changes none of them. The next
connection can resume ordinary event or incremental synchronization.

Each socket captures its own per-conversation tokens when sending hello.
Incoming event writes and snapshot starts compare the captured token inside
the cache transaction. An older socket draining queued frames cannot write
messages from a discarded timeline after another window commits the restored
one. Competing replacement snapshots also compare lineage transitions even
when the current cursor happens to equal the discarded timeline's cursor.
Drafts and the outbox remain intact.

Compatibility:

- Hubs without a restore marker keep their existing synchronization behavior.
- Older snapshot-capable clients receive the original strict snapshot shape.
  On a restored Hub each reconnect requires one full replacement per
  conversation because those clients cannot persist a lineage receipt.
- Delta-only clients cannot safely remove ghost messages. After restoration
  they receive `client_update_required_after_restore` with an update
  explanation, rather than a false synchronization-complete result.
- New clients can still connect to older Hosts and read their delta snapshots.
  They retain the captured token when the authenticated Host does not advertise
  lineage support; those older Hosts cannot provide this restore guarantee.
- CLI restore uses the same function. CLI management connections do not cache
  conversation history and do not incur replacement snapshots. Automatic
  backup and update-recovery paths create copies; they do not automatically
  restore a database. Manual replacement of database files is outside this fix.

Evidence uses isolated temporary state, signed WebSocket clients and Chromium /
Playwright WebKit with actual IndexedDB. It does not establish physical iPhone
or real Tailscale acceptance. The regression uses the official backup and
restore functions, not a raw database copy. Its baseline sent `mode: merge`
after the new timeline passed the old cursor. The fixed implementation returns
the complete restored message set and removes discarded rows. Browser
regressions cover interrupted staging, independent conversations, repeated
restores, queued stale events, late snapshot starts, concurrent heads, normal
reconnect, continuing live messages and the older Host protocol.
