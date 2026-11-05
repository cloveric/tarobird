# Efficiency and stability audit — 2026-10-25

The requested follow-up to the UI review checks correctness, repeated work and
resource lifetime. It does not change platform sizing or publish/install an App.
The baseline is `9bb47e06c14149f94dd8412cfa193387457d04e0`.

## Review method

Codex reproduced the findings in an isolated checkout and isolated test Hubs.
Claude Code 2.1.309, model `claude-opus-5-5[1m]`, effort `xhigh`, independently
reviewed the source with read-only tools, then reviewed the final diff and the follow-up repair. Reviewer
claims are hypotheses until supported by a reproduction or a specific code path;
an asynchronous read's elapsed time is not main-thread CPU utilization.

The initial cross-Bot review request remained undispatched and was canceled
through its normal queue API. The completed independent review used a separate
Claude CLI session. No production Bot, service or permission was changed.

Evidence directory on the owner's Mac:
`/Volumes/gdrive/taro-tmp/performance-stability-audit-20261025`.
`opus-review.md`, `opus-findings.json` and `opus-final-review.md` hold the initial and diff
review passes; `opus-followup-review.md` checks the final repair. Raw tool transcripts are local evidence, not public test fixtures.

## Confirmed repairs

| Area | Confirmed cost or fault | Change and preserved boundary |
| --- | --- | --- |
| Structured report tables | Every numeric cell constructed an `Intl.NumberFormat` | Reuse a module formatter with the same browser locale and rounding. No font or table geometry change. |
| Reconnect progress | Every empty per-conversation marker invalidated directory data and published redundant shell state | Publish progress at the first/last marker and at most every 100 ms between them; publish actual replay immediately. Keep **every per-conversation queue flush**. Empty markers do not advance the cache revision. |
| Directory and avatars | IndexedDB returns new objects even when conversation membership and Bot profiles are unchanged | `shareDirectory` preserves unchanged metadata references. Changes to owners, members, bindings, archive state, unread records, ordering and removed fields still publish. No message bodies are deeply compared. |
| Conversation list | The list subscribed to every connection-state change | Subscribe to the status, user and capabilities it actually reads. Conversation/activity props still update normally. |
| Title and native badge | Repeated updates even when the unread count was identical | Title writes follow the derived count. Badge requests deduplicate successful/in-flight equal counts; failures retry on later directory/host updates. Browser calls and an injected bridge failure were tested; native IPC was not separately profiled. |
| Link covers | After a loaded cover left the bounded cache, disconnect revoked its URL and could not reload it | Reuse the existing attachment lease hook, retaining loaded bytes across route transitions and releasing the URL on unmount. Reproduced failing before and passing after. |
| Search and file-result deletion filtering | Every unrelated connection publication reread all tombstone IDs without coalescing | Observe the existing deletion/snapshot revision and use one active read plus one trailing read. Closing or changing results fences late results. Reconnection rereads shared-cache deletions even when another window already advanced the cursor. Group-setting updates can safely cause an extra read. |

`sync.complete` still publishes a committed short replay. Queue mutation, ACK,
failure, removal and history-read revision fences are unchanged. Sync progress
is presentation only; throttling it never delays a conversation becoming ready
to send. No new transport capability or schema is introduced. A coalesced intermediate
progress label can briefly lag while the next large history transfer proceeds;
the first/final milestones and actual queue eligibility remain immediate.

The diff reviewer caught a regression in the first deletion-read optimization:
`cache.apply()` returns no message when another window already committed the
same event. The first implementation therefore missed that tombstone; a window
that was offline could also resume past it without receiving it again. Real
shared-context browser pages reproduced the stale search/file results. The
final connection invalidates from the successfully handled tombstone event's
kind/status, and the observer also rereads on reconnect. It still obtains the
actual hidden IDs from committed IndexedDB, not the incoming payload. Both
online delayed-event and offline/resume paths now have dedicated regressions.

The conversation-file test also still expected image files in the old generic
file dialog. The baseline already routes images into `LocalImagePreview` and
the shared image viewer. The test now checks that viewer and still verifies
decoding, Escape, returning to files, navigation and draft retention.

## Measured comparisons

These are controlled local browser fixtures, not physical iPhone/Android or
packaged Mac benchmarks. Tests run against the actual App/components and real
isolated Hub events. Timings are observations, not universal latency promises.

For a supported 200-row, 12-column report (2,200 numeric cells), seven synchronous
React mount samples after warm-up gave:

| Viewport | Baseline median | Revised median |
| --- | ---: | ---: |
| Desktop, 1360 px | 53.1 ms | 18.9 ms |
| Phone layout, 390 px | 51.0 ms | 19.9 ms |

Evidence: `report-performance-comparison.json`, `report-before.log`,
`report-after-memory.log`; WebKit additionally exercised both widths.
This measures component mount work, not the entire application's startup.

With 202 conversations, 20 background updates, then a reconnect:

