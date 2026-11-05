# Chancellor multi-engine selection: bounded live sample

## Scope

The owner requested a small series of real tests of autonomous selection among
GPT, Claude Opus, DeepSeek and Gemini. This run tests source
`fc3183a71c8110901ffbc6c9e9117e055460ab57`, including the routing/context repairs.
No product code, production Bot settings, release or installed App changed.
The installed Mac was still 1.0.125 when the evidence was closed.

An isolated Host used the production Hub, BotManager, Gateway, Core, Bridge,
engine adapters and bundled ticket CLI. The real coordinator ran
`gpt-6.1-sol / xhigh` in auto mode, one concurrent worker, with Codex, Claude,
DeepSeek and Antigravity all allowed. Each engine was installed; no target was
marked unhealthy. The catalog was read from the actual Host. Kimi was outside
the requested test scope. All task inputs were synthetic, self-contained and
prohibited real-file/network/account work. The prompt explicitly asked the
coordinator to use the existing ticket workflow, explain its choice, avoid
max/ultra, and not rotate models merely to fill test coverage.

## Autonomous selection: six tasks

No engine or model was named in these task requests. All six created real
tickets and completed through real workers.

| Case | Task | Selected worker | Result |
| --- | --- | --- | --- |
| A1 | Sort three CSV rows | GPT-6-luna / low | Correct order and header |
| A2 | Extract Chinese meeting details into JSON | GPT-6-luna / low | Correct time, room and people; no invented date |
| A3 | Rewrite a rude connection-error message, under 60 Chinese characters | GPT-6-luna / low | Polite, concise retry wording; no recovery-time promise |
| A4 | Implement `sumFinite`, with type/nonfinite boundaries and examples | GPT-6-luna / low | Generated function passed six independent functional checks |
| A5 | Review asynchronous start/stop races and overlapping generations | GPT-6.1-sol / high | Identified all requested races; proposed repair passed three controlled interleavings |
| A6 | Repeat sorting with different CSV data after the harder task | GPT-6-luna / low | Correct; returned to the lighter model/effort |

The coordinator's visible reasons were consistent: bounded low-risk work for
A1–A4/A6, and stronger reasoning for A5's cancellation, resource cleanup and
generation interleavings. Those are its reported selection reasons, not proof
of an optimal ranking or a measurement of its internal decision process.

The A4 function was evaluated in a VM without host file/network capabilities:
normal numbers, mixed values, empty input, all nonfinite values, negative and
fractional values, and invalid input type passed. A5's generated repair was
checked for stop-before-source, stop-during-ready, and old-source-after-new-start.
These are bounded synthetic checks. Its stated assumption that `close()` is
synchronous and nonthrowing remains explicit; this is not a production capture
or remote-input test.

## Explicit connectivity checks: not autonomous-choice evidence

None of the autonomous cases selected Claude, DeepSeek or Antigravity. We then
asked the same coordinator to dispatch one tiny marker-plus-addition task on
each unused engine, forbidding fallback to another engine. These cases prove
that the paths work, not that the coordinator independently preferred them.

| Case | Requested route | Observed execution | Result |
| --- | --- | --- | --- |
| P-opus | Claude Opus 5.5 / medium | Actual CLI arguments contain `claude-opus-5-5[1m]` and `medium`; native assistant records identify `claude-opus-5-5` | Correct marker and `42` |
| P-deepseek | DeepSeek default / low | Catalog model ID is empty; that worker's native session cache identifies `deepseek-official / deepseek-flash / low` | Correct marker and `42` |
| P-gemini | Antigravity, a Gemini entry supporting low | Coordinator chose `gemini-3.8-flash-low / low`; actual engine process used those arguments and returned successfully | Correct marker and `42` |

Codex worker rollout `turn_context` records independently match the model and
effort of all six autonomous tickets. Claude native output identifies its model
and its process arguments show effort. DeepSeek's exact session cache records
provider/model/effort. Gemini evidence is the actual process invocation plus
successful worker response; there is no separate provider-internal identity
readback. No engine's self-description was used to establish model identity.

## Findings

- **Working:** real ticket dispatch across all four engine families, explicit
  model/effort selection, and observable difficulty-based changes within GPT.
- **Observed preference:** all six unrestricted cases selected GPT, despite the
  other routes being available and subsequently succeeding. This sample does
  not demonstrate autonomous cross-family selection. It also does not prove
  that another family would perform better, or that the preference is hardcoded.
- **Default-model identity:** DeepSeek exposes its default entry to the
  dispatcher; the native worker session independently revealed `deepseek-flash`.
  The owner subsequently clarified that a single default DeepSeek entry is the
  intended setup. This is a valid candidate, not a defect to solve by inventing
  additional variants or downgrading that target. The catalogs do not supply a
  calibrated quality, live price or latency ranking; that evidence limitation
  applies across providers. See the [flexible-selection discussion](dispatcher-flexible-policy-2026-11-02.md).
- **No forced variety:** no routing policy was changed to make the result look
  more diverse. A future comparison would need representative repeated tasks
  and outcome/cost evidence before claiming a better routing policy.

## Evidence and limits

Evidence directory:
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-model-matrix-20261102/`.
Run: `run-2026-11-02T00-14-18.037Z/`.

`matrix.mjs` preserves prompts and the real managed-Host harness.
`targets-before.json`, per-case JSON, `tickets.json`, `messages.json`,
`native-model-readback.json`, `choice-explanations.json`,
`code-functional-checks.json`, `race-functional-checks.json` and `summary.json`
record the results. `observe-processes.py` sampled only engine/model/effort
fields from the isolated process tree; `process-model-observations.jsonl`
contains those observations. `sha256.json` binds the evidence. The source
fingerprints are in `setup.json`. The harness and observer both exited normally
after the isolated Host and managed workers were closed.

This was one persistent coordinator session, six autonomous tasks and three
explicit probes. Ordering and prior successful choices may affect later
selection. It is not a randomized benchmark, a comparison of all models on the
same workload, a test of ordinary production history without the test reminder,
or proof of globally optimal routing. End-to-end durations include coordinator
planning, CLI work, startup, worker generation, settlement and review; they must
not be presented as provider latency or price comparisons. All nine ticket
results were `needs_review`; the test did not impersonate owner acceptance.

CLI impact: the headless Host and bundled CLI were the actual tested entry
points; there is no separate UI-only implementation. This documentation-only
checkpoint does not require another build or an App release. The installed App
still requires a separately authorized release/update to receive the source
repairs.
