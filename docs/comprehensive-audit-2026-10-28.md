# Comprehensive audit — 2026-10-28

Status: this audit pass, confirmed fixes and focused acceptance are complete.
This is a source audit record, not an installation or release receipt. The full
browser inventory was not completed; remaining risks and a timing flake are
listed below. Baseline is `2551c7be1528aa2b902d711aea982856a89e02d7`;
fixes start at `64b129f8d441e73d20892734d21cba78a0674d1b` (the separate Pending
label change). No production configuration, existing user history or installed App was changed.

## Method and coverage

The first pass inspected the repository and test inventory independently, then
shared concrete findings with Claude Opus 5.5 (`claude-opus-5-5[1m]`) for an
independent review and discussion. Areas: device and Host authentication, relay
and cross-host transport, Gateway/engine lifecycle, queues/synchronization,
personal history, voice/file boundaries, native installation identity, desktop
and phone presentation, CLI parity, dependencies and builds. The repository
contains 3,648 tracked files, including 2,066 code/script/test files; those are
inventory counts, not a claim of line-by-line review.

Opus 5.5 was invoked for the independent review. No production attack, real-engine
acceptance run, user-data deletion, service restart or installation was performed.
Probes use isolated Host state, synthetic credentials,
stand-in engine processes and loopback test services. Semgrep and CodeQL were
not available and were not run. Browser/native automated tests do not replace
physical iPhone/Android/Windows or real IME acceptance.

## Confirmed findings and changes

| ID | Finding | Resolution and evidence |
| --- | --- | --- |
| A1 | Personal snapshots loaded full bodies for records already hidden by the user. | Read page metadata/tombstones first and bodies only for visible records, in the same read transaction. Full/merge order, metadata, client IDs and versions retained. |
| A2 | Even small incremental replays loaded all personal hidden-message IDs. | Per-distinct-message indexed lookups inside the existing byte-bounded replay; no unbounded body prefetch. Empty direct-store replay is test-only, not a claimed production path. |
| FILE-1 | Forwarded or delegated text could contain cloud-ASR routing keywords. | Separate current-human text from display/forwarding envelopes; explicit empty routing text survives normalization and batching. |
| FILE-2 | Declaring a video container as audio could upload its video stream to cloud ASR. | Require positive audio-only stream proof before original-file upload; otherwise extract audio or fail/fall back according to configured mode. Real generated video fixture verifies WAV-only upload. |
| FILE-3 | Kimi credential paths and dot-prefixed DeepSeek credentials escaped shared file blocking. | Add narrowly identified credential paths and symlink regressions; ordinary output/config names remain usable. |
| GRP-1 | A revised one-shot reminder due while its previous run was active lost its only timer. | Rearm the current unclaimed one-shot after release; re-read state and honor pause, disable, removal and retry fences. Two before-failures and three cancellation-boundary cases. |
| ENG-1/2 | Signalling the root before enumerating descendants could orphan grandchildren; workers could exit before asynchronous cleanup. | Enumerate deepest-first, retain process identity checks, await bounded cleanup before releasing the worker lock. Expire underlying callbacks/tools at the wait deadline so late callbacks cannot signal reused PIDs. Real stand-in process tree and worker regressions; no production Bot restart. |
| AUTH-1 | One source could retain public relay handshake slots by trickling bytes. | Add an absolute ClientHello deadline, per-source cap and reserved capacity; IPv6 sources share a /64 quota. Distributed floods remain outside this guarantee. |
| AUTH-2 | Signed cross-host Bot or directory requests still exposed plaintext to a TLS-terminating relay with its own valid certificate. | Bind the Hub's signed proof to the observed TLS leaf and enforce that pin before sending private request bytes. Shared transport helper, bounded cache, rotation re-proof; no resend after an ambiguous Bot POST. Synthetic CA/intermediary regression. |
| AUTH-3 | Untrusted remote devices shared attempt accounting with trusted identity paths, and equivalent address spellings could split quotas. | Separate quota namespaces and canonicalize mapped IPv4 / IPv6 /64 sources in the shared helper. Auth and Hub-server regressions cover both boundaries. |
| GRP-2 | Bot-originated group messages could enter an active discussion through the real Bot-message endpoint. | Apply the shared active-discussion ingress guard after idempotent replay; retain memo/rate/audit rollback. Blind, sequential, paused, ended-and-retried and ordinary-message cases verified. |
| SYNC-1 | An incoming Bot-created conversation was absent from already-connected Apps until reconnect. | Announce creation through the Hub's existing conversation update path and add it to authorized clients' tracked IDs. |
| CLI-1 | CLI could archive conversations but had no restoration entry. | Add atomic receipted restore with an additive Host capability and the same membership/ownership rules. Explicitly archived topics remain archived unless selected; replay cannot overwrite later changes. |
| CLI-3/4/5 | Bot creation hid its generated retry ID; repeated target flags were last-wins; non-network actions showed network confirmation hints. | Print creation ID before dispatch; reject duplicate single-value flags; validate unknown network commands before connecting; scope confirmation guidance. |
| SYNC-2 | Editing the latest queued user message left a stale sidebar preview. | Update only its current preview, preserving content time/sequence; never replace a newer Bot reply with an older edited message. Actual IndexedDB before/after regression. |
| U1 | Clear-history entry was buried in conversation settings. | Reuse the existing gated confirmation/control in the first conversation-details section; no new deletion semantics. |
| UI-1/4/5/6 | Temporary-file reason used an obsolete name/key; help and English lists had inconsistent branding/punctuation; folder attention had no semantic role. | Correct displayed keys/names, localize list separators, add an image role to the attention marker. Category labels were already translated; that part of the initial report was withdrawn. |
| UI-8 | With reduced motion, Bus reveal could finish before the automatic column count changed, moving the target out of view again. | Wait, bounded to 30 frames, for the committed grid width to match the measured width before the existing correction. Preserve wheel/key cancellation and one correction per explicit intent. A delayed ResizeObserver regression fails before and passes after. |
| UI-7 | A floating menu closed on unrelated document scroll, including automatic chat scrolling. | Close on movement of the anchor's scroll ancestors, retaining own-ancestor and resize handling; unrelated trusted wheel scrolling leaves the menu open. Before-fail / after-pass browser regression. |
| PERF-1 | Large personal-history clears refreshed the UI after almost every tombstone, competing with the next durable cache write. | Coalesce UI invalidations in batches of 32 committed events or after the receive queue drains; flush the final tail and on receipts/state changes. Keep per-event cache and cursor commits. Avoid draft notifications when no quoted draft actually changed. |
| PERF-2 | A slow history read imposed an equally long extra idle period, and explicit Retry used that same delay. | Cap the adaptive gap at 1 second and let explicit Retry wake a pending gap. A controlled 11.812-second read hold was followed by a fresh read after 1.032 seconds; single-in-flight, navigation fencing and error recovery remain covered. |
| PERF-3 | Every small text stream update invalidated UI/history, competing with subsequent cache writes. | Batch plain text append/replacement deltas using the same 32-event / receive-drain mechanism. First messages, terminal full updates and card/path/interactive operations flush immediately. Text tail, final content, draft durability and reconnect/card compatibility verified below. |
| UI-2/3 | Several custom Escape handlers ignored composition; share review did not enter/trap/return keyboard focus. | Add composition guards and share focus handling while retaining mounted drafts and existing upload lifecycle. Synthetic-event browser verification, not a physical IME claim. |

