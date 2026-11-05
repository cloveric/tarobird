# Claude input during background-result processing

A completed background task can start its own Claude `task-notification` review
long after the foreground reply ended. Previously `waitForReviewAdmission`
kept a new App message outside Claude until that review finished, even when the
user chose **补充**. The displayed “等待后台任务结束” also confused the review
with the background tasks themselves.

The repair allows negotiated, authenticated plain-text **补充** to enter the
native pending-input flow during an owned review. **排队** still waits for the
current work to end. No `priority:"now"`, stop/restart or resend approximates
ordinary input. This change is source-only; it does not install or release an App.

## Native evidence and chosen behavior

Opus 5.5 xhigh independently investigated Claude Code **2.1.309**, reviewed the
implementation and exercised the App fixture. Six isolated real CLI probes used
Sonnet with low effort; the reviewing model and probe model are different.

- With another model request after a review tool, an input is first `queued`,
  then `started` at that request. The next reply and result name its UUID, although
  the result's origin remains `task-notification`.
- If the review finishes without another model request, the queued input starts
  as a separate native turn after the old result.
- An input can enter the queue between the task notification and review `init`.
  Host arrival time is therefore not evidence of reply ownership.
- `completed` or `cancelled` can precede the result. A stop fence must retain
  historical owned UUIDs until its own result, not just live command IDs.
- Native `send_now` during a review can move a tool into the background and reject
  parallel work. It is not exposed for a review-origin turn. The adapter also
  enforces this restriction for direct control calls.
- A native `cancel_async_message` answer of `cancelled:true` proves withdrawal.
  The lifecycle notification alone does not prove that the host withdrew it.

