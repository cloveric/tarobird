# Execution-time worker assistance

The coordinator could select a model when dispatching a ticket, but a worker
executing that ticket could not ask a different model for a bounded subtask and
then continue its own work. Its instance credential was rejected by the
coordinator-only ticket routes. Initial selection and execution-time assistance
are different operations; better selection prose alone did not add the latter.

## Reference and scope

The reference is [DeepSeek's dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e),
particularly worker-side subagent model discovery/selection and asynchronous
completion back to the requester. The inspected installed
`@deepseek-ai/dsh-tool-subagent` version was **0.2.1-rc.4**. Its compiled code
contains `requestedAgentOptions`, `assertAllowedModelSelection`,
`preflightChildLlmRoute` and `list_subagent_models`. An earlier 0.0.1-rc.1 review
cannot establish the current package's behavior. The prototype's configuration
and that later package use different option names; no upstream end-to-end
execution claim is made here.

TaroBot adapts the lifecycle to its existing authenticated Hub, worker processes,
ticket ledger, cancellation and per-ticket workspace. No upstream runtime is
embedded and no upstream source code is copied. This is not a learned router or
a model ranking: there is no forced provider rotation, weak-model-first rule,
failure prerequisite or automatic change to the user's saved model defaults.

## Behavior

1. The parent worker sees the current ticket allowance and currently allowed
   engine/model candidates, plus optional user-scope capability metadata.
2. It may request a self-contained helper task with a reason, before or after
   discovering a difficulty. A successful request receipt means admission only.
3. The parent saves its checkpoint and ends its turn. Only after that turn
   actually settles does the Host queue the helper in a separate hidden
   conversation, within the same ticket and workspace.
4. The helper's outcome returns as reference material to the original parent
   conversation, with the original engine/model/effort. The parent validates and
   integrates it, then completes the ticket normally. A helper result is never
   independently presented as the completed original task.

The ticket retains one concurrency slot throughout; only one attempt is active
at a time. This permits `maxConcurrent=1` without a parent waiting synchronously
for a helper that cannot start. The implementation does not promise that every
model will choose a helper or that each choice is optimal.

## App and CLI contract

The shared Host owns all transitions. Desktop/mobile continue using the existing
strict ticket and attempt readers; they can open the current execution
conversation and retain their pause/cancel controls. No UI-only implementation
or separate scheduler is introduced.

- `tickets dispatch TICKET ... --assist 0..2`: allowance for this dispatch chain;
  auto mode defaults to one, ask mode to zero. Continuations do not replenish it.
- `tickets assist-status --context-message MESSAGE`: worker's current allowance
  and request state. `tickets targets` and `tickets capabilities` also require an
  active worker context when called by a worker.
- `tickets assist --engine ENGINE [--model MODEL] [--effort EFFORT]
  --text-file FILE --note REASON --request-id ID --context-message MESSAGE`:
  bounded helper request; end the turn after an accepted receipt.
- `tickets assists TICKET`: owner or owning dispatcher reads the ledger.

The Hub resolves the parent from the authenticated current delivery and exact
current attempt. The worker cannot supply another ticket, parent or workspace,
manage other tickets, self-grant access, force an unavailable engine or nest
helpers. Request IDs are retained across uncertain responses. Explicit helper
`max`/`ultra` efforts are rejected in this version and must be addressed
through the coordinator's existing owner-confirmed dispatch workflow. Omitted
effort follows the engine's default; this is not an effective-effort or dollar
ceiling on native CLI defaults.

Ask-mode approval and owner model restrictions remain coordinator instructions:
the approved plan must include any nonzero helper allowance, and an explicit
single-target restriction requires `--assist 0` unless the owner permits help.
This change does not invent a machine-verifiable natural-language approval or
monetary budget. There is no claim that default engine settings establish model
quality or price.

## Persistence and compatibility

Schema **24** adds separate assistance records and per-dispatch allowance.
Existing dispatched tickets without an allowance record receive zero allowance,
even if their dispatcher is later switched to auto mode. A new dispatch grants
the configured allowance. Ledger reads return the latest 64 records in chronological
order, with `truncated` when older records exist; the database retains all records.
Strict ticket/attempt/conversation-marker JSON stays compatible with existing
App readers. Schema-23 runtimes must refuse the migrated database: otherwise
they could mistake the helper's answer for the parent ticket's final answer.
The package's advertised readable/writable schema range advances together.

Pause, cancellation, failures, restart and late worker preparation must preserve
the current attempt boundary. Partial helper work may have side effects and is
reported explicitly to the parent, never blindly replayed. A missing parent
worker or archived/unavailable original conversation blocks continuation with an
explanation; it does not create a replacement session or undo an owner's archive.

If the parent fails before yielding, its pending help is cancelled. Unavailable
helper targets return an unstarted outcome to the parent. Host draining and
temporary worker-permission transitions retry preparation. A helper failure
returns to the parent and does not independently complete the ticket or wake the
coordinator. The final ticket notice includes the assistance summary.

Shutdown invalidates in-flight preparation after each asynchronous boundary and
waits for admitted database transactions to commit or roll back. Late preparation
must not enqueue a new helper after shutdown. Same-ID retries are scoped to the
exact parent attempt; changing the ID cannot silently replace a pending task.

## Verification

Evidence directory: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-worker-assistance-20261102`.

- Final integrated focused run: **151/151** across 17 files, including actual
  Hub HTTP/Gateway delivery with model stubs, all five engine instruction paths,
  CLI parsing, credential scope, idempotency, cancellation, single-slot scheduling,
  old allowance records and shutdown races (`final-integrated-tests.log`).
- A subsequent public-API archive regression first failed with the ticket stuck
  in `working`. After the one-query fix, the relevant seven files passed
  **45/45**, including that new regression (`archive-parent-red.log`,
  `final-boundary-tests.log`). These overlap the integrated run; do not sum them.
  Opus independently reran six relevant files **60/60** after that fix
  (`opus-post-freeze-rerun.log`). The earlier `archive-parent-green.log` is
  actually a failed intermediate run due to an invalid test readback method;
  it is not passing evidence.
- Schema compatibility checks passed, including refusal to roll back a migrated
  schema-24 database to schema 23. Opus independently ran the full updater suite
  **45/45** and prompt queue suite **47/47**. These are separate coverage, not a
  single combined full-suite run.
- Production `npm run build` passed. The broader TypeScript project check reports
  an error at unchanged `src/codex/claude-adapter.ts:394`; this is not a claim
  that every repository check is green.

### Real model runs

All cases use isolated source-built Hosts, an owner-selected GPT 6.1 Sol/high
parent and `maxConcurrent=1`. They test execution-time assistance, not the
coordinator's initial autonomous model choice. Setup files record source and
built-file hashes; early model runs precede the final shutdown/archive hardening.

| Case | Observed result | What it establishes |
| --- | --- | --- |
| Explicit Claude assistance | GPT 6.1 Sol → Claude Opus 5.5/medium → original GPT native session; all three attempts completed in 58.0 s | Cross-provider execution and return of a real helper answer work. Provider was explicitly requested. |
| Neutral offline-sync review, help optional | GPT completed alone in 64.0 s; no helper | Help is optional; no spontaneous cross-provider selection was observed. |
| Independent update-state review, helper target unspecified | Parent selected GPT Sol/high. Test harness closed too early at the yield boundary; helper stopped in `conversation-prepare` before any native model session. Reopening the same state with the final build returned that failure to the original parent session, which continued and disclosed the missing review. | Graceful interrupted-helper recovery and honest failure continuation; not a successful independent helper review, native helper model run, or crash test. |
| Bounded concurrency review on the final build, helper target unspecified | Parent autonomously chose GPT 6.1 Sol/medium. All three attempts completed in 171.1 s; helper used a separate native session, parent resumed its original session with high effort and verified the answer. | Full final-build assistance and return without prescribing the helper's model or effort. It still chose GPT; no spontaneous cross-provider choice was demonstrated. |

`live-1793617932777/explicit-native-readback.json` verifies actual GPT and Claude
models from native logs, including the same parent session before and after help.
`live-1793618623449/resumed-native-readback.json` records the interrupted case:
the requested helper target is distinguished from an actually executed model.
The harness's terminal test was corrected to wait while ticket status is
`working`, including the interval with no active attempt. No ticket was
redispatched to conceal the interruption.
`live-1793619723287/native-readback.json` verifies the final-build case's actual
models, efforts, distinct helper session, restored parent session and completion
marker. Timing describes these particular runs under concurrent test load, not
a latency benchmark or improvement claim.

### Review and remaining limits

Opus 5.5 independently reviewed the Hub implementation and the protocol, CLI,
Gateway and documentation. Reproduced issues fixed during review include foreign
attempt receipt reuse, replacement of a pending task, retroactive allowance,
late preparation after stop, admission during stop, stale bounded history and
archived-parent continuation. Review reports and source hashes are retained in
the evidence directory.

This supplies a bounded execution-time help mechanism; it does not establish
optimal helper choice, reliable spontaneous cross-provider selection, or
comparative model quality. Ask-mode owner approval and natural-language target
restrictions remain coordinator instructions, not machine-verifiable approval
records. Persistent unexpected database/admission failures have no automatic
expiry; owner pause/cancel remains the recovery control. Two pre-existing archive
limitations also remain: redispatch to the same target still fails while its
reused conversation is archived, and archiving the coordinator's home can prevent
settlement notices from being committed. Restore the relevant conversation before
retrying; this change does not silently reverse an owner's archive. No claim is
made that all possible failures have been eliminated.

Installed-App, mobile, Windows and real-network acceptance were not performed.
This task does not release or replace the installed App.

## Follow-up checks

[Additional real tasks and the backup compatibility correction](dispatcher-worker-assistance-retest-2026-11-02.md) record the subsequent CI result, the schema-24 backup regression and three more model runs. The earlier focused/build passes above do not imply that the original full CI passed.