The snapshot probe used 64 hidden 256 KiB bodies and one visible record. Body
bytes fetched fell from 16,778,990 to 46 with identical 67 frames / 65 canonical
messages. Measured elapsed time was 708 ms before and 46.76 ms after under local
load; this is an isolated measurement, not an installed-device speedup claim.
Opus independently compared 76 outputs (including 12 merge snapshots and 285
tombstone frames) without a semantic difference.

The 103-tombstone browser probe improved from 104 UI revisions / 33.32 seconds
to 4 revisions / 1.668 seconds. The final three-event tail was visible without a
later incoming message; all tombstones and the final cursor were read back.
These are isolated real-Hub / Chromium measurements, not phone benchmarks.
The full 2,105-record clear also passed its unchanged 90-second completion
assertion, including a lost receipt, explicit retry, a second offline device,
late messages, unsubmitted draft and retained Bot session / original history.

## Validation ledger

- Full root baseline: 513 files; 508 passed / 5 failed. 6,984 tests: 6,972 passed,
  7 failed, 5 skipped. The five failed files passed isolated without relaxing the
  same 15-second standard timeout: 150 tests. Parallel timing/load is a possible
  contributor, not proof that every initial failure was harmless.
- Native desktop baseline: 82 tests passed (76 + 3 + 3). These ran on macOS.
- Root and client baseline builds passed. Root/client dependency audits reported
  zero known advisories; this is not a guarantee of no vulnerabilities.
- Browser baseline selected 2,244 cases across 335 files. The diagnostic sweep
  stopped after 431 passed, 27 failed, 2 interrupted; 1,784 did not run. Repeated
  startup and interaction timeouts prompted isolated single-worker diagnosis,
  not a full-green claim. Three obsolete assumptions were repaired: nested
  settings rows, explicit dark-theme selection (first-run now defaults to light),
  and the App-owned `/tasks` suggestion in a capable Host's command list.
- The first focused UI run was 31 passed / 1 failed: the 2,105-record clear/retry
  case exceeded its 90-second completion assertion. PERF-1 fixed the reproduced
  cache/refresh contention and that full case subsequently passed unchanged.
  Seven further focused cases passed, covering the corrected theme/settings
  assertions, native-card gallery, details entry and composing Escape handling.
- Combined candidate Host/protocol/CLI regression: 37 files, **769 tests passed**,
  zero failed or skipped, one worker and the existing 15-second timeout. Covers
  every changed root test file and additional shared permission, discussion,
  queue, device-action and TLS boundaries. Root build passed (459 modules).
  Client translation check, TypeScript check and production build passed.