| Measurement | Baseline | Revised |
| --- | ---: | ---: |
| Desktop reconnect workspace renders | 411 | 15 |
| Phone-layout reconnect workspace renders | 412 | 15 |
| Desktop reconnect directory reads | 98 | 3 |
| Phone-layout reconnect directory reads | 99 | 3 |
| Phone-layout avatar renders during 20 background updates | 4,120 | 80 |
| Unchanged-count title writes during those updates | 20 | 0 |

Evidence: `directory-before-stable.log`, `directory-after.log`. Measurement starts
after the initial sync finishes and waits for a new socket's completed sync.
An earlier exploratory run included unfinished initial sync and is excluded.
Per-marker outbox reads remain 204 in this fixture, deliberately preserving the
queue eligibility checks. Twenty actual preview changes still cause twenty
directory reads and forty workspace renders; this patch does not claim to
eliminate all background rendering or introduce a new preview throttle.

## Stability probes and decisions not to rewrite

- A 10,000-message cached history received 30 updates, 150 ms apart. Chromium at
  phone width measured frame-interval P95 16.8 ms, no observed long tasks, and
  six automated input-fill actions of 27–31 ms. The latter is automation action
  duration, not a physical-device input-to-paint measurement. History reads still took roughly
  38–54 ms **elapsed asynchronously**. A full incremental-history rewrite is
  deferred: this run did not demonstrate main-thread stalls, and changing that
  path affects snapshot replacement, deletion and outbox receipt fences.
- Existing long-history tests also verify that unrelated background updates do
  not reread the visible conversation's history. Six messages remained mounted
  in the tested 10,000-message viewport.
- Twenty repeated image open/close cycles returned tracked object URLs, leases
  and dialogs to zero. DOM/listener counts stayed bounded. This is a browser
  retention check; it does not prove the absence of native/GPU memory leaks.
- Widget regressions cover bounded state, switches, disposal and infinite-loop
  isolation. The opt-in bounded CPU benchmark is separately marked skipped
  when its environment flag is absent.
- The reviewer identified possible attachment-cache transaction contention,
  rich-draft attachment rewriting, and shared Markdown-worker termination
  costs. Existing reset/generation, memory and ownership protections explain
  these paths. They were **not confirmed user-visible faults** in this pass and
  are not silently replaced by riskier caching or weakened cancellation.

## Ownership and compatibility

This is App presentation/subscription/lifecycle work. The headless CLI and Host
business capabilities are unchanged, so no additional CLI command is required.
No engine-specific behavior, native Claude input, pending queue, background
subagent ownership or process lifecycle is changed. Tests use synthetic local
data; production histories and paired-device state are untouched.

The new helpers are `client/src/share-directory.ts` and
`client/src/observe-message-deletions.ts`. Callers are `HostApp`, history search
and conversation files. Other changes are in `connection`, `host-connections`,
`ConversationList`, `Avatar`, `LinkPreview` and `Report`.

## Validation record

- Final focused unit regression: **15 files / 98 tests passed**
  (`final-unit.log`). Includes current/legacy sync, per-conversation queue
  eligibility, ACK revision fencing, duplicate created/updated tombstones,
  reconnect pruning, reference sharing and attachment URL cache behavior.
- Chromium broad pass: **93 of 95 passed initially** (`final-chromium.log`);
  both failures were the obsolete conversation-file image-dialog locator.
  After correcting it and fixing the diff-review finding, the **9-case targeted
  rerun passed** (`deletion-results-after.log`). The remaining broad cases were
  not redundantly rerun; the final code's affected boundaries also ran in WebKit.
- Final WebKit regression: **53 passed** (`final-webkit.log`), including real
  shared-cache windows, file browsing, deleted-message propagation, interrupted
  snapshots, per-conversation readiness, outbox/history ACK races, cover lifetime
  and the directory/report fixtures at both widths.
- After tightening the offline assertion (no replayed tombstone received),
  shared-window deletion and 200/2,000/10,000-message history checks passed
  **7/7 in Chromium and 7/7 in WebKit** (`final-deletion-history-*.log`).
  Final 10,000-message streaming frame P95 was 16.7 ms / 21 ms respectively.
  WebKit does not expose long-task entries: its metric is `null`, not zero.
- Earlier supporting coverage in this audit: **129 focused client/core unit
  tests**, **19 stability/browser cases**, **59 widget cases passed / 1 opt-in
  case skipped**, and **32 related WebKit cases**. These preceded the final
  directory/deletion refinements and are not presented as final full-suite runs.
- Root standalone build, final client build and client TypeScript check passed.
  `final-source-receipt.json` records changed product-source hashes and confirms
  the successful client build completed after those source edits. The existing
  Capacitor keyboard static/dynamic import bundler warning remains non-fatal.
- The final Opus follow-up review found **no blocking findings** after the
  multi-window deletion repair; it explicitly did not run tests itself. Root's
  separate browser and unit runs provide the execution evidence.

Physical-device acceptance, native IPC profiling, a packaged App upgrade and a
complete rerun of every repository test are outside this source-only audit.
GitHub-hosted checks are reported separately from local validation.
