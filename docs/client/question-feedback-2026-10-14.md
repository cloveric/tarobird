# Answer submission and Claude background follow-up

## Confirmed failure

A submitted native question displayed only its answers and “已提交”. In the
reported incident, read-only comparison of the host timeline and the matching
Claude session confirmed that the CLI recorded the answer within milliseconds.
It then continued using tools, but the App received no intermediate feedback
before the later background report. The answer was not lost and the user's
subsequent prompt was not what resumed the task.

The cause was the separate Claude synthetic background-review path: it
intentionally keeps its text and tools out of the foreground conversation's
run card. That isolation must remain, but it also hid all progress after a
question in that review. A terminal original run card cannot be reopened to
show those events.

## Behavior

- Every native App question receipt explicitly acknowledges the answer and
  says it need not be submitted again. Offline/unsent questions keep their
  existing outbox states; they are not optimistically marked received.
- For Claude background questions, the same receipt shows a compact continuation
  status from actual CLI events: sent, processing, reading/editing/searching,
  executing a command, or preparing a reply. No additional prompt or duplicate
  answer bubble is generated. Raw arguments, outputs and private thinking are
  not copied into this receipt.
- A generated reply is labelled generated, not delivered or task success.
  Final text/files still use the existing original-task delivery path.
- Process exit, unconfirmed/empty results and another question have explicit
  terminal receipt states. Late progress cannot reopen these states. Repeated
  tokens in the same phase do not repeatedly patch the message.
- The observer is local to the task that asked the question. Another task's
  result or a later foreground turn cannot finish or update its receipt.
  A response arriving after the review has closed is not sent as an accepted
  decision to a newer review.
- Retained approval callbacks now bind the App rendering profile, just like
  retained stream callbacks. Late questions therefore retain the native form.

## Compatibility and limits

`supportsAnswerProgress` and `onAnswerProgress` are host-local optional adapter
contracts. They never enter CLI permission JSON or the strict App wire schema.
The receipt uses ordinary Markdown and works with existing desktop and phone
clients. Other engines retain their existing native answer/resume paths and
gain the generic receipt text; only Claude's background review opts into the
additional observer. No network, session-binding, permission or database
migration is introduced.

Headless CLI and bundled desktop host share these changes. No new command is
needed. A subsequent release must ship the same host revision in both artifacts;
a source push does not update an installed App or running host.

Validation covers native Claude frame replay, answer-delivery JSON, late/foreign
results, process exit, duplicate submission, retained callbacks outside their
original async context, plus real disposable Hub/Gateway browser journeys at
desktop and phone sizes. Browser checks are not physical-device acceptance.
The full test gate also exposed an older Telegram fixture that assumed a
missing background status meant completed; it now covers both explicit
completion and the truthful missing-status update. No Telegram runtime change.

This change does not reduce model inference time or replay the user's original
task. It makes actual continuation activity visible without mixing contexts.

## Verification results

- Full host gate: 268 test files; 3498 passed and 1 skipped.
- Final host build and client translation/type/Vite build passed.
- Chromium: 9 question/continuity journeys passed, including phone/desktop
  receipts, draft retention, offline answers and cross-device resolution.
- WebKit: 4 continuity journeys passed across the run and targeted retry.
  One existing desktop journey initially timed out at the first pairing click;
  it passed unchanged on retry. Both new answer-feedback journeys passed first
  time. No physical phone or installed desktop update was performed.