- Earlier focused browser groups: 14 activity/share cases passed, and seven
  corrected settings/theme/cards/details/IME cases passed. These overlap with
  later selections; their counts are not added into a fictitious unique total.
- The former 36-capture gallery
  reached all screenshots and geometry assertions but exhausted its total
  60-second test budget at the final navigation. It is split into three capture
  groups, retaining every size/theme/assertion and the normal timeout.
- Streaming checks reproduced both failures on unchanged baseline code. PERF-2
  passed the delayed-read, late resolve/reject and failed-initial-read cases.
  PERF-3 made the 20-event background burst use one directory/activity read and
  the 30-event open burst use two history reads; final text and a three-event
  nonterminal append tail appeared within the normal five-second assertion.
  The combined phone setup/stream/typing/send test exhausted its 60-second total
  after those checks and typing passed; only its integration budget becomes 90
  seconds, retaining the normal per-interaction deadlines. The rerun passed all
  phases. A fixed fewer-than-13 draft-write check incorrectly assumed all keys
  arrived within three seconds; the retained measured-time throttle, actual
  input count, draft-preview count and durable-draft assertions passed.
- Candidate stream/gallery selection: 16 cases, initially 15 passed / 1 failed
  at that obsolete typing-count assertion. After correction, the one failed
  phone case passed (37.1 seconds), including sending and clearing its draft.
  The eight stream cases cover final-broadcast loss/reconnect, delayed run
  details, three palettes, nested-card deltas, duplicate/stale/gap handling and
  full recovery bases. Client translation/type/build passed for these changes.
- The 35-case single-worker baseline-failure isolation completed 31 passed /
  4 failed. The gallery failure is resolved above. Crash recovery initially
  failed its polling-return stopwatch at 2,004 ms despite the online assertion
  passing. It now measures the DOM transition itself while retaining the strict
  two-second threshold: 206 ms in the passing rerun, with every chunk, exactly
  one reply and one engine call verified.
- Opus Bus verification: the new 400 ms delayed-ResizeObserver regression failed
  on base and passed on the fix; typecheck passed. The original long scenario
  passed three of five bounded repeats. Two repeats stopped at an unrelated
  earlier polling check which missed the existing 240 ms dock transition. This
  remaining timing flake is recorded, not called fully green. Capacity fallback
  passed twice. The root combined client build passed translation/type/build
  checks, and the new deterministic Bus regression passed (33.9 seconds).
- Opus traced the collaboration failure to its total 60-second budget: the
  second restart started at 58.9 seconds and its 15-second wait was cut off.
  Increase only that integration budget to 120 seconds, retaining each startup
  and restart's 15-second deadline. The corrected root rerun passed in 40 seconds. An initial root rerun
  launched from the wrong directory could not find the worker entrypoint; that
  harness invocation is excluded, and the corrected client-directory run is
  recorded separately and passed.

The combined candidate contains the independently reviewed Host fixes,
`7df7a061` (UI/history-clear work), `4951db63` (history-wait and text-refresh
fixes), `41b36166` (Opus reduced-motion Bus fix) and the focused test corrections.
Opus accepted the root fixes and both final streaming changes; the root reviewed
and integrated all 13 Opus commits. No release, native package or real-device
installation was produced by this audit.

## Remaining limits and separately tracked work

- CLI capability backlog remains for scheduled tasks, mute controls, file-label
  scans, conversation rename and turn stop. Restore closes one gap; this is not
  a claim that all App features have CLI parity.
- Dynamic file-inventory warning strings still need a structured, localizable
  protocol; category labels already use translated stable categories.
- Android own-provider sharing aliases and native installation-marker torn writes
  are code-review hardening risks, not reproduced device exploits or demonstrated
  failures. The alleged ordinary concurrent marker race was withdrawn because
  native callers are serialized by the device-keychain semaphore.
- Credential blocking covers the known default Kimi location; an arbitrary
  custom `KIMI_CODE_HOME` is not discovered by these new path patterns.
- The public relay deadline covers pre-ClientHello admission. Hub-side TLS after
  ClientHello still uses Node's default handshake timeout; distributed sources
  can also exceed a per-source defense. These remain hardening opportunities.
- Process-tree PID reuse between discovery and signalling remains a residual
  race. The missing-procps container fallback has not been validated in Docker.
- A root-wide TypeScript invocation reported 123 existing errors during review;
  the scoped client typecheck/build passed. No repository-wide type-clean claim.
- GitHub checks were unable to start because of an account payment/spending-limit
  failure. Local results do not imply remote CI ran; final push status is checked
  separately and does not authorize changing account billing.

## CLI impact

History, ASR/file boundaries, scheduler and transport/lifecycle repairs live in
the shared Host/Gateway paths and therefore also affect headless operation.
Restoration adds `tarobot conversations restore`; help and the CLI guide describe
capability negotiation, explicit scope and stable request-ID retries. The Pending
label, direct clear-history shortcut, focus handling and localized UI lists are
presentation changes; their underlying operations already use shared Host APIs.
A later release must bundle/publish matching App and standalone Host/CLI revisions;
this audit does not create or install a release.
