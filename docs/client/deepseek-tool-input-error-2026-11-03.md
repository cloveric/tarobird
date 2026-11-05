# DeepSeek malformed tool arguments (2026-11-03)

## Incident and evidence

The owner screenshot showed a completed worker ticket followed by a failed
Chancellor response while processing the completion notice. The installed Bot's
operational timeline records the follow-up from 07:54:19 to 07:54:32 China time:
one `bash` and three `read_image` calls each had a result, then the turn failed
with `DeepSeek Harness agent failed: DeepSeek Messages stream: tool input is invalid JSON`.
This establishes failure in the follow-up; it does not invalidate or accept the
worker's video quality. No owner ticket was dispatched again or marked accepted.

The installed Harness is 0.2.1-rc.4. Its `dsh-llm-deepseek/lib/index.js` provider
adapter emits this diagnostic when `JSON.parse(content.arguments)` fails at
`message_stop`, after assembling streamed tool arguments. TaroBot receives that
failure through `host/agent-error`. The initial investigation only inspected the
App timeline and could not distinguish malformed model output from a Harness
assembly defect. The follow-up below recovers the failed arguments from the
Harness journal; the original HTTP/SSE bytes remain unavailable.

## Follow-up: worker result to Chancellor delivery

The owner's request to trace the video handoff led to the compressed native
`session.v4.jsonl.zstd` journal. Its failed `assistant/attempt` retains translated
argument deltas even though no successful `assistant/message` was recorded.

1. The worker completion notice contained text and absolute file paths, not a
   video attachment. The shared Host settlement route sends `attachments: []`.
2. DeepSeek successfully ran `ffprobe` on the file: H.264, 1920×1080, 30 fps,
   150 frames, 5.000 seconds. Its three `read_image` results are successful and
   contain the start, middle and end frame image references.
3. In turn 3, step 4, it attempted `app_send_batch` for the video and those three
   images. The 975-character argument string contains one complete JSON object
   ending at character 974, followed by an extra `}`. The last argument deltas
   separately contain `"`, `}`, `}`; joining the recorded deltas is byte-identical
   to the persisted block-end argument string.
4. The same step also proposed a valid `bash` call to update the ticket note.
   Neither proposed call has a corresponding `tool/call` execution event. This
   provider message failed before the App batch publisher ran; it did not produce
   a successful batch receipt. The four referenced files still exist.
5. The coordinator dispatched `--engine claude --model sonnet --effort high`.
   The worker's native Claude stream contains 39 assistant records with model
   `claude-sonnet-5-5`. This particular worker was Sonnet, not Opus.

The observed failure is malformed generated delivery-tool arguments, after the
worker result had reached the coordinator and its local media checks succeeded.
No evidence in this trace shows a TaroBot video handoff corruption. This is a
specific incident conclusion, not a guarantee about all video or Harness flows.

## Change

Previously the `DeepSeek ... failed` prefix matched the generic `engine-cli`
classifier and told the owner to restart the instance. The exact provider
diagnostic now has the `engine-tool-input` category. App and shared CLI-facing
error rendering explain the invalid arguments and ask the owner to reconcile
completed work before continuing, without requiring restart. Raw tool parameters
and appended diagnostics are not rendered. Persisted audit records retain the
new category, including when the displayed text is localized.

This category does not advertise an automatically retryable Bus error, trigger
transport recovery, or classify the worker engine as crashed/quota-exhausted from
its displayed text. A previous tool can have effects before this provider failure.
The change does not repair JSON, execute partial arguments, replay the original
request, alter model selection, or change an installed Harness package.

## Validation and boundary

- Before the fix, two focused regressions failed with `engine-cli` instead of
  `engine-tool-input`.
- Five focused suites passed, 219 tests: error classification/rendering, audit
  persistence, DeepSeek adapter lifecycle, engine recovery and Core recovery.
- Adapter coverage uses a fake Harness transport and verifies the malformed
  `host/agent-error` ends its turn without submitting another prompt, and that an
  explicit subsequent turn can succeed in the same session.
- Production standalone build passed (recorded in the task evidence directory).
- CLI impact: shared failure classification, actionable error text and
  non-automatic-retry semantics; no new command or permission change.

Follow-up offline verification used the **unmodified installed public
`DeepSeekAdapter`** with a fixture `fetch` response, no credentials, no network and
no tool execution. SSE events were reconstructed from the persisted tool-argument
deltas. The original extra-brace data reproduced `MALFORMED_RESPONSE`; a control
removing only that last brace parsed successfully. Both variants passed at 1,
31 and 65,536-byte response chunking (6/6), with exact argument preservation by
the parser. This supports the generated-argument diagnosis and did not reproduce
a chunk-assembly defect. It is not a replay of the original wire bytes, a live
model test, or authorization to repair/re-execute owner tool calls automatically.

The owner's failed response was not resumed by this task.
No installed App, Host, owner settings or conversation history were changed.
This source fix has not been released.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/deepseek-tool-input-error-20261103/`;
the `followup/` directory contains bounded journal evidence and the offline
provider probe/results. Private argument paths stay in the local fixture.
