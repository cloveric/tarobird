# Agent Bus independent audit and verified repairs

The review covers the complete desktop Agent Bus workspace introduced in
`2ec2e2a` and redesigned in `a609a72`, not just its diagram. Two independent
DeepSeek sessions (`deepseek-official / deepseek-flash`, reasoning effort `max`)
reviewed execution and interaction respectively. Claude Opus 5.5 at `xhigh`
then reviewed both reports. Findings were checked against the actual admission
rules and reproduced in isolated tests before implementation.

The original reports each use F1–F6. The prefixes below distinguish execution
(`E`) from interaction (`I`). Static review claims are not execution evidence.

## Disposition

| Finding | Verified result and decision |
| --- | --- |
| E-F1: offline Stop never converges | The proposed immediate cancellation is unsafe and was rejected. A disconnected worker can still be executing. A real Hub/Gateway test confirms that reconnect replays the durable stop flag; the in-flight-message path applies it before receipt deduplication, aborts the original invocation and does not run it twice. A worker that never returns remains unconfirmed; it is not labelled stopped. |
| E-F2: a record archived mid-step remains streaming | Reproduced for completed, failed and cancelled stages. Fixed by terminating only the existing record's lifecycle after admission changes. No new result, error detail, delivery or completion push is produced. Restoring access and replaying the stage does not publish the withheld output. |
| E-F3: stopping Crew reports failure | Reproduced through real Gateway and Bus transport with deterministic engines. Explicit cancellation now writes `cancelled` Crew/run-stage state, emits `crew.run.cancelled` with `stopped` outcome and shows a stopped message. Completed evidence remains. Cancellation does not increment the failure counter. |
| E-F4: expired run receipts should be deleted | Rejected as a correctness change. Receipts remain replay fences after run pruning/deletion. Tests cover 53 runs: an expired result returns not-found, a changed payload conflicts, neither inserts another delivery. Request metadata growth is a storage tradeoff; deleting it without a replacement replay fence would allow duplicate execution. |
| E-F5: coordinator can report member results | An existing trust boundary, not independent member attestation. The authenticated coordinator worker reports observed Bus results for the fixed run snapshot. Same-owner, same-host workers are trusted. These records do not create member invocations or claim cryptographic proof from each member. |
| E-F6: future incompatible protocol fields | A future versioning requirement, not a current mixed-version defect. Incompatible dispatch/event changes must use a new negotiated worker capability. Strict validation and the existing old-worker/schema guards are retained. |
| I-F1: recovered polls leave a write-error banner | Reproduced in the browser. Reads and mutations now have separate feedback. Successful polling clears only its read error; an uncertain write receipt remains visible. Start preflight failures are not described as an uncertain write. |
| I-F2: preparation failure is hidden behind its modal | Reproduced for read, permission CAS and restart rejection. The modal now shows its own error, clears stale progress and stops readiness polling on failure. Permission conflicts use preparation guidance, and feedback does not claim that all earlier permission writes were undone. |
| I-F3: clean editor retains another device's old revision | Reproduced after adding real revision checking to the browser fixture. Polling adopts remote configuration only when there is no local configuration edit or open confirmation. Task drafts are retained. Dirty edits retain their original revision and receive the existing CAS protection. |
| I-F4: offline Stop/Delete confirmation does nothing | Reproduced by disconnecting the isolated Hub with each confirmation open. Confirmation buttons now use the same online/authority gate as their entry buttons. |
| I-F5: a later outage reuses a completed restart receipt | Reproduced in the browser. An App-observed live listener retires that pending restart receipt; a later outage gets a new one. Continued waiting/retry before readiness still uses the original receipt. One-shot CLI request IDs remain deterministic and unchanged. |
| I-F6: parallel members say “waiting for handoff” | Accepted as a presentation correction. Ask/Fan use “waiting to run”; ordered modes keep handoff wording. |

Reproduction also exposed an adjacent record-identity bug: a delayed Bus result
could overwrite a card that its author had replaced in the meantime. Closing a
record now requires the original streaming single-card envelope, author,
conversation, workspace, run and stage identity. Deleted, replaced, foreign and
native foreground replies are left intact.

Opus's independent baseline review added four findings:

