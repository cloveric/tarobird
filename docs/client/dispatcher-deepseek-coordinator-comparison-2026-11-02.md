# DeepSeek Chancellor: real six-task follow-up

The owner requested the same selection experiment with a DeepSeek Chancellor.
It autonomously selected DeepSeek for one task, Claude for four, and GPT for one.
The native records confirm actual execution, not only a proposed selection.
However, the coordinator accepted an inadequately specified synchronization
merge rule: a small reviewer counterexample produces different content for
different merge groupings. Routing diversity does not establish review quality.

## Conditions

Runtime/source is `a259b3821def5e5c0c66f039a89b3473c866c7f9`, identical to the
[previous GPT/Opus comparison](dispatcher-opus-coordinator-comparison-2026-11-02.md).
The task strings and all six target-catalog snapshots match that comparison.
Each case uses a fresh Chancellor and conversation, empty persona, auto mode,
concurrency one, and allowed Codex/Claude/DeepSeek/Antigravity engines. Kimi is
not allowed. No task specifies its worker model or vendor. The prompts require
the normal ticket workflow, supplied-data text answers, no browsing, and no
personal/project file access. Native context records retain the quality-first
and provider-neutral selection instructions.

DeepSeek was created with empty model/effort fields, preserving the current CLI
default. The actual native request contexts and model-selection projection show
`deepseek-official / deepseek-flash / low` for all six coordinators. Do not call
this run DeepSeek Plus or infer a different backend from an older display name.
Prior GPT and Opus coordinators used xhigh; effort labels and defaults do not
represent equivalent compute budgets. Runs occurred at different times, and
engine adapters package context differently.

## Actual selections

| Supplied task | DeepSeek Chancellor's worker | Attempts |
|---|---|---:|
| Aggregate inventory into JSON | DeepSeek default, native `deepseek-flash` / low | 1 |
| Three Chinese support-message tones | Claude Sonnet 5.5 / medium | 2 |
| English and Japanese product translation | Claude Sonnet 5.5 / medium | 2 |
| Promise deduplication race review | Claude Sonnet 5.5 / high | 1 |
| Stratified conversion and causal judgment | GPT Sol (`gpt-6.1-sol`) / high | 1 |
| Offline multidevice synchronization protocol | Claude Sonnet 5.5 / high | 1 |

All eight attempts completed. All six tickets remained `needs_review`; no owner
acceptance was synthesized. There were no worker-assistance ledger entries.
Claude session records confirm `claude-sonnet-5-5`; its effort values above are
the dispatch settings. Codex native turn records also confirm model and effort.
DeepSeek's native request contexts confirm provider/model, with effort in its
model-selection projection. The harness exited zero and shut down the isolated
Host and managed workers.

## Independent answer checks

- Inventory JSON has exact fields, quantities, order and units after removing
  the App presentation heading.
- The coordinator requested a same-model wording revision from third-person
  “用户” to direct address “您” for the formal support notice, then combined all
  three variants. Their actual lengths including punctuation are 59, 47 and 56
  characters, all within 60. The reported counts 53/39/48 are inconsistent with
  these counts and are not accepted as measured evidence. All five supplied
  facts remain present, without blame or a promised recovery time.
- Translation received a same-model revision to restore the temporary sense
  with “for now”. Both English and Japanese preserve closing without deletion,
  device-local storage and no automatic synchronization. This is a reviewer
  semantic check, not blinded native-speaker scoring.
- The code answer identifies the discarded `finally` rejection and synchronous
  reentry, and distinguishes optional Promise-return consistency from the hard
  requirements. Its exact main proposed function passed seven isolated reviewer
  checks: concurrent deduplication/retry, synchronous and asynchronous failures,
  reentry, plain values, direct self-resolution rejection, and old cleanup not
  deleting a new immediate retry. These test generated answer code, not a new
  TaroBot production change. Its suppression of unhandled rejection reporting
  for ignored return values is an explicitly disclosed tradeoff.
- Statistics has correct overall 15.45% versus 56.36%, subgroup 9% versus 20%
  and 80% versus 60%, and old-mix reweighting to 23.64% (+8.18 points). It correctly
  refuses a causal conclusion and suggests stratified randomization. The worker
  body is 493 non-whitespace characters, within the 500-character limit.
- The protocol covers the requested topics, but is **not accepted as a reliable
  protocol design**. It claims that max-merging version vectors and selecting
  content by the current vector sum is associative. Under that written rule,
  concurrent A={A:2}, B={B:3}, C={C:4} gives B for `(A merge B) merge C` and C for
  `A merge (B merge C)`, while both final vectors are identical. Preserving an
  independent immutable winning-operation rank would be an additional rule,
  absent from this answer. The counterexample models the answer literally; it
  is not a test of TaroBot's synchronization implementation. The coordinator
  accepted the claim and treated the sum rule only as an optional fairness
  concern. It also noticed missing ordered delivery for a max-sequence cursor
  but called it optional, although unordered delivery requires explicit gap
  handling. The answer counts only its 616 Han characters; its complete body
  contains 1,116 non-whitespace characters, so it does not meet the same full
  character-count convention used for the earlier comparison.

## Interpretation and boundaries

This run establishes autonomous cross-provider selection with a DeepSeek-based
Chancellor. It selected Claude or GPT in five of six cases, without an owner
model preference. The previous GPT arm selected GPT six times; the Opus arm
selected Claude five times and GPT once. None of these small arms selected
Gemini. Provider labels alone do not prove task suitability; the coordinator's
stated capability judgments were not independently benchmarked.

Each case is one sample. This is neither an optimal-router evaluation nor
proof that DeepSeek is the best coordinator. Worker prompts and review choices
are coordinator-generated, and compute budgets differ. Routing and completed
attempts must be reported separately from accepted output quality. The protocol
miss is retained in the evidence rather than repaired and presented as the
original answer.

No routing policy, UI copy, engine permission, production Bot configuration,
installed App or release changed. This is a source-built isolated model test,
not installed-App acceptance. CLI uses the existing shared ticket path; no new
CLI capability was needed.

## Evidence

Lab: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-deepseek-coordinator-20261102/`.
Run: `deepseek-live-2026-11-02T12-57-07.730Z/`.

`test-protocol.json`, `compare.mjs`, `comparison-integrity.json`, native readback
with source-file hashes, `answers.json`, `semantic-review.json`,
`check-answers.log`, `protocol-counterexample.json` and `evidence-manifest.json`
record the conditions and results. Source/build fingerprints were rechecked.
Temporary extraction-script syntax errors were corrected before final readback;
they did not rerun or alter any model task. Documentation-only commit: no new
production build or unrelated regression run was needed.
