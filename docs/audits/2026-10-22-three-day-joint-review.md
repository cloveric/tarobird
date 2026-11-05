# Three-day joint audit — 20–22 October 2026

Codex and an independently running Claude Opus 5.5 (`claude-opus-5-5[1m]`,
`xhigh`) reviewed all changes between `2ecce957a693ddc1793be10d8a96dda6c105311e`
and `d9c87fb63ab6d97c9cb2a291d399cd090ace827e`: 55 commits and 727 changed files.
The window starts at 2026-10-20 00:00 Asia/Shanghai. It includes merged branches,
not only first-parent commits. The large deletion count mainly reflects retired
chat transports and the migration of their retained regression tests.

Opus audited a frozen `git archive` snapshot, independently reproduced the main
findings and reviewed the repair work. It did not edit the shared checkout.
Tests used isolated Hubs, browser profiles, temporary files and cloud doubles;
no production App/Host restart, credential inspection, paid transcription or
physical-device network acceptance was performed.

## Coverage

| Area | Changes examined and validation surfaces |
| --- | --- |
| Groups and delegation | Ordinary, sequential, independent and parallel modes; recipient freezing; mentions; topic inheritance; sealed results; pause/end/retry; membership; self-message grants; schema 19/20→21; backups; shared CLI/API authorization. |
| Interactive visuals | Five-engine tool/directive delivery, frozen tool versions, publication idempotency, host setting and permissions, prompt overhead, local theme/filter/expand/history, viewport lifecycle, relay bounds, mobile bridge guards, CSP/WebRTC and CPU isolation. |
| Voice | M4A decoding, local/cloud/automatic policy, duration thresholds, settings CAS/receipts, adapter setup, audio extraction from video, cancellation, partial/empty results, timeouts, parallel and discussion fan-out. |
| Messages and review | Editable pending queue, claim/edit races, Alt+Enter, streaming and Markdown workers, question feedback, scoped run diffs, review notes, outbox recovery, attachment download/cache/blob lifetimes. |
| Network and runtime | LAN/Tailscale/VPS route trust, merge provenance, stable route selection, network intent, local identity and recovery, idle-only update lifecycle, retirement graph and test mapping, standalone assets and release version/schema relationship. |
| UI and documentation | Desktop model/effort target and accessibility, ADHD exclusion, pinned folders, archive header, schedule picker, response wording, voice settings and homepage captures. |

Independent checks included a 20,000-case route-merge fuzz run and resolution of
all 1,702 retained test-map entries. They do not substitute for real tailnet,
Windows, Android or iOS acceptance.

## Repairs

| Confirmed issue | Repair and evidence |
| --- | --- |
| The same group recording was transcribed/uploaded for every recipient and discussion turn. | A private Host cache coordinates Worker processes with the existing file mutex. Gateway tests reduce three parallel Bots and six discussion turns to one transcription; a real three-child-process test also performs one operation. Only successful, nonempty results are cached. Scope includes conversation, attachment, actual-byte SHA-256 and effective routing/configuration. Waiter cancellation cannot cancel the owner. |
| Typed `@display name` was ignored, so parallel mode could broadcast a directed request; the model control could target a different Bot. | Shared member-name/ID resolution drives send, steer and composer controls. Matching supports case, punctuation and ASCII/full-width @. The full-width case was confirmed in the final independent review and repaired in the follow-up. Unknown/ambiguous mentions without an explicit picker selection preserve the draft and require correction. Code and email text do not select recipients. |
| A queue head claimed during editing produced a generic revision conflict and an impossible “check and save” instruction. | The Host reports `queue_already_dispatched` before queue revision mismatch. The UI retains the draft and explains that it can be copied; it does not invite saving an uneditable item. The claim/edit regression verifies the original dispatched content is unchanged. |
| A failed widget kept its handlers/timers running behind the error notice. | Three errors within two seconds retire the guest; the text summary remains readable and retry is explicit. A single optional setup/click/hover error preserves the usable report. Expansion alone does not restart it. Replacement HTML can recover. Opus rejected the first, overly aggressive single-error implementation; the final burst threshold and incidental-error scenarios are regression-tested. It does not interrupt a CPU loop. |
| `connect-src 'none'` did not block WebRTC/STUN traffic. | The trusted bootstrap makes WebRTC constructors non-writable and non-configurable before guest code. A loopback UDP regression checks initial viewing and reload, and attempts to restore the constructor. Ordinary HTTP/network, opaque-origin and navigation regressions remain. DNS-prefetch and every possible browser side channel are not claimed covered. |
| Chart-related coding requests appended the full widget recipe to compatibility-engine history. | Implementation-only requests omit that recipe. Explicit mixed requests to fix code and show a chart still receive it. Native tools continue to fetch design instructions on demand. This adds no standing prompt text. |
| An occasional control/mutex timeout was reported as an update failure and could disconnect a healthy local Host. | Known control timeouts/closed probes and mutex waits become `runtime_waiting`. Recovery failure retains an already authenticated connection only when the Host is running with the same key and required directory-proof capability. Identity changes, stopped Hosts and missing proof still fence the connection. |
| UI and homepage facts lagged behind implementation. | Four group modes are documented and recaptured. Capture assertions use mode IDs and wait for final avatar images. Model/effort accessible names include values. Remaining visible “回报” wording, English singular rounds and “All local” naming are corrected. Cloud-mode upload scope and managed-setting precedence are documented. |
| Standalone verification did not require the widget relay asset. | The package verifier now requires `client/dist/widget-sandbox.html`. This is a verifier change, not a completed packaging/release claim. |