See the [CLI queue documentation](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
and the [existing native-input implementation](claude-native-input-2026-10-24.md).
Local frame recordings, including the no-origin comparison, are the evidence for
behavior beyond the public documentation.

## App and CLI entry points

The existing **补充 / 排队** choice is reused. A live review report triggers a
fresh capability read even with no foreground reply, so it need not wait for the
idle polling interval. This extra activity signal is scoped to Claude.

| Choice/state | Behavior |
| --- | --- |
| 补充, direct plain text | Starts a new real host turn; Claude may take its prompt into the review or start a separate native turn. |
| CLI 已接收 · 待处理 | Actual native queue receipt, not a claim that the model has read it. |
| 等待 Claude 读入 | The new reply placeholder while its input is still pending. It is not labelled “正在思考”. |
| 模型已收到 | Existing model-receipt evidence, distinct from dequeue and execution completion. |
| 撤回编辑 | Restores the text only after the CLI confirms withdrawal; the unused reply card is finalized and recalled. |
| 结果待确认 | No duplicate submission, no fabricated rejection, and no automatic worker kill. Later native evidence can upgrade it. |
| 排队 | Existing durable message delivery, still waiting for the current review. Its notice now says “等待后台结果处理”. |

`tarobot steer status CONVERSATION --bot BOT` reads the same target;
`steer send ... --target ID --mode message` submits ordinary input, and
`steer cancel ... --message ID` withdraws it. No separate CLI implementation or
queue is introduced. Explicit steering without `--mode message` still targets
an actual foreground run, not a background review.

## Protocol and ownership

`claude.native-input.review.v1` is an additive worker capability. New App/CLI
status requests opt in with `review=1`; the Hub sends `backgroundReview:true`
only to a worker advertising it. A background target looks like:

```json
{
  "supported": true,
  "targetId": "opaque-current-review-token",
  "targetKind": "background-review",
  "sendBehavior": "steer",
  "nativeInput": { "sendNow": false, "cancel": true, "modelReceipt": true }
}
```

This is an input target, not a fake active run. It grants no stop or App-tool
capability to a background card. The old A+C grouped subagent cards, task dock,
individual process records and scope/origin/provenance validation are unchanged.

On submission the Hub passes the exact steering record ID to the Gateway.
The Gateway rereads and validates author, conversation, Bot, request ID, target,
mode and text; checks session binding and the absence of another run/queued job;
and dispatches that record as a new Core turn. Synchronous review admission
reservations and the Channel's inbound-admission check cover the receipt-fsync
window before Core claims the turn. They prevent a second review-target request
from slipping behind already-received work; active foreground inputs retain
their existing path. `native-turn:<messageId>` is a
fsynced at-most-once receipt. The steering record has no delivery row, so this
path must not emit ordinary delivery acknowledgments.

`reviewAdmission:"native"` and a native-input observer travel through Core and
Bridge only on the first engine call. Repair/recovery calls do not inherit the
intent. The owner key is derived by Bridge from the trusted conversation lock,
not from user text. All retained tasks and queued reviews must belong to that
same conversation. Unknown or foreign owners are denied, as are full tracking
registries, stop fences, older protocol capabilities and a changed target.
Pre-write denial is explicit; it does not silently fall back to waiting.

The new host turn owns no review output, approval callback or native App tool
before its command starts. The lifecycle, or stronger UUID-stamped native
request/reply/result evidence, performs the handoff. An already-open review's
pre-input public text stays with its old readonly scope; subsequent output and
App tools belong to the new request. A queued-but-not-started review retains its
bounded grace instead of being fabricated as active. A result naming the new
input settles it even with task-notification origin.

Stop fences keep their owned UUID set and review-input flag after their promise
has timed out, so a late native start cannot escape the original stop. Existing
explicit Stop scope is retained; this change does not promise that stopping an
already-consumed mixed turn spares all native subagents. Withdrawal of an
unconsumed message only cancels that message and does not interrupt the review.

## Compatibility and remaining boundaries

- Old App, Hub, Gateway or CLI stays on the existing waiting path. No new field
  is sent to an older Gateway's strict call schema. Historical cards still work.
- Attachments, references, commands, groups, scheduled/Bus/cross-Bot inputs and
  recovery continuations retain their existing durable routes. They are not
  converted to text-only native input. Other engines keep their existing behavior.
- Review prompt construction includes private host instructions, so it does not
  inherit the plain-text steer's `origin:{kind:"human"}` marker. Real CLI probes
  confirmed that ordinary review admission works without that marker.
- On complete loss of admission receipts, the input stays uncertain and owned
  until native evidence or explicit scoped cancellation resolves it. Releasing
  it and letting another request take the slot would risk a late answer being
  attached to the wrong request. An uncertain receipt is not an automatic retry.
  If Stop also receives no terminal evidence, the existing unconfirmed-stop
  fence continues to block new input. Explicit task recovery can end that native
  process; the repair does not silently do so or claim that work was cancelled.
- A consumed input cannot be rewound. Native send-now is withheld throughout a
  review-origin turn. Costs for a folded turn include the preceding review work,
  consistent with the existing native cumulative-usage baseline.
- Adding a link from the old review card to the new reply, and changing the
  older held-steer continuation presentation, are separate follow-ups. This
  repair does not redesign the accepted subagent presentation.

## Validation

Local evidence folder: `claude-background-input-20261025` (external audit output,
not committed with private machine metadata or raw native frames).

- Full root regression: **6,754 passed, 5 conditional skips**, across 498 files.
  Host standalone build and client production build passed. Final admission
  guards were additionally checked after the full run: Opus's **156** Gateway,
  delivery-recovery, Agent Bus and prompt-queue cases passed; the final root
  build and **75** focused cases passed. These overlapping suites are not added
  together as a distinct-test total.
- Adapter review-input regression: **28 passed**, including direct send-now
  rejection for a secondary input on an adopted review turn.
- Browser: **2** new desktop/390 review-input cases, **30** existing native-input,
  send-choice and steering cases, and **7** stop/recovery cases. One fake-microphone
  recording assertion failed in the 30-case batch; its four-case file passed on
  an isolated rerun. This is recorded as an intermittent test, not an entirely
  clean first-pass browser run. WebKit and physical devices were not exercised.
- Opus independently reviewed two adapter snapshots. The first review found
  seven ownership/lifecycle issues; all were corrected and approved in the
  second review. A further Gateway review checked admission before Core claims
  the turn, including concurrent requests. The old subagent card grouping and
  its readonly scope controls were not redesigned.

- Real adapter + installed CLI: input queued during a foreground review tool,
  folded result owned by the new message, native App tool bound only to the new
  request; confirmed withdrawal while the original review continues. A further
  fold probe passed after removing the human-origin marker.
- Real Hub/Gateway/Core roundtrip with a scripted engine: exact input ownership,
  independent reply bubble, durable receipt replay without duplicate execution,
  native progress stored on the original input, no ordinary pending delivery.
- Regression cases include old CLI gates, foreign owner rejection, grace races,
  independent next turn, missing start events, native receipt timeout/late ACK,
  failed cancellation, lifecycle/ACK ordering, stop races and late starts,
  pending terminal states, App-tool/approval isolation, queue preservation and
  readonly scoped card regressions.
- Browser screenshots use the built App with a real isolated Hub/Gateway/Core
  and scripted engine. They are desktop/390 CSS-pixel evidence, not physical
  iPhone/Android or native Mac-shell acceptance. Production Host was not restarted.
