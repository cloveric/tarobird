# File download memory and lifecycle — 2026-10-05

Explicit file-card downloads now assemble larger files into private origin
storage and stream verified bytes to the browser download handler. This follows
the durable resume work and the completed Opus visual refinement. No stylesheet
or visual asset changed in this milestone.

## Behavior and review

Above 16 MiB, supported clients spill assembly into OPFS. Source leases preserve
files used by previews and concurrent saves. Web Locks protect both other
windows and Service Worker readers; deletion waits for the final reader.
Every bootstrap, including unpaired and reset-recovery screens, sweeps abandoned
scratch without deleting active files. Scratch is not reused as a trusted cache.

The disk path uses a 256 MiB aggregate per-host resume budget. Larger old prefixes
are trimmed atomically without extending expiry. A valid prefix survives a
scratch-storage failure. Once disk writes have begun, failure does not silently
retry the entire file in memory. Files beyond the retained prefix may download
that suffix again after reopening. Automatic image/audio loads retain their
existing path.

A one-use same-origin Service Worker response reads 1 MiB slices with backpressure.
It exposes no Hub credential and creates no external link. Whole-file verification
precedes export. The UI distinguishes transfer, browser handoff and confirmed
native save. A stale download navigation returns 204 and keeps the app in place.
Unsupported/older workers select the original memory path before assembly.
Worker changes and stalled handoffs fail with a retryable message.

Actual Claude Opus 5.5 xhigh completed three source reviews. Its findings led to
valid-checkpoint preservation, pre-write fallback, aggregate quota enforcement,
shared-lock export, stale-navigation protection, filename normalization and
bounded progress traffic. The parent implemented and tested these changes.
Opus did not perform native or physical-device acceptance.
Review and disposition（本地材料：`evidence/download-memory-opus55-2026-10-05.json`）.

## File acceptance

- Chromium 65 and WebKit 54 main cases passed. They include 120 MiB real downloads
  across route failure, cancellation, desktop reload, phone browser reopen and
  concurrent tabs, with exact saved-file hashes.
- After the startup sweep and filename checks, 16 Chromium and 16 WebKit affected
  cases passed. These overlap the main suites. On each engine, 512 MiB saved twice
  after a separate 256 MiB journal; both saved lengths/hashes and the Chinese filename
  match, with zero scratch directories after each export.
- Tests exercise real persistent OPFS/IndexedDB, source leases, orphan cleanup,
  disk-error preservation, pre-write fallback, legacy200 retry, quota bounds,
  pairing/reset fencing, one-use replay rejection and cross-client isolation.
- Root gate: 236 files, 3,792 passed, 1 skipped; production build passed. Client
  translation/type check/build passed. Focused Hub suite: 3 files / 20 passes.
- One WebKit attempt failed while writing Playwright trace artifacts because
  the internal disk ran out of space. Re-running the same assertions with trace
  output on the external disk passed. No assertion or timeout was weakened.

## Memory measurements

macOS 26.6.2, 16 GiB RAM; isolated Chromium 153.0.8010.12, loopback Hub and
incompressible random bytes. Each case saves the real file and verifies its full
SHA-256 and length. Instrumented storage writes prove the complete file passed
through OPFS: 15 writes for 120 MiB, 64 writes for 512 MiB, one close each.

The table is peak **summed process-tree RSS**, in MiB. Shared pages can be counted
more than once; it is not unique physical footprint or native app memory. One
final trial per case is shown, with the previous final trial retained in the
evidence. Normal timing and allocator variability apply.

| Browser profile | File MiB | Before peak MiB | After peak MiB | Change | Download seconds before → after |
|---|---:|---:|---:|---:|---:|
| private | 120 | 1072.2 | 1113.0 | +3.8% | 2.27 → 2.25 |
| private | 512 | 2476.6 | 2057.4 | -16.9% | 10.26 → 8.87 |
| persistent | 120 | 881.8 | 773.3 | -12.3% | 2.40 → 2.51 |
| persistent | 512 | 1359.2 | 1005.6 | -26.0% | 10.77 → 9.39 |

Compare within each profile only. Private mode uses a remote Playwright browser
connection, while persistent mode uses a local context. RSS sampling covers the
download and Playwright saveAs copy; download time ends before saveAs and final
hash verification. The r19 persistent baseline's 303 frontend assets were hash
matched against its package receipt; the earlier private baseline uses the same
pre-change download implementation.

RSS does not improve uniformly. Worker/rendering allocations, post-transfer
retention and forced-GC diagnostics are reported rather than hidden behind the
total peak:

| Profile / file MiB | Phase | Renderer peak MiB before → after | Process-tree peak MiB before → after |
|---|---|---:|---:|
| private / 120 | download | 471.0 → 480.7 | 1072.2 → 1113.0 |
| private / 120 | after-download | 433.6 → 449.5 | 1050.0 → 946.1 |
| private / 120 | diagnostic-forced-gc | 422.3 → 423.7 | 917.3 → 918.6 |
| private / 512 | download | 589.5 → 650.9 | 2476.6 → 2057.4 |
| private / 512 | after-download | 464.0 → 574.4 | 1319.7 → 1403.4 |
| private / 512 | diagnostic-forced-gc | 463.4 → 572.9 | 1319.2 → 1401.8 |
| persistent / 120 | download | 544.6 → 528.5 | 881.8 → 773.3 |
| persistent / 120 | after-download | 503.5 → 528.5 | 847.8 → 774.9 |
| persistent / 120 | diagnostic-forced-gc | 492.3 → 487.4 | 715.4 → 715.7 |
| persistent / 512 | download | 643.0 → 706.2 | 1359.2 → 1005.6 |
| persistent / 512 | after-download | 600.0 → 680.0 | 1293.4 → 916.2 |
| persistent / 512 | diagnostic-forced-gc | 487.5 → 651.1 | 711.0 → 885.0 |

The 30-second post-transfer phase and 3-second page-GC diagnostic do not establish
the plan's desktop resident-memory target below 200 MB. Page GC is diagnostic,
not a production memory-management mechanism. Native WebView, real phone
lifecycle, OS termination, image/audio decoding and PDF rendering remain separate
acceptance items. Multiple hosts and large concurrent previews share the origin
quota. Worker lifetime limits and browser download policy still apply.

Local scratch and partial journals are not encrypted at rest by this feature.
This change does not alter relay VPS storage behavior or production deployment.

Measurements, source hashes and logs（本地材料：`evidence/download-memory-2026-10-05.json`）.
[Download semantics and limits](resumable-downloads.md).

## Delivery

The r21 universal development DMG includes the accepted startup cleanup, file
transfer implementation and previously accepted design. Both architectures,
strict ad-hoc signatures, mounted bundle and delivery hash are verified in the
package receipt（本地材料：`evidence/macos-r21-2026-10-05.json`）. Its 303 frontend resources
also match the iOS/Android resource copies; those copies are not compiled mobile
apps. Native runtime acceptance remains open; the desktop session was still
locked at the final read-only check. No installed app, production
service or fleet was replaced, and this is not a completed v1.0 release claim.
