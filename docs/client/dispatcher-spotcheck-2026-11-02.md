# Chancellor: additional real-ticket spot checks

The owner requested another small test after the permissive-selection change.
This run used source `1cd99290ae91b90f43e234fbaccdb14eb1998111` and its already
verified build. It changed no production code, Bot configuration or installed
App. These results supplement, rather than repeat, the preceding plan matrix.

## Actual execution

An isolated Host ran a persistent `gpt-6.1-sol/low` coordinator through the real
Gateway, Core, Bridge, CLI and worker path. Codex, Claude, DeepSeek and
Antigravity were allowed. Five tickets each had exactly one completed attempt;
all remained `needs_review`, without owner acceptance being fabricated.

| Task | Selection | Observation |
| --- | --- | --- |
| Extract meeting fields into JSON | Autonomous: Luna / low | Exact event, weekday/time, room and people; no invented date |
| Implement asynchronous single-flight deduplication | Autonomous: Luna / medium | Generated function passed controlled success, error and retry checks |
| Deduplicate a short array after the code task | Autonomous: Luna / low | Correct `[7,2,9,1]`; effort did not stay at the previous task's medium |
| Rewrite a connection notice | Owner-specified: Gemini 3.8 Flash Low / low | Correct brief notice preserving drafts and offering retry |
| Calculate `37×23` in ask mode | Owner-specified: DeepSeek default / low | Waited for confirmation, then returned `851` |

The ask-mode request explicitly told the coordinator to wait. It read the
catalog and proposed DeepSeek default/low without creating or dispatching a
ticket. The attempt count stayed **4 → 4**; only the subsequent confirmation
created and dispatched ticket five. This demonstrates compliance in this
prompted sample, not an unprompted discovery of the mode or a server-side
approval gate. The confirmation also carried the harness's task prefix, a
known difference from a bare user “yes”. No duplicate or abandoned draft ticket
was observed in this run.

## Worker output checks

The single-flight function was taken from the worker's ticket result, not the
coordinator's summary. It used a `Map`, deferred invocation with
`Promise.resolve().then`, and cleanup through both branches of `then`.
An independent in-memory Node VM check covered:

1. Same-key pending calls execute the function once and receive the same value.
2. A successful call is removed, so the next call executes again.
3. Different keys proceed independently.
4. A rejected call shares its error and permits a later retry.
5. A synchronous throw becomes a rejected Promise and permits a later retry.
6. Handled failures produce no unhandled rejection from cleanup.

All six checks passed. No file/network API was injected. This is bounded
generated-code testing, not proof for all possible functions or production
loads. The checker intentionally does not require an already synchronously
failed operation to remain coalesced until an arbitrary later point.

The initial Gemini keyword check returned **false** because it required the
literal word `保留`. The actual response was:

> 网络连接暂时断开，内容已存为草稿，您可以点击重试。

Manual semantic review found that it satisfies the draft-preservation, retry,
disconnection and length requirements without promising recovery time. The raw
false result is retained; a separate adjudication records this checker false
negative. The model was not rerun to obtain a green keyword result. The other
structured outputs were checked against the exact expected JSON or number.

## Native evidence and limits

- The three Codex worker transcripts independently recorded Luna efforts
  **low → medium → low**.
- The actual Antigravity process used
  `--model gemini-3.8-flash-low --effort low` and returned a completed response.
  This is not independent evidence of the provider's internal routing.
- DeepSeek's native session selection recorded
  `deepseek-official/deepseek-flash/low`. The ticket still uses the configured
  default entry; no backend model ID was pinned in product code.
- All **11** native coordinator execution contexts (six owner inputs including
  the plan/confirmation, five delegated notices) retained the selection and
  authority rules without truncation. Source/build hashes matched the run's
  setup, and the coordinator configuration remained `gpt-6.1-sol/low`.

Three autonomous tasks are a small ordered sample in one persistent session.
They show effort adapting in these cases, not optimal model selection or an
absence of provider preference. Gemini and DeepSeek were explicitly requested
and cannot be counted as autonomous cross-provider choices. The shared harness
prefix also excluded max/ultra and discouraged artificial provider rotation;
these task-specific constraints are part of the evidence.

Artifacts, exact prompts and raw results are under
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-spotcheck-20261102/`;
the run is `live-2026-11-02T03-35-09.896Z/`. `native-readback.json` distinguishes
parameter delivery, output adjudication and generated-function checks.
Opus 5.5 reviewed the coverage and worker code independently. This spot check
found no new product defect requiring a code change. No release or installation
was performed. The previous code commit's Source checks and Secret scanning
GitHub runs also completed successfully.
