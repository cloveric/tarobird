# Chancellor: permissive task selection and default-model compatibility

Follow-up: [five additional real-ticket spot checks](dispatcher-spotcheck-2026-11-02.md)
exercise effort changes, generated-code behavior, explicit engine choices and
ask-mode confirmation without changing the implementation.

The owner asked to implement the [permissive selection design](dispatcher-flexible-policy-2026-11-02.md)
with Opus 5.5. The change clarifies the shared, independently delivered
dispatcher instruction. It does not add a routing algorithm or change any
saved Bot model, allowlist, catalog ordering, permission, or installed App.

## Implemented behavior

- The coordinator selects a capable worker and the lowest adequate effort for
  the actual task. Complex, uncertain or high-impact work can use stronger
  reasoning; a lightweight model is not mandatory.
- Empty catalog model/effort values are valid CLI defaults. Omit the respective
  flag when deliberately choosing that default. A default-only target is a
  normal candidate; it is not a limitation that must be apologized for.
- Catalog position, the coordinator's own provider and provider variety are
  not selection objectives. A previous result is relevant evidence for similar
  work, not an instruction to repeat the previous worker for every task.
- Existing owner choices, installed/allowed/healthy targets, supported
  parameters, ask/auto, cost confirmation and owner acceptance remain intact.
  Scheduled dispatch without an active authorized message remains unavailable.

Opus identified an ambiguity in the first wording candidate: “target default”
could confuse an engine's `defaultEffort` with a named model that offers no
effort setting. The final wording explicitly describes empty catalog values.
It also removes the old instruction to “explain that limit” for a default-only
entry. No DeepSeek model ID or provider-to-topic rule was added.

CLI parity uses the existing `tickets targets` and `tickets dispatch` path;
omitted flags retain their existing meaning. There is no new CLI command or UI.
The long dispatcher instruction includes the same short contract, so this is
one shared policy rather than separate per-engine personas.

## Native CLI plan-only observations

Base source: `33b0d7b339bb949a83bcf26a79e0cb04ac60df8c`. Catalog refreshed once
through the read-only `bots catalog` interface and frozen for all cases.
The fixture allowed Codex, Claude, DeepSeek and Antigravity, with auto mode and
one concurrent ticket. Kimi was detected but deliberately not in this fixture's
allowlist. No production dispatcher settings or engine health were inferred.

The first 16 fresh native CLI sessions compared current/candidate-v1 wording,
GPT/Opus coordinator, original/reversed `targets` array and simple/complex task.
Eight more sessions checked the final v2 wording in the same conditions. The
requested coordinators were `gpt-6.1-sol/xhigh` and
`claude-opus-5-5[1m]/xhigh`; equal effort names do not imply equal compute.

| Wording / coordinator | Simple: original → reversed targets | Complex: original → reversed targets |
| --- | --- | --- |
| Current / GPT | Luna low → Luna low | Sol high → Astra high |
| Current / Opus | Haiku default → Haiku default | Sonnet high → Astra high |
| Candidate v1 / GPT | Haiku default → Luna low | Sol high → Sol high |
| Candidate v1 / Opus | Gemini Flash low → Haiku default | Sonnet high → Sonnet high |
| Final v2 / GPT | Haiku default → Luna low | Sol high → Sol high |
| Final v2 / Opus | Haiku default → Haiku default | Sonnet high → Sonnet high |

Ten additional plan-only boundary cases (five per coordinator) checked:
DeepSeek as the only allowed target, Haiku as the only allowed model, an explicit
Gemini choice, an unavailable preferred Claude engine with authorized fallback,
and ask mode. Both coordinators selected legal default parameters, honored the
available explicit choice, avoided the login-required target, and required
confirmation in ask mode.

Across the **34 plans**, no selected target/model/effort violated the supplied
catalog or fixture authorization checks, and no tool calls were observed.
One old-wording Opus answer failed the strict JSON-only format: it contained
prose plus a single valid JSON fence. The derived summary extracts that fence
while preserving the original format failure; the case was not rerun.

Parameter validity is not the same as fully supported reasoning. In particular,
the final-v2 Opus reversed complex case said “without the cost of opus or xhigh”
without comparative price evidence. This remains an unsupported qualitative
comparison, not a verified saving. Other unverified tier descriptions included
“mid-tier”, “flagship” and “code work model”; the catalog does not supply those
rankings. These are model judgments, not facts established by this experiment.
The instruction already forbids inventing
prices/capabilities; it is guidance, not a semantic enforcement mechanism.

These observations do **not** prove optimal routing, elimination of provider
preference, or a speed/cost improvement. The catalog was pasted into the prompt,
not fetched as a production tool response; complete dispatcher instructions
were supplied to both native CLIs. Codex used an explicit developer instruction
and ignored user config; Claude used an explicit system prompt, safe mode and
disabled tools. Their native system contexts/customization surfaces can still
differ. Each cell ran once, sequentially within each provider lane; time/order
are confounded. Only the target array was reversed, not model arrays or the
fixed engine order in shared guidance. These are plan-only observations, not
ticket execution or worker-quality comparisons. Variety is not a pass criterion.

## Real source-built ticket execution

A separate isolated Host ran the actual managed Bot → Gateway → Core → Bridge →
CLI → worker flow with the final source and built output. Its coordinator was
`gpt-6.1-sol/low`, distinct from the plan-only xhigh coordinators. These two tasks
explicitly requested engines/models to verify compatibility; they are not
autonomous provider-selection evidence.

| Requested worker | Ticket outcome | Native readback |
| --- | --- | --- |
| DeepSeek default model, low | Completed; correct marker and `23+19=42` | Session selection: `deepseek-official/deepseek-flash/low` |
| Claude Haiku, no effort flag | Completed; correct marker and `23+19=42` | Process: `--model haiku`, no `--effort`; assistant model: `claude-haiku-5-5` |

Both tickets stayed at `needs_review`; the harness did not accept them for the
owner. The DeepSeek native model readback describes this test run only; the
application continues to use its configured default rather than pinning that ID.

The Codex coordinator's actual persisted native transcript contained all four
independent `tarobot.execution` contexts (two owner tasks and two delegated
completion notices). Wrapped lengths were **2627 / 2772 / 2627 / 2772** characters.
Each retained the current message authorization, new selection rules and existing
confirmation/acceptance boundaries, without truncation. The source and built
modules are SHA-256 bound in the run's `setup.json` and `native-readback.json`.

## Regression and review

- Negative baseline: the existing real Gateway context regression failed when
  the newly required selection guidance was absent; the scheduled limitation
  case still passed.
- Final primary regression: **7 files, 72 tests passed** — Gateway context and
  dispatch, CLI tickets, engine overrides, Hub dispatch/auth and Bot manager.
- Host build passed: **484 modules**, no legacy transport or Feishu SDK.
- Added checks ensure the shared selection rules reach independent engine
  context and that the delegated variant stays below 3000 characters. These
  tests prove delivery/retention, not the model's judgment.

Opus 5.5 independently reproduced the negative baseline and passed three
focused suites (13 tests) in its own copy. Those tests overlap the primary 72
and are not an additional combined coverage total. Its source/patch review and
readback of the native context hashes found no blocking implementation issue.
Its native
review receipts and final evidence are retained with the primary results under
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-permissive-implementation-20261102/`.
`plans-summary.json` preserves all raw selection references; `live-2026-11-02T02-52-44.790Z/`
contains the separate real execution receipts. No release, local App replacement,
production model change or production conversation mutation was performed.
