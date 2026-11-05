# Attachment download recovery

2026-10-03. Chat file downloads now retain completed 8 MiB ranges while a
connection recovers or selects a backup route. An explicit download clicked
during reconnection waits for the route to recover. The file card shows progress,
recovery state and an independent cancel button. Opening a file uses the same
verified bytes. Desktop and phone browser contexts download independently.

The Hub authenticates every request, checks conversation membership and session
trust, and keeps the existing in-flight device-revocation cancellation. A single
byte range returns 206, Content-Range and a SHA-256 ETag. Invalid or unsatisfiable
ranges return 416; a mismatching If-Range returns the full entity. The client
refuses that full entity after a partial download, instead of appending it.
Private responses remain no-store; allowed cross-origin routes expose the range
validators and permit the corresponding request headers.

The client pins the original size, MIME and ETag; validates every returned range
and body length; and verifies SHA-256 before export or cache. Interrupted chunks
are retried from their start, while complete chunks are retained. Permission,
revocation, changed metadata and hash failures stop the transfer. Transient
network failures retry with bounded recovery waits and request timeouts. The connection's
transfer count prevents an idle switch back from interrupting an active download.

Image/audio loads share an in-flight request across rerenders. Explicit file
actions have their own cancellation. Existing fully verified cache limits are unchanged.
Older Hubs that ignore Range retain their one-shot download behavior at offset
zero, including streamed responses without Content-Length. A present malformed
ETag is refused. Missing ETag does not gain resume or checksum guarantees from
the new client alone.

## Limits

2026-10-05: completed 8 MiB ranges now also survive reload or page closure in
IndexedDB. Clicking the file again loads and hashes the committed prefix, then
requests the remainder with the original If-Range validator. The last chunk is
never persisted: a new invocation must make a fresh authorized Hub request before
returning bytes. Missing chunks restart from zero; corruption or changed metadata
fails verification and clears that attempt. Nothing exports a partial file.

The journal is local to the device/browser profile, host and pairing (including
the device public key). It is **not encrypted at rest by this feature** and does
not store anything on a relay VPS. It retains at most eight partial files and
512 MiB per host, separate from the verified attachment cache. Disk-backed file
cards lower that host's aggregate journal budget to 256 MiB to leave room for
scratch assembly; an older larger prefix is trimmed atomically before replay
without refreshing its expiry. Beyond the retained prefix, the remaining bytes
are downloaded again after reopening. Files of 120 MiB keep their full eligible
prefix under this budget. When storage
estimates are available, writes leave at least half the origin quota (and at
least 32 MiB) for messages, drafts and other hosts. An actual quota exception
discards this attempt's prefix and continues in the download buffer. Entries with no committed
progress for 24 hours expire on the next connection startup or checkpoint
operation, not on a background timer; merely loading a prefix does not extend it.
Completion, permanent denial or integrity failure removes the attempt. Cancellation,
temporary disconnection and page closure preserve its complete chunks. The cancel
status reports when progress was retained. Offline downloads wait for an authenticated
connection before loading the prefix into memory. Device
revocation purges partial journals while retaining the existing verified offline
history policy; local reset/host removal purges both stores and fences old handles.
Concurrent writes compare attempt revision and offset; quota/eviction failure falls
back to the verified download buffer. Browser storage eviction can still discard
a prefix. No bytes are downloaded automatically after reopening.

This is not an OS background download service. Physical app process termination,
OS storage pressure, iOS/Android lifecycle and native restart still need target-device
acceptance. File-card downloads now use the temporary-file path below where
supported; automatic image/audio loads and PDF rendering still have separate
memory costs. This change does not establish a bounded native-memory claim.

Local Chromium and WebKit acceptance uses a real isolated Hub, real HTTP proxy
fault injection and separate desktop/phone browser contexts. It is not physical
phone, cellular, public VPS or native save-dialog acceptance. No relay deployment
or fleet restart is part of this change.

## Verification

- `tests/hub-download.test.ts`: exact HTTP bytes/ranges/validators, malformed
  ranges, membership and revoked-device refusal.
- Existing `hub-request-revocation` covers active stream cancellation; `hub-server`
  covers shared attachment storage, upload/restart and authorization.
