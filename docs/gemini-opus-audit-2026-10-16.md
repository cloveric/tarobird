# Gemini / Opus review and confirmed repairs — 2026-10-16

## Scope and evidence boundary

The requested baseline is `071fe74f1607b76bdabdcd8d1b83505abf2193dc`.
Gemini ran as `gemini-4-argon-high`, effort `high`, against an isolated tracked
source snapshot. All 2,540 tracked files were byte-checked against that commit
after its runs; none changed. Only read tools were observed. No production Bot,
host database, credentials or paired-device identities were used for fault tests.

**The requested full Gemini audit did not finish.** Its account returned
`RESOURCE_EXHAUSTED` / “Individual quota reached” during the run, with a roughly
seven-day reset. No model substitution or paid quota change was made.

| Gemini scope | Files observed in read-tool events | Outcome |
| --- | ---: | --- |
| Runtime / five engines / state / bus | 199 | Quota error; no final report |
| Hub / Gateway / Relay / protocol | 155 | Final report returned |
| Client / desktop / mobile | 47 | Quota error; no final report |
| CLI / operations / packaging / optional adapters | 4 | Quota error; no final report |

File counts indicate files touched by read tools, **not full-line coverage or
successful verification**. The complete report also contained incorrect source
references. Its claims of “100% coverage” and globally complete protections are
not adopted. Gemini output was treated only as hypotheses.

The primary reviewer reproduced failures using synthetic data and real isolated
SQLite/file helpers, then actual `claude-opus-5-5[1m]` with effort `xhigh`
independently read the code. Opus returned `claude-opus-5-5` as its canonical model.
Only jointly validated findings were implemented. Opus also performed a bounded
review of runtime/client/CLI areas left unfinished by Gemini; this does not
retroactively complete the Gemini audit.

## Decisions and repairs

| Finding | Disposition and actual reach |
| --- | --- |
| R01: database startup cleanup | Confirmed. `HubDatabase.open` leaked its connection when chmod or the initial PRAGMA failed. `HubStore.open` had the same cleanup gap on owner seeding. Both now close on rejection and preserve the original error if cleanup also fails. Corrupt database bytes are retained. |
| R02: free-text Authorization redaction | Confirmed with synthetic Basic and Instance headers. The old rule removed the scheme but left its credential. Complete single-credential headers, quoted/escaped values and interrupted quoted diagnostics are now scrubbed; neighboring header lines and existing Bearer behavior are retained. No actual credential disclosure was established. |
| R03: lifecycle metadata redaction | Confirmed helper-contract gap; existing production call sites did not establish a real secret leak. Replaced serialize/redact/reparse and its unsafe fallback with the bounded recursive helper already used by audit/timeline logs. Recovery counters remain intact. |
| H-1: repeated import of a forwarded attachment | Confirmed latent helper defect. Reuse now checks completion before uploading chunks. `importForBot` currently has test/capture callers, not the claimed production upload route. Production Gateway upload already had the completion check. Return types and authorization remain unchanged. |
| G-1: empty single-file delivery | Confirmed normal-tool error classification bug. Empty files now fail locally as `empty_file`, unpublished, with an instruction to write content first; they no longer produce a misleading retryable HTTP upload failure. |
| G-1: file changes during reading | Accepted consistency hardening: single-file delivery now checks preflight size and post-read size/mtime, matching batch behavior. This is a change detector, not a filesystem snapshot or guarantee against timestamp-preserving writes. |
| R04: stale architecture documentation | Confirmed. Corrected standalone boot, App/Gateway delivery, SQLite ownership and the optional legacy adapter map. Preserved real integrations, stored IDs and compatibility names. |
| R05: stderr chunk-boundary redaction | Independently confirmed by both reviewers using synthetic split headers. Bot stderr now buffers complete lines before redaction, omits oversize lines whole, preserves split UTF-8, and flushes only when stderr closes. Per-worker pending bytes cannot contaminate its replacement. |
| R06: applying the selected CLI revision stops the host before rejecting | Confirmed by a failing real staging/preflight test. The read-only preflight now rejects before drain/stop, while the locked activation retains its concurrent-change guard. |
| R07: failed offline update loses enabled login intent | Confirmed in the CLI failure path. Capture the frozen selection even for an offline host; restore previously enabled autostart only if the pointer and runtime digest remain unchanged, holding the selection writer mutex through enable. Never start an originally offline host, roll back a database, or enable a previously disabled service. Report enable failures. |

