# Recover after a transient provider failure with a yielded command

Two audit-coordination turns failed on October 30 with Codex's structured
`serverOverloaded` error. Each had one Bash command still running after its
execution tool returned a background session. The shared Bridge immediately
stopped recovery because it had no terminal tool receipt. The guard prevented
blind replay, but the missing wait-and-reconcile path unnecessarily ended the
user's task.

This was a Host recovery defect exposed by an upstream capacity failure, not
evidence that the Electron renderer or migration caused the provider outage.
The [verification ledger](engine-recovery-pending-tools-2026-10-30.json) binds the
source files and retained evidence by SHA-256.

## Reconciliation of the previous tasks

Read-only native queries, restricted to the exact failed turn and its command,
confirmed both commands eventually completed with exit code 0. Their recorded
durations were 419,334 ms and 973,375 ms. The second was the pre-completion check;
the first was the earlier Mac build/notarization command. Neither was replayed.

The substantive work had already been continued and checked in:

- [DeepSeek audit and adjudication](electron-deepseek-audit-2026-10-30.md):
  `5c2ff906fa01cb1fa0dc174052387d83883e4a30`.
- [Kimi audit and independently reviewed fixes](electron-kimi-audit-2026-10-30.md):
  `3cdb88642a2b8f458838f0e541cbf04d714efe0c`.
- [Subsequent desktop latency/stability work](electron-latency-stability-2026-10-30.md):
  `feb3d66c76b5bb419f24497ae0c79de8f81e87a6`, the base of this change.

The historical failed cards are not rewritten as successful runs. Recovered
source work and the original failed attempt remain distinct evidence. The
owner's publication/install hold remains in force; prepared 1.0.121 installers
predate the later repairs and must not be represented as containing them.

## Changed behavior and safeguards

After a confirmed native foreground failure eligible for transient recovery,
Codex can provide a read-only reconciliation callback for command IDs it
actually observed starting in that exact turn. Bridge retains the session lock
but releases the execution-pool slot. It waits for authoritative terminal
records, then follows the existing backoff and same-session continuation path.
It does not resend the original prompt, input files, commands or deliveries.

- Native `thread/items/read` requests contain the exact thread, turn and item
  IDs (at most 100), with a 5-second RPC timeout. They do not start or resume
  a native turn. Only `completed`, `failed` and `declined` are terminal evidence.
- **Empty persisted reads are expected while a command runs.** They keep the
  known command pending, as does `inProgress`. Unsupported responses, foreign
  entries and unknown states never imply completion. Three consecutive read
  errors end reconciliation without clearing the pending tool.
- Poll intervals grow from 5 to 15 to 30 seconds. Waiting is bounded at
  approximately 30 minutes (a final in-flight read has its own 5-second cap)
  and by the original logical turn's remaining runtime. Tool waiting does not
  consume the separate 10-minute provider-outage window.
- The adapter pins its native process against idle recycling while the receipt
  is handed to Bridge and while reconciliation runs. Unclaimed receipts expire
  after 60 seconds. Claimed/rejected receipts release their lease exactly once.
  Losing the native owner prevents queries against a replacement process.
- Only matching native `tool_result` events clear Bridge's tool ledger.
  Resolving the callback is not itself proof. Anonymous tools, unsupported tool
  types, unfinished subagents/background jobs and conflicting session/input
  receipts retain their existing fences. Other engine adapters are unchanged.
- Finished foreground turn IDs are bounded and remembered so late events cannot
  be adopted by a continuation whose new ID has not arrived. Late App file calls
  still receive the existing explicit non-delivery response.
- Waiting progress is localized and labelled `[TaroBot]`. If the native record
  omits stdout, the terminal notice reports only its actual status/exit code;
  it does not fabricate command output or erase previously streamed logs. The
  final status follows the historical waiting notice and the entry becomes done.
- Stop aborts reconciliation and starts no continuation. It does **not** prove
  the old command was stopped. Runtime exhaustion has a separate localized
  explanation, rather than implying that the user pressed Stop. Both preserve
  uncertain command outcomes. Once the lease is released, a deferred native
  recycle may also end the command; neither survival nor cancellation is claimed.

This is shared Host logic for App and headless CLI. It needs no separate CLI
command, renderer protocol event, mobile layout change or engine preference
change. Successful recovery preserves accounting, original runtime limits,
session ownership, cancellation handling and continuation instructions.

## Verification and independent review

- **448 tests passed in 14 suites**: reconciliation, Bridge, transient recovery,
  Codex adapter/side sessions/usage, shared-session ownership, Gateway native
  input, Core recovery/classification and Claude retry regressions.
  The final streamed-log preservation adjustment then passed 150 targeted tests
  in 2 suites; Opus independently reran 143 recovery tests on the final file
  hashes. These counts overlap and are not added together.
- Tests include a 16-minute virtual command wait, missing persisted records,
  exact native terminal summaries, wrong IDs/turns, unknown status, repeated
  read failures, user Stop, already-expired/runtime deadlines, owner loss,
  lease release, late successful/failed-turn events and an actual Bridge plus
  adapter integration that sends one continuation and no original-prompt replay.
- `npm run build` passed; standalone dependency graph has 464 modules.
- A real isolated Codex CLI command, with no model credentials/request, exercised
  the compiled reconciler: the first read was empty at 395 ms, the command ended
  at 2,488 ms, and a later exact read published one terminal receipt at 5,398 ms.
  Only one shell command ran; no `turn/start` or `thread/resume` was sent.
- Actual Opus 5.5 independently reviewed the design and candidate. Its separate
  native probe established the empty-read behavior. The review also prompted
  separate Stop/runtime-deadline wording and preservation of file non-delivery
  receipts. Review reports and sanitized native evidence are retained locally.
  Final review found no blocking issue within this scope. Its last non-blocking
  stdout-preservation finding was fixed and independently checked in both the
  run-record and card reducers before submission.
- The optional repository-wide `tsc --noEmit -p tsconfig.json` check is not clean:
  129 diagnostics across 59 files. The unmodified base produces the same 129
  diagnostics, normalized path-for-path, with no added diagnostics in this change.
  Production compilation above passes; this is not a claim that all test sources
  in the repository type-check.

The original provider-capacity incident was not induced again against a real
model. Native command reconciliation and scripted end-to-end provider failure
are distinct tests. No release, installed-App update, production Host restart
or Windows/device acceptance is included in this source-only repair.