- `client/e2e/download-validation.spec.ts`: retry only an incomplete chunk,
  invalid ranges, changed size/ETag, digest mismatch, 200 after partial data,
  revoked permission, aborted connection epochs, token/session expiry, old-Hub
  compatibility, cancellation while offline, persisted-prefix corruption/missing
  chunks, metadata changes, authorization failure and quota fallback.
- `client/e2e/download-checkpoints.spec.ts`: real IndexedDB reopen, host/pairing
  isolation, reset/revocation fencing, compare-and-swap writes, byte/count/TTL
  eviction, atomic failed writes and additive version 5 migration.
- `client/e2e/downloads.spec.ts`: 120 MiB interrupted after its first complete
  range, automatic backup route, independent phone cancellation/retry, delayed
  idle switchback, offline-started phone download, active PWA service workers,
  actual browser saves and two complete SHA-256 matches. Separate 120 MiB cases
  reload the desktop page or close/reopen the phone page in the same browser
  profile, resume from 8 MiB, save the exact file and verify journal cleanup.
  A real HTTP proxy injects the fault even when a Service Worker owns the request.

Actual Opus 5.5 xhigh reviewed this change; findings and fixes are recorded in
the review disposition（本地材料：`evidence/resumable-downloads-opus55-2026-10-03.md`）.

Final run details and review disposition are recorded in
the evidence receipt（本地材料：`evidence/resumable-downloads-2026-10-03.json`）.

2026-10-04 follow-up: [desktop file-save integrity](desktop-export-2026-10-04.md)
fixes native partial-write handling after download verification. Download hashes
alone did not protect against a short write during export. SDK/IPC fault
injection now checks saved bytes; native save-dialog acceptance remains open.


## Temporary download files (2026-10-05)

Explicit file-card open/save actions spill above 16 MiB into OPFS. The result is
still a Blob, backed by a private file, so native save/share reads it in the existing
1 MiB slices. A source lease holds its bytes until every preview/save consumer
finishes. Closing or unmounting the preview does not interrupt a pending native
save. Whole-body responses from older Hubs also stream into this buffer; a failed
response resets its scratch bytes and hash before retrying.

Scratch files have random identifiers, no attachment-ID lookup and no automatic
reuse: resumed bytes still come from the pairing-scoped, freshly authorized
journal. Full-file SHA verification happens before the source is exposed. Cancel,
denied access, bad metadata/hash and failed writes remove this scratch file. A
temporary-storage error preserves a valid journal, fails with an actionable
message, and does not silently start another full-memory transfer.

Small files and unavailable OPFS/Web Locks keep the prior Blob implementation.
Private/older WebViews can expose OPFS but reject its initialization; the fallback
only happens before any bytes are written to it. Tests use persistent profiles to
exercise actual storage in Chromium and WebKit, and separately fault-inject that
compatibility path.

A Web Lock protects each active scratch directory across tabs. Every startup,
including the unpaired screen and reset recovery, and a new large transfer sweep
unlocked abandoned scratch files. Another window's active file is preserved.
Native save/share releases
the OPFS source after its own copy completes; mobile share-copy retention remains
the existing platform policy.

Browser file actions negotiate the current Service Worker before choosing OPFS.
An absent/older worker keeps the old Blob path from the start. A capable worker
receives only the already-verified Blob, uses a shared file lock, and reads 1 MiB
slices into a one-use same-origin download response. Completion releases the
source; it does not leave successive 512 MiB handoff copies for 24 hours. The
filename is encoded in Content-Disposition, never used as an OPFS path. A random
one-use URL plus client checks isolates downloads; errors and stale navigation
URLs cannot replace the app with HTML. A worker change or idle timeout fails with
a retryable message. A browser that blocks repeated automatic downloads can
report cancellation; the UI does not claim a saved file.

Source owners hold their lease until the browser transfer settles, including the
initial handshake. Worker locks also protect a transfer when its originating tab
closes; cleanup of an orphan waits for the lock and the next sweep. This is not a
promise of unlimited background execution: browser worker lifetime limits, OS
pressure, disk exhaustion and older WebViews remain platform constraints. The
worker copies the last slice into its response before reporting handoff, which
is still distinct from a confirmed write to the user's chosen disk location.

Local scratch files and partial journals are not encrypted at rest by this
feature. Nothing here changes the relay VPS storage policy. Origin quota and
browser eviction still apply. Aggregate journal budgets are per host; several
hosts and concurrent large previews still share the browser origin's capacity.
Automatic image/audio decoding and PDF rendering have separate memory costs.