| Finding | Verification and disposition |
| --- | --- |
| N1: Crew creates records for queued work after Stop | Reproduced with eight and ten research questions: only four engines ran, but all queued questions received stage records. A partial-result case also advanced into analysis after cancellation. The observer now rejects already-aborted steps before allocating records. The research pool stops taking questions, drains admitted workers, preserves completed findings and terminates before the next phase. Stop at a phase boundary does not announce or dispatch the next phase, and already completed stages keep their completion state. Ordinary partial research failures still continue. |
| N2: archived dedicated record chat is a dead end | Reproduced: choosing the dedicated option resolves the same archived chat. The archive decision is preserved; restoring that chat explicitly reuses its ID and allows execution again, with no duplicate conversation. The UI now directs the owner to archived conversations or another unarchived record chat. |
| N3: stopped run recovery asks the user to resend | Reproduced for both interrupted and failed worker receipts. A durable Stop on the exact admitted Bus input now produces a stopped/recovered-results message, without suggesting another run. Non-Bus recovery semantics and receipt deduplication remain unchanged. |
| N4: polling confirms a lost start but the button replays it | Reproduced after making the fixture expose an accepted run through polling. The client now matches the exact owner/request-derived run ID and workspace, then retires only that receipt and its error. The submitted draft is cleared only if its edit version is unchanged. New drafts, unrelated write errors and same-text runs from another request or owner remain untouched. Unconfirmed requests retain their original retry ID. |

Opus then reviewed the repair snapshot independently. That review found one
additional cancellation edge: a Stop from the coordinator's conversation,
between two Crew stages, can end Core without aborting the separate Bus
controller or creating a cancelled stage. Two failing tests reproduced the
incorrect `failed` Hub state, including the real Gateway chat-stop handler.
Gateway completion now also consumes Core's explicit `stopped` outcome as
`cancelled`; it does not infer cancellation from message text. Already completed
stage evidence remains unchanged. The 35-test Gateway suite passed after this
change. Opus separately rechecked the exact correction and both new regression
cases and confirmed the finding was addressed; that recheck was static, while
test execution was performed by the implementation/verification team.

The offline-stop limitation is intentional: while the coordinator is absent,
the Hub cannot attest that its model/Bus work has ended. It keeps the stop request
and the execution fence until a worker receipt arrives. Deleting that fence to
make the panel look idle would permit overlapping execution.

## Entry points and compatibility

Hub lifecycle repairs apply equally to the App and existing `tarobot bus`
commands. No second Hub, new command or cross-host routing is introduced.
Crew cancellation uses the shared workflow and is visible in existing CLI
status/timeline reads. Prior Crew records remain readable; older binaries that
do not understand the new cancelled state should be upgraded together with the
host. Hub database schema and the Agent Bus wire capability are unchanged.

Modal feedback, polling adoption, confirmation controls and waiting labels are
desktop presentation changes; there is no additional CLI interaction to add.
The App-only retirement of an observed-complete restart receipt deliberately
does not alter the CLI's stable request-derived restart IDs.

## Verification

Baseline: 117 focused tests passed before repairs. New failing tests demonstrated
the record lifecycle, Crew cancellation, UI recovery and restart-receipt bugs.
Additional passing isolation tests cover device revocation while queued,
expired-history replay fences, stop state after restart and permission revocation
between admitted and subsequent Bus steps.

The Crew follow-up has 46 passing focused checks, including real local Gateway
and Bus transport with controlled engines, delayed cancellation drainage,
partially successful research, five inter-stage stop races, ordinary research
failure and multi-round review. Another 103 recovery regressions pass for shared
message/run settlement. Archived dedicated-chat restoration and stopped-worker
recovery were verified through the real Hub store, including repeated receipts.

The production client passed 48 Chromium/WebKit workspace checks (24 per
engine). After N2/N4, 26 targeted checks passed (13 per engine), covering new
receipt confirmation, changed drafts, unrelated write errors, owner/request
isolation and the affected prior journeys. The final desktop archive-navigation
wording also passed both engines, including opening the real Workbench menu.
These groups overlap and are not a sum of unique scenarios. The client production
build, translations, TypeScript and 13 view tests pass.

Final integrated gate: `VITEST_MAX_WORKERS=4 bash scripts/pre-complete-hook.sh`
passed with **338 test files, 4,578 tests passed and one Windows-only test skipped
on macOS**. The gate includes rewritten-history/secret checks and the standalone
host build; its 367-module graph contains no optional legacy transport or Feishu
SDK. `git diff --check` also passes. These results supersede the earlier 4,560
and 4,576-test intermediate runs.

This audit does not claim packaged Tauri, physical Windows, native background
lifecycle or real-model answer-quality acceptance. Browser tests use the
production client with isolated Hub data and controlled responses for error and
concurrency scenarios. Gateway/Bus tests use real local transports and
deterministic engine substitutes. No production Bot was restarted or reconfigured
for these experiments. The installed App and published release are unchanged.
