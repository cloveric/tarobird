# 1.0.113 pre-release audit

Scope: the changes after published 1.0.112 (`9b37b50c`) through `2a4e23bc`,
followed by the corrections in this release. App 1.0.113 and Host/standalone CLI
0.1.458 use protocol 1 and Hub schema 22 (read/migrate versions 1–22).

Root reviewed the source and ran independent regressions. Opus 5.5 xhigh
(`claude-opus-5-5[1m]`) separately audited event history and sync, Claude input
ownership, the UI changes, and branding. Root owned all product edits; Opus
replayed the failures and reviewed the resulting changes. Separate Opus
conversations prepared release wrappers without writing product source.

## Confirmed defects repaired

| Finding | Correction | Evidence |
| --- | --- | --- |
| A failure reclaiming update history prevented that tick's due backup and other cleanup | Isolate the best-effort history error; keep its next retry and the existing backup policy | New enabled/disabled-backup regressions failed before the fix; focused suite 61 passed, independent suite 111 passed |
| A folded Claude input could reach terminal command state before its native turn ended; stopping then waited forever for a second terminal frame | Retain every command's ownership, but wait only for nonterminal commands in both stop-fence branches | Two new ordering regressions failed before the fix; following input now proceeds without killing the worker |
| A reasonless abort of an unconsumed review input could kill the process still serving the previous background review | Withdraw that queued input through native control regardless of the abort reason; preserve the existing behavior for consumed foreground input | Both abort-reason regressions failed before the fix; background output retains its old owner and the process stays alive |
| Gateway waited 15 seconds for admission while its Hub RPC expired at 10 seconds | Return an uncertain receipt after 8 seconds, with transport headroom; keep late progress and idempotency | Deadline regression failed before the fix; no automatic retry or false model receipt |

The combined Claude adapter regressions passed 272 tests. Gateway/core roundtrip
checks passed 15 tests. Opus independently re-ran its original reproductions
(7 passed) and additional protocol reordering cases (8 asserted cases passed;
2 observations, not assertions). Its focused Claude suite passed 447 tests.

The WebKit collection now includes the background-review input and sidebar
wordmark tests. No UI layout, default theme, font sizing, or platform sizing
boundary was changed by these audit fixes.

## Update history and migration

Canonical messages, attachments, reads, hidden state, deliveries and the activity
index are independent of reclaimable replay snapshots. The retention defaults
are 7 days, 256 MiB and 50,000 update rows; protected heads and uncovered index
records are not forcibly deleted to meet a quota. This is not a chat-history
limit. Configuration can override the retention policy.

Opus created a schema-21 fixture with the previously released source, migrated
it and passed 33 data/sequence/snapshot checks. Its synthetic stress fixture
reduced retained update payload from 72.3 MB to 0.32 MB; an explicit offline
compact reduced 18,315 pages to 297. These are isolated fixtures, not production
measurements or a promise of physical shrinkage on an existing live database.

The canonical-package upgrade verifier now seeds the real previous CLI package
with a group, attachment bytes, streaming edits, read/hidden state and an
idempotency key. It compares canonical tables, requires an exact merge across
the retirement floor, applies that merge to the old device state, and compares
it with a fresh snapshot. It also rejects a direct incremental request below
the floor, verifies attachment bytes and checks that the old Host refuses the
upgraded schema without modifying database bytes. The diagnostic package
rehearsal passed; the final canonical CLI must pass the same test before release.

Existing databases retain their physical allocation policy. This release does
not run production `hub compact`, change automatic-backup settings, or silently
open schema 22 with the old Host. The guarded local upgrade preserves its
one-time schema-21 recovery copy separately from automatic backups. Once the
new Host has written schema 22, a downgrade requires deliberate recovery from
the pre-upgrade copy; it is not an automatic in-place rollback.

## Verification boundaries

Before these audit corrections, the full suite passed 6,776 tests with 5
conditional skips. The final corrected source is rerun before freezing;
commit-bound receipts record its exact counts and build results.

Fresh browser regressions covered desktop and phone layouts: Chromium 76
passed, plus 2 background-review cases; WebKit 77 passed with 1 unsupported
forced-colors case skipped. Final wordmark and review-input runs are additional.
The final wordmark tests passed 4 cases in each browser. A final WebKit run
exposed a test synchronization gap: answer text appeared before Core turn
teardown and the next review capability refresh. The old target was correctly
rejected. The fixture now waits for the new review's status response; WebKit
passed all 6 desktop/phone cases across three repeats, and Chromium passed both
cases. Opus independently reviewed the synchronization and stale-target route.
Source icon verification checked 83 generated files. iOS release planning passed
6 tests, and the native audit runner passed 7 tests. Rust integration testing
requires generated desktop Host resources and runs after `desktop:prepare`.

Browser screenshots and scripted engine frames are not physical-device evidence.
The precise Claude terminal-frame/stop race was not reproduced against a live
CLI. Existing real-CLI evidence establishes the negotiated protocol, but two
synthetic deviations remain deliberately fail-closed: an interrupted result
without the expected input identity, and a successful cancel response without
its advertised terminal lifecycle. They do not justify guessing ownership,
resending input or force-killing background work.

Multi-GB production migration timing, power loss during offline compaction,
Windows-native installation, physical phone interaction and APNs/FCM end-to-end
delivery were not established by this source audit. Platform packaging,
publication readback and local installed-runtime acceptance are separate gates.
The final release record must report those results without turning any of these
unverified boundaries into a pass.

All fixtures and evidence live on the external build disk. No production
database was compacted, backup policy changed, or active model task stopped
during this audit. Headless CLI impact is included: the maintenance and Claude
fixes use shared Host code; visual-only changes have no separate CLI UI.