The transcript cache stores only text, never API keys or uploaded audio, in
`HOST/media-transcripts` (0700 directory, 0600 files). Read-time validation rejects
unsafe, malformed, expired, future-dated and oversized entries. A result expires
after 24 hours; pruning on subsequent use targets 128 recent completed results
and runs at most once per minute per process. This is a bounded-retention target,
not a hard disk quota: bursts can temporarily exceed it, and an idle Host does
not run a background deletion timer. The cache is excluded from Host backup/restore. Worker-crash recovery is tested
by killing only an isolated test owner and verifying another process acquires
its slot. If the private cache directory cannot be created or safely validated,
the original authorized transcription path remains available with a stable warning
and without reuse. A mutex wait failure does not bypass coordination or start an
uncoordinated second upload.
Failed transcriptions are not shared: waiting Bots may subsequently attempt again,
and each Bot still owns its progress card. Group-wide negative-result/retry
semantics and a single shared progress card remain future work. Attachment deletion
and switching to local mode do not immediately erase existing cache files; access
still requires the original authorization and byte/policy key, and retention
remains as described above. See the state and security boundary documents.

## Remaining limits and finding dispositions

**P1 at the audit checkpoint: synchronous widget CPU isolation remained open.**
The subsequent implementation is tracked in the [data-report and Worker
containment follow-up](../client/inline-widgets-cpu-containment-2026-10-22.md).
The following measurements describe the pre-Worker reader. WebKit and Chromium's
headless shell stall the parent during a bounded 1.5-second guest loop. Full
Chromium with default sandboxed-frame isolation kept the parent responsive in
Opus's tests. Native macOS measurements show a same-WebView iframe delaying the
parent round trip by about 1,396 ms; a separate WKWebView kept it near 0.69 ms.
This validates an architectural direction, not a shipped native reader. Windows
WebView2 and physical Android/iOS behavior still need native acceptance.

A startup-lease/slow-handler quarantine prototype was evaluated but not merged:
its shared localStorage ownership can misclassify another active window; startup
leases do not cover later infinite loops; broad handler wrapping has compatibility
and attribution costs. No private WebKit process API or blind PID termination was
added. The host visual-reply switch controls publication, not execution of stored
history. Ordinary error retirement, source-size guidance and hidden-frame cleanup
must not be described as full CPU containment.

**Release gate:** the audited source has schema 21 while its version files still
say Host 0.1.445 / App 1.0.97, the previously released schema-20 combination.
Before another release, increment both versions (at least Host 0.1.446 and App
1.0.98), build matching App/CLI artifacts and verify clean installation plus
existing-host upgrade. Do not publish another same-version package from this
source: equal-version reconciliation intentionally does not perform an upgrade.
No release or installed-App replacement is part of this audit.

Other findings were classified rather than changed speculatively:

- An offline dispatched discussion can remain `ending` while waiting for a
  terminal receipt. An explicit abandon design must fence late Worker results
  before allowing another run; automatically skipping live work is unsafe.
- Audio transcription failure stops a discussion even when the topic also has
  text. This is retained: “discuss this recording” is not actionable without the
  recording. Explicit Retry may try again; missing primary input is not silently
  discarded and the engine is not asked to invent its contents.
- IndexedDB termination recovery on mobile remains a conditional gap. There was
  no physical-device reproduction; the current retired-connection behavior was
  not changed without a complete cache ownership/reopen design.
- Cloud timeout defaults, metadata within original audio, and fixed-cloud-mode
  precedence over message keywords remain documented policy/adapter boundaries.
  The audit did not measure paid-provider completion or remote cancellation.
- Route-limit status currently estimates additions without the saved merge base;
  it can warn about a deliberately removed Host route. Actual synchronization
  preserves that deletion. This is a remaining status-presentation discrepancy.
