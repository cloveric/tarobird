# Design and PPT second review, 2026-11-03

This review covers the canvas/PPT revisions since the installed release baseline
`f22db812`, through `2ad067b`, plus the corrective changes below. Motion is outside
scope. Publication, installation and version changes remain on hold until the
owner gives a new explicit release instruction.

Root reviewed the code and exercised production sessions, real local sockets and
browser editor journeys. A separate CC1 conversation ran actual
`claude-opus-5-5`; Root independently read the execution transcript rather than
inferring the model from configuration. Opus reviewed a clean HEAD export first,
then a frozen candidate, and prepared the owner-share recovery change separately.
The receipts and red/green evidence are in
`/Volumes/gdrive/taro-tmp.noindex/baoyu-second-review-20261103/`.

## Corrected behavior

- **Freshness and joining:** subscribe before the first snapshot, preserve change
  notifications received during a fetch, and refuse a snapshot after revocation
  or disconnect. When typing retires a file between manifest and content reads,
  retry the manifest at most three times; this never replays a write.
- **Images and efficiency:** prepare newly shared image URLs before delivering
  the editor's external-change event. Request only unknown embedded assets and
  changed design-system assets. Ordinary DB edits with no unknown image reference
  deliver their event without two additional document reads.
- **Private per-user data:** shared changes and history no longer expose another
  user's private paths/hashes. Content-hash reuse obeys the same visibility rule
  as list/fetch; knowing a private hash cannot copy its bytes into a public file.
  Public reuse, a user's own private reuse and the owner's other-device access
  remain supported.
- **Large results:** legal comments, history differences and DB collections travel
  as ordered 256 KiB JSON fragments once they exceed the 512 KiB inline limit.
  UTF-8 is decoded only after the whole result arrives. Each response is bounded
  at 64 MiB, with 128 MiB aggregate raw transfer budgets in the Host and client
  (both incoming assembly and outgoing transfers waiting on a recipient);
  malformed, reordered and over-budget fragments fail explicitly. Dropping a
  request discards its partial bytes. Outgoing steps have a 25-second no-progress
  timeout and a 50-second
  whole-result cap. Only a stalled peer is terminated; reaching the overall cap
  releases the reservation while preserving a progressing App connection.
  Permission is checked immediately before every fragment, including the last.
  The existing 1 MiB socket ceiling is retained. This sharing
  protocol is an unreleased feature absent from the installed release baseline.
- **Definite outcomes:** source 4xx/5xx call replies retain their status/body,
  including DB conflict `current` data. Successful no-ops and replayed receipts
  still obtain admission. Unadmitted successful writes remain uncertain. A
  source-local connection failure does not retire the participant's healthy join.
  After a successful mutating result, source/Host transfer failures and client
  assembly failures are uncertain, including a long comment saved before a role
  change, share closure or exhausted transfer budget.
- **Owner recovery:** both share lists expose an owner-only End share action,
  including this device's orphaned records, without requiring a live design
  session. Confirmation preserves Cancel; grantees retain Open only. Closing
  elsewhere retires the source, including when the original open reply is still
  delayed. Closed offline sources can start a new share. See
  [owner-share recovery](baoyu-share-owner-end-2026-11-03.md).
- **Older Hosts:** unsupported Design comments/history/restore are reported as
  `not_executed`, with the update instruction, before any command reaches the Host.

The existing skill selection remains: “用 Design 做 PPT” uses the engine's native
presentation skill; explicit Baoyu/宝玉/clear 宝育 PPT uses `baoyu-ppt`. A selected
Baoyu tab does not capture a new ordinary PPT request.

## Entry points and evidence boundaries

The Host continues to enforce the same identity, membership, role and exact
source-window checks. Bot and headless CLI content operations keep the existing
Workbench API and command syntax; the old-Host classification fix is shared.
App sharing controls concern device-local documents, not an alternative CLI file
or authentication authority. The standalone Host and App client are built from
this source together; this checkpoint does not publish either artifact.

Local source tests, loopback sockets, Chromium with IndexedDB and isolated model
review are distinct evidence. They do not establish an installed-App upgrade,
physical phone behavior, a real wide-area network benchmark, or real-model
execution of the presentation authoring skills. Earlier acceptance remains
recorded in [the first audit](baoyu-canvas-ppt-audit-2026-11-03.md) and
[the routing check](baoyu-ppt-routing-2026-11-03.md); those counts are not added to
this review's results.

## Validation for this checkpoint

| Boundary | Result |
| --- | --- |
| Host/protocol/Gateway/skill regressions | 17 files / 119 tests passed; `host-last-tests.log` |
| Client canvas/PPT/session/connection/resource regressions | 16 files / 126 tests passed; `client-reviewed-tests.log` |
| Large-case default runner check | 10 tests passed without a global timeout override; the two expensive integration cases have their own 30-second test limit. Production deadlines and assertions were not relaxed; `heavy-default-tests.log` |
| Real signed loopback sockets | Legal DB listing over 1 MiB, large file transfer, authors and normal membership/role flows passed; every measured frame remained below 1 MiB |
| Real editor and IndexedDB | 4 Chromium scenarios passed: remote image display, ordinary DB event with no extra asset reads, actual download/fullscreen, installed design-system resource save/reload; `asset-reviewed.log` |
| Final production browser build | 3 Chromium journeys passed with the real local Hub, signed sockets and separate contexts: same-owner editing/reconnect/leave, granted member read-only/revoke, offline deletion then owner recovery from an empty Workbench; `sharing-reviewed.log` and JSON report |
| Production builds | Standalone Host 490 modules and client translation/type/resource/build checks passed; `host-last-build.log`, `client-reviewed-build.log` |

These are 245 source regression cases and 7 browser journeys; the focused and
default-runner repeats above are not added to that total. The final Host-only
slow-reader adjustment was checked by the full Host set, including real signed
sockets, and the final Host build. Client production bytes did not change after
the browser build and journeys.

Opus's final review closed committed-write outcome handling, stalled-result
budget release and close-during-open recovery. Its follow-up also closed the
slow-reader note: progress is distinguished from an idle socket, and the total
cap frees the buffer without disconnecting a progressing App. It independently
ran the stalled/slow-reader and committed-write regressions and an additional
progress-then-stall probe. The final reviewed file hashes match this tree;
`closure-review.md` records no remaining concrete defect in those reviewed bytes.
Root independently verified all 527 assistant execution records in that review
session as `claude-opus-5-5`; no subagents were used by Opus.

The final confirmation screenshot was inspected: the orphan appears under this
source device's shares, with its offline state, explicit End share confirmation
and working Cancel. Failed preliminary browser attempts were harness mistakes
(the shutdown method, exact offline label and portal menu locator), not product
failures; their logs were retained and the corrected full journey passed.

The default runner's 5-second limit was exceeded by two large fixtures while
history scanning and Chromium were running. Opus reproduced the same result on
both compared snapshots; with lower load both took roughly 2–3 seconds. This is
separate from the product's enforced transport deadline. Opus also tried the
repository-wide TypeScript 5.9 check for its isolated owner-recovery patch and
found the same 164 pre-existing errors on pristine HEAD; it was not represented
as a clean repository-wide type check.
