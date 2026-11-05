# Client storage performance, 2026-10-11

Two source fixes address avoidable allocations found after the ordinary r28
Mac App exceeded the 200 MB resident-memory budget. They preserve complete
history, unsent attachments and reconnect behavior. This batch is newer than
the r29 development package; that DMG does not contain these changes.

## Changes

`ClientCache.activeMessages()` previously cloned every cached message and then
filtered for pending/streaming IDs. Every registered host runs this during
startup, and snapshot completion also calls it. IndexedDB schema 8 adds a
`messages.status` index, transactionally backfilled during upgrade. Recovery
reads only matching primary keys, with both statuses in one read transaction.
Normal event updates, snapshot replacements and reset continue to update the
index through the existing object-store writes.
The first v7-to-v8 open must backfill the index before the cache is available;
this one-time history-sized migration work is separate from steady-state reads.

Draft attachment encoding previously kept a fulfilled `File.arrayBuffer()`
promise in a WeakMap. A retained draft File therefore also retained the full
ArrayBuffer. Reads now share a promise only while it is pending, removing it
on success and failure. The bytes still reach durable draft storage, and
identity checks, revision comparison and stale-send protection are unchanged.
Later saves may reread a File, trading a long-lived duplicate for additional
I/O and transient allocation. Further optimization must retain those safety
properties rather than silently drop unsent content.

## Evidence

The new `storage-memory` browser suite first reproduced both old behaviors:
10,000 historical message values entered JavaScript during active-ID recovery,
and a completed attachment read remained cached. Both assertions failed before
the fixes; the migration-preservation assertion passed. After the fixes:

- A cache with 10,000 messages and 20,480,000 bytes of synthetic text returns the
  exact two active IDs with **zero message-value records read**. IndexedDB still
  accesses its index on disk; this is not a claim of zero total I/O.
- A version 7 database upgrades while preserving complete history, queued
  outgoing messages, text drafts and exact attachment bytes. Later completion
  and streaming updates change the active-ID result correctly.
- The **same 32 MiB File** saved into three conversations shares concurrent
  reads, releases completed-read caching, restores exact bytes and retries a
  failed read. A later injected `NotReadableError` preserves the previously
  saved revision and bytes. This does not measure garbage collection or a
  96 MiB RSS drop.
- Opus identified an unobserved transaction rejection if a key read failed.
  A real IDB abort reproduced the extra unhandled `AbortError`. Including
  `tx.done` in the same `Promise.all` fixes it, with the fault case now passing.

Chromium and WebKit each passed 32 relevant cases covering the above, persistent
drafts, delayed voice completion, host switching, local reset, streamed events
and interrupted snapshots. Root and client builds passed. Logs are under
`evidence/storage-performance-20261011`（本地材料：`evidence/storage-performance-20261011`）.
Astra's independent read-only review found no blocking concurrency, migration
or CAS issue and noted the later-save I/O tradeoff. Actual Opus 5.5 xhigh completed
its source review; its finding, independent reproduction, fix and compatibility
checks are in `opus-review-disposition.json` in the same evidence directory.
The original storage source reconstructed by reversing only this batch exactly
matches r29's source manifest at schema 7. No other production cache opener pins
that database to an older version; the host registry uses a separate database.

## Open performance work

The [ordinary native measurement](native-product-2026-10-11.md) remains
270–277 MiB summed RSS for r28. These fixes have not been measured in a rebuilt
ordinary native App; the Mac was locked during this follow-up. The original
200 MB and 1.5-second budgets remain open. Browser timings, Apple footprint and
main-process-only RSS do not replace those gates.

Further source review found full-conversation rereads on cache revisions,
retained hidden-host message views and rich Markdown tree duplication. The
[next source batch](message-refresh-performance-2026-10-11.md) coalesces overlapping
history refreshes and adds failure recovery. Its dual-host tests did not reproduce
the proposed preview leak: existing teardown already closes PDF/image previews
and releases workers. Retained-view and Markdown allocation work still requires
history anchors, delayed input and background transfers to remain intact. No
history or draft eviction was introduced in either batch.
