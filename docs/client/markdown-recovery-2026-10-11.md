# Markdown formatting recovery — 2026-10-11

## User-visible problem and fix

A shared Markdown Worker error previously failed both its current request and
every waiting message. Unchanged history then stayed as escaped source text
until an edit or remount. The new regression reproduced this on the old source:
the untouched next message never regained formatting.

The scheduler now recreates the Worker once after an infrastructure failure,
preserves untouched queued messages, and moves the failed request to the tail
for one retry. At least two consecutive infrastructure failures open a shared circuit when
they include constructor failure or come from different owners:
new revisions and remounted history keep readable escaped text without starting
another Worker per row. A single owner is isolated after two execution failures
across revisions, even when healthy owners succeed between them. A fresh healthy
owner remains usable when the only failures came from that isolated document. A valid parser-error response affects only that message
and resets the infrastructure failure streak. Healthy replies also reset it.

After terminal failure, each affected message offers **恢复排版 / Restore
formatting**. This retries local rendering only. It does not resend the message,
change stored content, or request another Bot answer. Repeated clicks during
the same queued/current revision do not create duplicate requests or reset its
budget. Explicit retry can reopen the shared circuit; once a successful response
confirms recovery, other mounted circuit-blocked messages resume automatically.
Only their latest revisions are retained. Parser-rejected and isolated messages
are not included in this recovery table; disposal removes retained jobs.

Old-worker events, disposed owners and superseded revisions cannot replace
current content. Manual recovery clears stale displayed chunks while retaining
the latest plain text until parsing finishes. The output fingerprint cache can
still reuse unchanged trees. The retry button has a 44px target, translated
label and stable root focus with `preventScroll` when the button disappears.
The root receives temporary tabindex only for that action and removes it on blur.
Disposing an active owner cancels its parse without consuming a failure budget;
microtask admission coalesces mount/cleanup before starting more work.

## Verification

Evidence is in `evidence/markdown-recovery-20261011/`（本地材料：`evidence/markdown-recovery-20261011/`）.
Final related runs passed **67 distinct cases in Chromium and 67 in WebKit**.
This is a focused client regression, not the entire repository or native matrix.

The thirteen new Worker/component cases cover one-off error/timeout recovery,
untouched queue continuity, sustained platform failure, constructor failure,
streaming/remount circuit persistence, obsolete/disposed owners, late callbacks,
parser-size rejection isolation, retry coalescing, poison-owner isolation, bulk
recovery with updated/disposed/rejected jobs, active-owner cancellation, and latest-text/focus behavior
in desktop Chinese and phone-width dark English layouts. Existing lifecycle
cases retain held-digest, hash fallback, revision and asynchronous-rejection
coverage; they now assert bounded automatic and explicit recovery semantics.

Two additional cases use the actual built App and an isolated real Hub at
1360px/390px. After injected Worker-constructor failure they restore actual
Markdown, assert no `message.send`/`card.action`, and independently read back the
single unchanged stored message. They do not start real CLI sessions. Both
engines passed the two cases again after screenshot-only stabilization waited
for the existing theme transition. Reviewed screenshots are retained beside
the logs; these remain browser layouts, not physical-phone evidence.

`tested-source-initial63.json` and `tested-source-before-opus.json` preserve
the earlier 63-case inputs and screenshot stabilization. Opus then identified
additional defects; `opus-findings-before.log` reproduces both. Final corrections
are in `tested-source.json`, with new final browser/build logs. The initial
63-case and 18-case focused results are intermediate evidence, not approval of
the later source. Root and client builds passed; client build was repeated
after production corrections.

Separate Chromium checks ran after the concurrent browser regressions:

| Check | Observed result | Boundary |
| --- | --- | --- |
| 5,000-paragraph retained transport JSON | 0 strings / 0 bytes | Inspector GC, main renderer only |
| 5,000-line streaming, 10 tables, 10 formulas | Complete content and editable draft | Built App, synthetic local engine |
| Draft input | 5 ms | One local sample |
| Frame p95 / maximum | 16.8 / 33.4 ms | Browser frames |
| Long tasks | 0 observed | Excludes native/process/network work |

Measurements are in `measurements.json` and `memory-performance.log`. They do
not establish the native 200 MB RSS or 1.5-second cold-launch requirements.

## Review and failed-run disposition

Astra identified a real content regression in the first retry UI: clearing only
the failure flag briefly revealed an old parsed tree while newer content was
pending. Clearing visible chunks on retry fixed it; two explicit held-result
tests now prevent that regression. The scheduler review found no blocking issue.
Actual Opus 5.5 xhigh completed successfully and prompted the two reproduced
P2 corrections: poisonous owners blocking healthy updates, and manual recovery
restoring only 1/50 rows. Original review source hashes, result and disposition
are in the evidence directory. Astra separately reviewed the final corrections;
Opus was not represented as having reviewed a later source it had not seen.
The first immediate-disposal candidate caused StrictMode Worker churn; batching
admission into a microtask fixed the four failed focused assertions.

The baseline failure in `before.log` is the intended reproduction. Two initial
ordering failures were caused by StrictMode disposing the first fixture owner;
warming the owner made the queue-order assertion deterministic. A later
late-callback fixture had incorrectly shortened every held request timeout;
limiting the shortening to the dedicated timeout case fixed that fixture.
All earlier logs remain available and are not counted as final passes.

The final Astra review records two timing combinations not directly asserted:
changing/disposing deferred jobs after the recovery probe is already in flight,
and synchronous cross-owner actions inside delivery callbacks. No concrete
blocking race was found. The global/owner split can create three Workers when
a lone owner fails asynchronously twice and a new owner then fails; the two-
Worker bound applies to constructor failure or the tested mixed-owner failure
round, not every possible platform sequence.

The existing behavior where updates faster than parsing can delay rich output
until a current revision completes is unchanged. This work fixes recovery from
Worker failures; it does not change server data, model streaming or deployment.
Remaining review follow-ups include clearer non-retryable size-rejection text,
unprotected web-tab deployment version skew, and physical-phone timer suspension.
They are detailed in `opus-review-disposition.md` and not claimed fixed.
Native SDK/device, RSS/cold-start, notifications, production routes and release
acceptance remain open. No new ordinary native execution was attempted in this
batch; the earlier locked-Mac observation is historical.


## Verified development artifact

The r33 package receipt（本地材料：`evidence/macos-r33-2026-10-11.json`） verifies the final
review corrections and all r32 features in optimized arm64/x86_64 binaries.
Strict ad-hoc verification passed for the standalone and read-only-mounted
bundles; full bundle equality, DMG integrity, successful detach and exclusive
Downloads copy/hash passed. Tested production inputs stayed unchanged during
packaging. All 303 frontend resources match both phone shell copies; those
shells were not compiled with native SDKs or installed on devices.

`/Users/example/Downloads/TaroCub_1.0.0_universal-development_20261011-r33.dmg`

- Bytes: 17,073,355.
- SHA-256: `dbd444fef569b22a7cf5be0c4ceb844c95491b5607c5f07fc16fbfbfa460689e`.
- Not installed, notarized or published; matching Hub required.
- No new ordinary native UI, RSS/cold-launch or physical-phone acceptance.
