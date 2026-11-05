# Opus versus GPT Chancellor: real paired selection test

The owner requested an Opus-based Chancellor comparison. Six supplied-data
tasks ran once per coordinator against source
`a259b3821def5e5c0c66f039a89b3473c866c7f9`. The Opus coordinator autonomously
selected a GPT worker for the synchronization-protocol task. This establishes
one real cross-provider choice without an owner-specified worker model; it
does not establish optimal routing or general superiority.

## Conditions and actual execution

Each arm used its own isolated Host, a fresh Chancellor and conversation per
case, empty persona, auto mode, concurrency one, and the same six task texts.
Both allowed Codex, Claude, DeepSeek and Antigravity. All six paired target
catalog snapshots compare equal. Kimi was not allowed in either arm. No
production Bot settings, persona, model, App or data were changed.

The coordinators were Codex `gpt-6.1-sol/xhigh` and Claude
`claude-opus-5-5/xhigh`. Native session records confirm the coordinator and
worker models. Claude catalog aliases resolved to Haiku 5.5 and Sonnet 5.5.
Effort values below are dispatch settings; Codex also exposes them in native
turn records, while the Claude model records used here do not independently
report effort. Matching effort labels do not imply equal compute budgets.

| Supplied task | Opus Chancellor's actual worker | GPT Chancellor's actual worker |
|---|---|---|
| Aggregate inventory into JSON | Claude Haiku 5.5 / default | GPT Luna / low |
| Three Chinese support-message tones | Claude Sonnet 5.5 / low | GPT Luna / low |
| English and Japanese product translation | Claude Sonnet 5.5 / medium | GPT Luna / low |
| Promise deduplication race review | Claude Sonnet 5.5 / medium | GPT Sol / medium |
| Stratified conversion and causal judgment | Claude Sonnet 5.5 / medium, two attempts | GPT Luna / medium |
| Offline multidevice synchronization protocol | **GPT Sol / high** | GPT Sol / medium |

`GPT Luna` is `gpt-6-luna`; `GPT Sol` is `gpt-6.1-sol`. All thirteen worker
attempts completed. All twelve tickets remained `needs_review`; completion
does not substitute for the owner's acceptance. The two harnesses exited zero
and shut down their isolated runtimes.

These runs test initial coordinator selection and subsequent review, not
owner-selected parents or a worker-assistance trigger. Task prompts name no
provider/model/effort, but explicitly request the normal ticket workflow.
Coordinators can rewrite the worker task, so this is an orchestration comparison,
not a blinded comparison of workers receiving identical prompts. Engine adapters
also package context differently. Each arm retains its own engine health across
cases; the saved per-case catalogs show no between-arm target differences.

## Result checks

- Both inventory results have exact quantities, fields, units and order.
  The stored App presentation heading was excluded from JSON parsing.
- Both writing results preserve the five supplied facts, avoid invented repair
  times/blame, and keep each message within 60 characters including punctuation.
  Both translations preserve closing-versus-deleting and device-local storage.
- Both code answers address the ignored `finally` rejection and synchronous
  reentry. Their main proposed functions were copied verbatim into isolated
  fixtures: ten checks across the two implementations plus one correction check
  passed, **11/11**. These are reviewer checks of generated answers, not new
  TaroBot implementation regressions. The GPT answer more carefully distinguishes
  an optional always-return-a-Promise contract from the original requirements.
- Opus independently caught and corrected Sonnet's claim that directly resolving
  a Promise to itself waits forever: it rejects with a chaining-cycle TypeError.
  Opus also qualified an overly absolute statement about unhandled-rejection
  observability. It kept the worker model rather than redispatching this case.
- For statistics, Opus requested one same-model revision for excessive length
  and imprecise Simpson-reversal terminology. Final arithmetic and noncausal
  conclusions are correct in both arms: overall 15.45% versus 56.36%, new-user
  9% versus 20%, old-user 80% versus 60%. Final text lengths excluding whitespace
  and the App heading are 481 and 455 characters. Extra sample-size figures in
  the Opus arm are planning approximations, not observed evidence.
- Both protocol answers cover identity, causal revision, duplicate/order
  handling, deletion, stale-device reconciliation and clock limits. They have
  different costs: the Opus-selected worker relies on durable per-device
  watermarks/result lookup and a recovery area; the GPT-selected worker uses a
  global epoch with resnapshot/manual recovery costs. These are conceptual
  designs, not implementations proven safe under distributed-system stress.

## Interpretation and limits

The Opus arm selected Claude for five tasks and GPT for one. The GPT arm selected
GPT for all six. Neither selected DeepSeek or Gemini. Installed/allowed catalog
entries do not independently verify those services' live authentication/quota.
This small sample supports the existence of autonomous cross-provider routing
with the Opus coordinator; it does not explain all causes of provider preference,
demonstrate that changing the production coordinator is always beneficial, or
establish that a different provider would have produced a better answer.

No new routing rule, forced rotation, vendor ranking, release or installation
was introduced. Real-model evidence is source-built and isolated, not installed
App acceptance. Hosts ran concurrently; timings in the raw results are not a
latency benchmark.

## Evidence

Local artifacts:
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-opus-coordinator-20261102/`.
`compare.mjs`, `test-protocol.json`, `comparison-integrity.json`, both
`*-live-2026-11-02T12-21-56.457Z/` runs, native readbacks with file hashes,
`semantic-review.json` and `check-answers.log` preserve the conditions and results.
Source/build fingerprints were rechecked after all tasks.

Separately, the previous schema-24 backup fix at the tested source revision now
has successful [source/native CI](https://github.com/cloveric/tarobot/actions/runs/41443364578)
and [secret scanning](https://github.com/cloveric/tarobot/actions/runs/41443364456).
This does not turn this model-selection experiment into installed-App evidence.