- Unselected CLI runtime provenance, periodic busy-update drain attempts and
  ordinary-group/delegation prompt overlap remain conditional concerns, not
  newly demonstrated corruption or unauthorized execution.
- Existing per-turn App contracts are still repeated in Claude history; the
  visual-capability line contributes roughly 47 tokens under the prior o200k
  estimate, and disabled turns retain the short policy reminder. Those are not
  Claude billing measurements. Moving contracts between system/turn scopes
  requires separate resumed-session and policy-change validation; this audit
  fixes unnecessary full-recipe injection without changing that contract.
- Personal message deletion is not erasure of shared discussion context. Narrow
  model-label truncation has a full-value tooltip. Neither was treated as data loss.

## Validation

- The complete local gate passed on the frozen repair set: **424 test files,
  5,837 passed and 5 skipped**, Host build (413 modules), translation checks,
  client TypeScript/Vite build and **77 native Rust tests** (71 + 3 + 3).
  An earlier run crossed a source/test edit and failed one cache test; the
  unchanged rerun above passed.
- Chromium's broad changed-surface run completed **452/456** journeys. Two
  failures were stale wording and a test that acted before group settings
  finished loading; corrected focused runs passed. The ADHD source-jump and
  large cached-history read-count observations did not reproduce in 7 and 9
  isolated repeat runs respectively. Their original failures remain recorded;
  the broad browser run is not represented as fully green.
- The final widget lifecycle/security suites passed **29 tests with 1 skip in
  each of Chromium and WebKit**. Focused desktop-copy suites passed 7/7 on
  each browser; mention/recipient and dispatch/edit race tests also passed.
- Real Codex (`gpt-6.1-sol`, low effort) proactively published one 4,661-byte
  interactive report with a durable native receipt, without a tool name or
  chart instruction in the prompt. Turning publication off produced zero new
  widgets in both an existing and a new session; stored history remained
  readable. The rendered report was inspected.
- Python checks passed 33 tests; the native audit runner passed 7 tests. These
  and Rust tests do not constitute an installed-App or physical-device release.
- Opus independently confirmed ordinary single-error compatibility, repeated
  error retirement, blocked STUN and cross-turn/parallel transcription reuse.
  Its final whole-patch review independently passed 370 unit tests, 75 Chromium
  journeys (1 skip) and 67 WebKit journeys (2 skips). The confirmed full-width
  mention gap was repaired; same-OS-user cache confidentiality was clarified
  rather than claiming a new credential boundary. Speculative risks remain
  distinguished from reproduced failures.

Local evidence lives under
`/Volumes/gdrive/taro-tmp/tarobot-three-day-audit-20261022`; raw reports and traces
are not published because they include local environment details. The requested
CPU-containment implementation continues separately from this repair checkpoint.

CLI impact: transcription reuse and queue error semantics live in shared Host
code; the CLI continues to use the same policies and mutation API. Mention-name
parsing, accessible names and reader lifecycle are App presentation changes;
CLI send still uses explicit Bot IDs. Widget publication and its switch retain
the existing shared CLI entry points. No alternate CLI implementation was added.

## Interrupted-run follow-up: model capacity feedback

The interrupted audit's raw Codex error was `Selected model is at capacity`
with `serverOverloaded`. The Chinese feedback translated this as “容量已满”,
which confused provider availability with account quota or local disk space.
Both shared error renderers now say the model service is temporarily busy and
explicitly distinguish those meanings. Classification remains `engine-backend`;
quota/rate-limit classification, partial output preservation and replay policy
are unchanged. CLI impact: shared Host feedback only, with no new command or
separate CLI behavior.

The quoted interruption preceded the completed checkpoint above. A fresh run on
the current source plus this wording change verified:

- 78 tests across error classification, transcript reuse, parallel/discussion
  voice handling and Host backups; the partial-answer failure regression also
  passed. Host and client builds passed.
- 33 WebKit journeys covering inline widgets, publication settings, infinite
  initialization/click/microtask execution, message floods and history quarantine.
- Real Codex (`gpt-6.1-sol`, low effort) proactively delivered one 707-byte data
  report with one durable receipt. Six daily records totalled 29 (14/15); date
  selection and expansion worked, and the rendered screenshot was inspected.
  Disabling publication produced zero new widgets in both an existing and a new
  session; the previous report remained readable. This acceptance took 45.7 s.

Local evidence: `/Volumes/gdrive/taro-tmp/tarobot-capacity-followup-20261022`.
The installed App/Host was not replaced or restarted. Locked-screen native
acceptance remains open in [issue #60](https://github.com/cloveric/tarobot/issues/60);
these browser checks do not close it or remove the release gate above.