## Rejected report claims

- **H-2, missing Hub startup cleanup:** not supported by current code. Binding
  validation precedes store opening; startup has a cleanup catch; the network
  timer belongs to Hub, is unref'ed and registered for disposal. The reported
  `PrivateNetwork` constructor timer and `initialize()` do not exist.
- **S-1, temporary Google credentials file permissions:** the described function,
  temporary JSON file and filesystem writes do not exist in the cited source.
- **S-2, replaced avatar unlink warnings:** avatars are SQLite blobs; the cited
  `unlinkSync` path and function do not exist.
- Rejected the suggested H-1 return of nonexistent `getForOwner` and G-1 nested
  tool-result envelope, which would have changed a return type or broken stored
  receipt parsing. Repairs follow the actual code contracts.

## Compatibility and acceptance limits

These are shared host/core fixes, so desktop-managed and headless CLI hosts keep
the same behavior. Existing phone/desktop APIs, schemas, host identity, Bot
ownership, network membership and engine capability gates are unchanged. No new
CLI command is needed. No model response or uncertain side effect is replayed.

This audit does not prove the cause of the previously reported Mac mini incident.
No live host or engine was restarted. No Windows/mobile native acceptance or
installer release is implied by source tests. Existing installed applications
are not updated by this source commit.

Log redaction is defense in depth, not a guarantee that arbitrary provider output
contains no secrets. This revision covers Basic/Instance/Bearer and existing
secret-key patterns, not every possible authentication grammar (for example
multi-parameter Digest headers). An unfinished stderr line is hidden until stream
closure; a process-exit log can omit that last incomplete line because process
exit may precede stdio closure. This deliberate boundary avoids publishing a
credential suffix without its preceding header. Completed diagnostic lines and
crash/retry counters remain available.

The bounded Opus runtime/client review found no additional confirmed regressions
in the sampled five-engine ownership/terminal paths, queue UI, connection
generations or window activation. It did **not** exhaust the large adapters,
mobile-native code or Windows service behavior. Browser handshake latency and
protocol-invalid AGY frames remain unproven hypotheses, not changes to make
without reproduction.

## Final review and verification

Opus independently reviewed the implemented patch. It found a test-portability
issue: fault injection compared a lexical temp path with the canonical file path.
The fixture now uses `realpath`, and was rerun with an actual symlinked temp root.
A review-only diff artifact also had absolute paths for new files; that artifact
was regenerated with relative paths. Delivery uses the Git commit, not that diff.
Additional review follow-up covers interrupted/escaped auth text and serializes
both online runtime recovery and offline-autostart recovery against concurrent
runtime-selection writes, with a bounded 45-second mutex wait. Opus confirmed
the lock order and found no blocking issue; its final small hardening suggestions
(trailing escape, escaped proxy/secret keys and the wait bound) were implemented
and covered by the final regression run.

The multi-step CLI update is not a single transaction with separate manual
service enable/disable commands. A concurrent manual intent change can still
race the update's original intent snapshot (also true on its existing success
path); operators should serialize these actions. The new recovery mutex protects
the runtime selection, not arbitrary OS service operations.

- Final `scripts/pre-complete-hook.sh`: standalone build passed (342 modules,
  no legacy transport / Feishu SDK); 298 test files passed, **3,942 tests passed,
  1 conditional test skipped**.
- Focused fault suites verified actual SQLite initialization rejection, preserved
  corrupt bytes, seeded-store failure cleanup, forwarded byte identity, no
  publication for empty/changing files, and all split points of synthetic log
  credentials. The original repeated-update preflight test failed before the fix.
- The symlink-temp regression passed all three file-read cases.
- Legacy TypeScript build passed; all **611 tests across five compatibility suites** passed.
- Documentation relative links and `git diff --check` passed.
- All fault injections used disposable state and fake credentials. No native
  phone/Windows verification, production Bot queries, service restart or package
  publication was performed as acceptance evidence.
