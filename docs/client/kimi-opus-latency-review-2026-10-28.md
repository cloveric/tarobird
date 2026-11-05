# Kimi / Opus latency cross-review — 2026-10-28

This audit rechecks the [outgoing-message investigation](send-latency-investigation-2026-10-28.md) against source `e13f0aa5b08498840467d656c78591edaa05a526`, original timing artifacts, and an independent synthetic database fixture. The actual Kimi Bot completed the independent investigation, and Opus 5.5 (`claude-opus-5-5[1m]`) cross-reviewed its findings and original evidence. It is an audit, not a release or installed-device acceptance.

## Installed-code readback

A fresh readback found App **1.0.117**, bundled Host **0.1.462**, and the running Host PID **42013** using `/Applications/TaroBot.app/Contents/Resources/host/node`.

The installed `dist/src/hub/prompt-queue.js` still contains the old `message_id IN (SELECT id FROM messages WHERE status='deleted')` statement, and does not contain the correlated primary-key probe. Installed `dist/src/hub/database.js` has no `messages_pending_link_previews` DDL. Both repairs are ancestors of the audited source, but are absent from the running installation's bundle. Opus independently confirmed the installed file hashes and exact query fragments. The source package also still says `0.1.462`, so a version number alone cannot establish activation. This does not measure current latency or establish the entire installed source revision.

| Installed file | SHA-256 |
| --- | --- |
| `dist/src/hub/prompt-queue.js` | `92fef17b243c0208b22dcc4c4082205551025077a101810d63b90efd993766f9` |
| `dist/src/hub/database.js` | `9264d5099d4e0b1cc034dade6de4fb0ab98af5c48d5925a36e2d05f78c0c8529` |

No restart, installation, direct production database access, debugger attachment, new production timing probe or real-model test prompt was performed in this audit. Ordinary status reads and the requested Bot collaboration were the only Host interactions.

## Independent query verification

Kimi used actual `HubStore.pendingLinkPreviews()` and `HubPromptQueue.claim()` SQL on isolated synthetic databases with 2,000 historical messages. The fixture passed under Node v24.14.0 and SQLite 3.52.0:

- The partial preview index changes the plan from a messages scan plus temporary sort to `messages_pending_link_previews`; ordered results, membership eligibility, exclusions and `LIMIT 4` are unchanged. Reopening schema 22 recreates a missing index. Completing previews and deleting messages maintain it.
- The claim query changes from materializing historical tombstones to primary-key probes for relevant deliveries. Old and new statements produce identical final delivery states. A legacy tombstone is cancelled once; personal deletion, already dispatched/accepted deliveries and other Bots are preserved. The actual claim does not return deleted input.
- This is independent semantic/query-plan evidence, not another end-to-end speed measurement. No additional server, client or model was started.

## Evidence boundaries

The existing claim A/B contains two accepted runs per variant, with source hashes verified. The runs were not alternating; two fixed runs were retained only after correcting labels from the failed shell splitter. Invalid labeled rows are excluded, and the separate current-only file duplicates two accepted rows and is not counted again. Busy claim transactions, target-created-to-input-received and sender ACK each have only **15 samples per run**: their reported p95 equals that run's maximum. The tombstone SQL statistic has 45 samples per run and must not be conflated with those 15-sample metrics. The preview A/B is one warm synthetic fixture: query time improved, while its ACK p95 did not improve. Neither result establishes physical phone latency.

The `2e8f6345` streaming change can increase burst publication work, but the controls did not establish a universal one-second send delay. The only approximately one-second ACK in the 24 cadence controls occurred in an **OFF** external-disk run (maximum 1,047.2 ms); its cause remains unexplained. This does not establish that the optimization is harmless, but does not support assigning all delays to it. `051b61b6` was not independently isolated. Timing proximity to an update cannot identify either change as the sole cause.

Clearing personal App history records deletion markers while retaining canonical `messages`, run journals and the model session. It can reduce visible/synchronized content; it cannot shrink the message table behind the old installed full-history scans. It is not a substitute for deploying the Host repairs.

The [attachment-to-text investigation](artifact-text-latency-2026-10-28.md) identifies a separate upstream interval: native text arrived long after the file result, with a much shorter native-to-Host interval. The existing evidence cannot separate provider generation, native CLI buffering and network time, or prove current physical-device rendering latency.

## Cross-review disposition

