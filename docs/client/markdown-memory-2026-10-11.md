# Markdown retained-memory follow-up — 2026-10-11

## Problem and scope

`WorkerMarkdown` retained each cleaned HAST chunk twice: its parsed tree and the
full serialized transport JSON used for equality. `previous.current` and React
state share chunk objects; they were not two additional independent JSON copies.
A real Chromium heap snapshot reproduced 100 retained transport strings with
1,854,524 bytes of self size after rendering a synthetic 5,000-paragraph document.

The fixture has 343,890 source characters and deliberately exceeds the normal
single-message protocol budget. It is a renderer stress test, not a typical chat
memory estimate. Inspector GC/main-renderer heap excludes the parser worker,
WebView/native processes and peak allocation. The 200 MB native RSS gate remains
open. Current native UI access failed because the Mac was locked; see
evidence（本地材料：`evidence/markdown-memory-20261011/native-access.json`）.

## Implementation

The worker attaches a SHA-256 fingerprint to each serialized, cleaned output
chunk. The UI parses new chunks and retains only the fingerprint and tree;
unchanged trees still reuse the same chunk objects. Hashing the output of the
whole-document parser preserves distant reference-definition changes and the
existing Markdown safety rules. There is no worker-side persistent chunk cache.

Native WebCrypto is preferred, with the existing noble hash as a per-chunk
fallback when WebCrypto is missing or rejects the operation. At most eight
chunks encode/digest concurrently. The main-thread scheduler still has one
request in flight, one waiting revision per owner, revision/disposal fencing,
a 15-second request timeout and a 30-second idle-worker lifetime. An asynchronous
reply failure triggers normal worker error recovery. Failures leave escaped
plain text readable; a subsequent edit recreates the worker and restores rich
rendering.

A separate idea to tear down hidden workspace Markdown was rejected after
Astra verified that a zero-height virtualized viewport already unmounts its
message rows. Hidden workspace Message arrays were not changed in this batch.
The pre-existing virtualizer touchcancel/device-inertia boundary is unchanged.

## Measurements

Dedicated Chromium measurements, separate from the later parallel regression
runs, used the same input and tooling before and after the implementation:

| Measurement | Before | Final bounded implementation |
| --- | ---: | ---: |
| Retained transport JSON strings | 100 | 0 |
| Transport strings self size | 1,854,524 bytes | 0 bytes |
| Main-renderer used heap after inspector GC | 28,518,544 bytes | 26,649,616 bytes |
| Warm Worker median, 12 revisions | 74.4 ms | 73.1 ms |
| Warm Worker p95, 12 revisions | 103.7 ms | 99.2 ms |

The Worker profile uses a different 5,001-paragraph fixture (88,890 base source
characters, 101 output chunks), measuring actual request-to-response time after
warmup. It excludes scheduler queue delay and final DOM rendering. Twelve
samples do not establish a general speedup. The observed runs do not show a
material regression; full App streaming is checked separately. A first noble-
only candidate measured 81.6 ms median, and an unbounded native candidate
measured 76.5 ms; these intermediate logs are retained and are not the final
implementation.

The old code failed the new retained-JSON assertion as intended. Final code
passed the same assertion. Unicode fingerprint tests compare real worker output
with Node SHA-256 under native, missing and rejected WebCrypto and enforce the
eight-digest bound. Controlled digest/reply tests cover obsolete owners and
revisions, timeout, failed reply, safe fallback and subsequent recovery. Existing
Markdown tests also update a distant reference definition and verify the earlier
link changes.

## Evidence files

All logs and command/source receipts are in
`evidence/markdown-memory-20261011/`（本地材料：`evidence/markdown-memory-20261011/`）:

- `before.log`, `worker-before.log`, `performance-before.log`: baseline.
- `after.log`, `native-hash.log`: intermediate candidates, not final claims.
- `bounded.log`: 13 final-candidate Chromium focused tests and dedicated metrics.
- `source-before.json`, `tested-source.json`, `browser-command.json`: inputs.

## Final regression scope

The related 15-spec Chromium and WebKit runs each passed 51 cases. Astra then
identified a weakness in the original combined revision/disposal test: two
animation frames did not prove the digest was held, and disposal could mask a
broken revision check. The final lifecycle suite uses a Worker `digestHeld`
receipt and adds a separate same-owner revision test. It releases only the old
result, holds the newest result, verifies no stale callback, then releases the
newest and requires exactly one callback. Both engines passed all seven final
lifecycle cases (six strengthened/rerun cases plus one additional case), making
52 distinct related cases per engine. Production code remained unchanged.

The separate Chromium inspector case passed. The actual App streaming case also
passed: 5,000 lines, ten tables and ten formulas, draft input 6 ms, frame p95
16.8 ms, maximum frame 33.4 ms, zero observed long tasks. Baseline was 5 ms,
16.7 ms, 33.4 ms and zero long tasks respectively. These are controlled local
samples, not remote-network or physical-phone guarantees. Root and client builds
passed. Logs: `final-{chromium,webkit}.log`, `lifecycle-final-{chromium,webkit}.log`,
`performance-after.log`, `root-build.log`, `client-build.log`. Machine-readable
results are in `measurements.json`. Source receipts preserve the initial
51-case test snapshot and final seven-case test revision separately.

## Independent review

Astra reviewed the production candidate and found no blocking logic issue; the
test gap above was corrected. See `astra-final-review.md`. Actual Opus 5.5 xhigh
also completed a read-only final-source review without a blocking finding. Its
first, older synchronous-candidate request timed out and is not an approval.
The successful asynchronous-candidate result and model identity are recorded
separately in `opus-async-review.json` and its status/source files.

Opus identified that page errors alone do not catch Worker unhandled promise
rejections. The final test instrumentation forwards real Worker
`unhandledrejection` events and asserts none occur after recovery, retaining
receipts across worker recreation. The final seven-case suite passed again on
both engines (`lifecycle-rejection-{chromium,webkit}.log`). This strengthens
coverage without adding another distinct case or changing production code.
The review's type/build and production-worker questions are answered by the
successful client typecheck/build and the built-App streaming test respectively;
fault injection still uses the dev Worker. See `opus-review-disposition.md`.

Existing scheduler limitations remain: a stream faster than parsing can defer
rich-text updates until a current revision finishes; failure of the shared
worker leaves unchanged historical messages in escaped text until an edit or
remount. Neither behavior is newly introduced or claimed fixed here. No WebKit
heap, native RSS, worker peak-memory or physical-device claim is made.

Package verification is recorded separately below. A source/build pass does not
establish physical-phone, native RSS/cold-launch, notification or release
acceptance.


## Verified development artifact

The r32 package receipt（本地材料：`evidence/macos-r32-2026-10-11.json`） verifies optimized
arm64/x86_64 binaries, strict ad-hoc seals for both standalone and mounted
bundles, DMG integrity, read-only full-bundle equality, successful detach and
exclusive Downloads copy/hash. Production inputs stayed unchanged throughout
packaging and match the tested source. All 303 frontend resources match both
iOS/Android resource copies; those shells were not SDK-compiled or installed.

`/Users/example/Downloads/TaroCub_1.0.0_universal-development_20261011-r32.dmg`

- Bytes: 17,071,849.
- SHA-256: `78773ab19394727bfade6e913939d536bfad48b0dad455b2a0c4c3d37df28468`.
- Not installed, notarized or published; matching Hub required.
- Ordinary native UI/RSS/cold-start and physical-phone acceptance remain open.