Both reviewers accept the preview-index and dispatch-query repairs. No new confirmed runtime bug was found. Preserve both fixes; do not speculatively weaken authorization, personal deletion, quotas or durability.

Opus disagrees with treating Kimi's two proposed test additions as blocking gaps:

- Preview coverage already checks the actual query plan, equal-time row order, exclusions, reopen/maintenance, and a separate five-candidate/two-tick scenario (`tests/hub-link-preview.test.ts:60-129`). Mixed-time ordering is an optional strengthening; the SQL `ORDER BY` is unchanged.
- Claim coverage already checks the state matrix and primary-key plan, plus repeated dispatch/ACK with a legacy tombstone (`tests/hub-prompt-queue.test.ts:429-477`). Kimi's old/new fixture supplies one-time equivalence evidence; retaining the old SQL as a permanent test oracle is unnecessary.

No extra tests or runtime patches were added. The independent fixtures passed; their source/script hashes were checked against this audit baseline. Prior full-suite/build results remain historical results, not reruns in this audit.

## Remaining candidates, not confirmed causes

| Candidate | What is established | What remains unproved |
| --- | --- | --- |
| RunJournal writes (`src/hub/run-journal.ts:16-38`) | Three indexed owner lookups took 138–146 ms in the prior 100-second capture; a separate byte-sum query took 83.6 ms in the earlier capture. | Why those indexed reads were slow, whether they persist after activation, and how much they contribute to the full send journey. The owner and SUM samples are different queries. |
| Open process-reader queries (`src/hub/run-journal.ts:41-90`) | Kimi's actual-reader fixture enters two serial sections; sibling lookup uses a conversation index plus JSON iteration, and artifact lookup uses a conversation/time range. | No slow sample of this path was identified in the retained capture records. The plan shows a possible cost, not a measured production bottleneck or evidence that a new index is needed. |
| Per-worker request FIFO (`src/hub/server.ts:1104-1110,1165-1199`) | A queue-take request can follow earlier publish/journal requests on the same worker socket. | Its independent contribution to latency. In the old installation, earlier requests themselves can wait behind the proven history scans. |

The snapshot event-history reader also had slow SQL in the old capture, but uses a separate read-only connection and does **not** occupy the shared serial queue. An indirect I/O/thread-pool effect remains unproved. Similar tombstone `IN` queries still exist in startup and daily maintenance; they are outside this dispatch hot path and had no measured stall here. The repairs do not mean every historical scan has disappeared.

## Next acceptance sequence

1. Build/install a revision containing both repairs, then verify the installed exact claim `EXISTS` fragment and preview-index DDL, the running process's bundle path/start time, and successful index initialization. The first index build can scan the existing history once; that startup cost has not been measured. Checking only App/Host version numbers is insufficient. This audit did not perform that activation.
2. Capture one bounded natural send journey on native Mac and physical iPhone with aligned stages: click, socket send, raw ACK, worker input receipt, first public model text, first Host body event, and DOM/next frame. Record database queue wait versus execution by SQL category. DOM/next frame is not compositor-paint or physical-device visual acceptance by itself.
3. If delay remains, use the slow stage to select the journal, reader or worker-FIFO investigation. Do not run another broad synthetic matrix or preemptively rewrite SQL before identifying that stage.
4. Treat the attachment-to-text upstream wait separately; identifying provider, native CLI or network time requires measurements at those boundaries.

These are follow-up acceptance steps, not measurements completed in this review.

## Local evidence

Artifacts are under `/Volumes/gdrive/taro-tmp/kimi-opus-latency-audit-20261028/`:

- `installed-readback.json`, `root-runtime-findings.md`: installed bundle, process and history-clearing scope.
- `verify-db-fixes.mts`, `isolated-db-verification.json`: independent actual-query fixture, source/script hashes and assertions.
- `verify-run-reader-plan.mts`, `run-reader-plan.json`: actual-reader query plans on an isolated fixture, with no production timing claim.
- `summarize-evidence.mjs`, `evidence-resummary.json`: recomputation of original captures and accepted A/B rows; no new production probe.
- `kimi-findings.md`, `opus-cross-review.md`: final independent findings and cross-review.
- `root-evidence-integrity.json`: nine successful script/source hash comparisons. Failed initial fixture outputs are preserved separately and are not counted as passes.

This documentation-only audit changes no desktop/mobile/CLI runtime behavior and requires no new CLI command or release. Installed and physical-device acceptance remain outstanding.
