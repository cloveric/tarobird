# Chancellor selection: preserve autonomous judgment

Follow-up: the owner subsequently authorized implementation. See the
[final wording, bounded observations and real ticket verification](dispatcher-permissive-selection-2026-11-02.md).
The discussion and unimplemented candidate below record the earlier decision;
the follow-up uses a more precise empty-catalog-value definition.

## Owner's direction and current boundary

The owner prefers a permissive selection mechanism: a Chancellor chooses
workers according to the task, rather than a provider-to-topic lookup table.
DeepSeek's single default entry is intentional and sufficient. Do not invent
more variants or treat that entry as inferior because its model ID is empty.
The default follows the configured engine.

This is a design discussion against source `e6a5634`, with Claude Opus 5.5.
It changes documentation only. No selection instruction, engine ordering,
permission, Bot configuration, installed App or release changed. The preceding
[live sample](dispatcher-cross-engine-sample-2026-11-02.md) remains the only new
execution evidence; this discussion adds no model tests.

## Minimal direction

Keep selection with the coordinator. Existing owner choices, allowed targets,
availability, compatible parameters, ask/auto and cost-confirmation boundaries
remain in force. These are authority/execution boundaries, not a vendor-ranking
algorithm. A Chancellor may select the same provider repeatedly when that is
appropriate; diversity is not an objective.

The existing short instruction already asks for task complexity, risk, required
capabilities, and a brief reason; it rejects topic keywords and blindly
inheriting the coordinator or previous ticket settings. Avoid layering another
long decision procedure on top of it. In particular:

- No fixed “Chinese → DeepSeek”, “code → GPT”, or “review → Opus” assignments.
- No rotation, quotas, or requirement to use every installed provider.
- No mandatory two-candidate comparison or explanation of every rejected
  provider on every task. The existing short reason is sufficient.
- No fabricated strengths, prices or rankings. Catalog facts and verified
  capabilities can inform a choice; uncertainty should remain visible.
- Relevant success on similar work is useful evidence. A success on an
  unrelated prior task is not enough to prescribe the next worker.
- Do not build historical scoring, automatic learning or dynamic pricing from
  nine heterogeneous test cases. Coordinator overhead and cold starts also
  confound the observed end-to-end time.

## Wording candidate, not an implemented repair

Opus proposed replacing two existing selection sentences with:

> Prefer a capable lightweight model at the lowest adequate effort (or the target default when it has no effort setting) for bounded, low-risk work; use stronger reasoning for complex, uncertain or high-impact work. Judge the actual request and verifiable catalog facts, not topic keywords, list order or your own provider; an earlier result is evidence only for similar work, and variety is not a goal.

The intended clarification is that an engine without an effort setting remains
eligible, and neither the coordinator's provider nor catalog position is a
ranking signal. This does not require changing provider or increasing effort
when the task does not call for it. The target default in the first sentence
means its supported effort behavior; a single default model is independently a
valid target.

This candidate adds approximately 210 characters to the existing contract.
Before any implementation, recheck the actual independent context length,
including delegated-source metadata, and the existing context-retention tests.
Those tests would establish transport/content retention, not model judgment.

## Review corrections and evidence discipline

Opus raised an ambiguity between “prefer low effort” and a catalog entry such
as Haiku with no selectable effort. This is a possible prompt influence, not a
reproduced Host rejection or proof that the model excluded that entry. Likewise,
DeepSeek's default-only representation does not establish that it can only be
selected when explicitly named or when other engines fail.

The six prior autonomous choices all used GPT. That observation does not prove
a coordinator self-provider bias, nor rule one out. Possible influences include
the task set, known model information, catalog order and shared session history.
Agreement between two coordinators does not prove task fit; different choices
do not by themselves prove bias. Selection distribution and actual outcome
quality are separate measurements.

## Bounded next experiment

Before changing the live instruction or production catalog order, compare:

- Current wording versus the candidate wording.
- GPT versus Opus as coordinator.
- Original versus reversed `targets` JSON ordering.

This gives eight conditions. Begin with the same simple and complex task in
each, using a fresh session for each task/condition and recording the exact
catalog, instruction, coordinator model/effort and proposed dispatch arguments.
The initial 16 decisions are **plan-only**: no ticket or worker execution is
implied. Repeats and later real-worker blind checks should follow specific
uncertainties, rather than launching a large benchmark by default.

Reversing `targets` tests that JSON order only. The shared guidance and CLI help
also list engines in a fixed order; this experiment cannot exclude their
influence. Equal effort labels across coordinator families do not establish
equal compute budgets. Small-sample timing/token differences are observations,
not performance guarantees.

Record paired choices, reversals, reasons and invalid parameters. Do not make
an arbitrary diversity percentage or a small-sample threshold a pass criterion.
Hard failures include selecting disallowed/unavailable targets, contradicting
an available explicit owner choice, using unsupported parameters, or claiming
invented capability/price evidence. Relevant boundary cases also include
default-only targets, no-effort targets and an unavailable preferred engine.
Separate plan-only results from real dispatch and result quality in every report.

## Collaboration record

Local discussion artifacts are in
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-flexible-policy-20261102/`:
`opus-request.md`, `opus-proposal.md`, `opus-followup.md` and CLI receipts.
The primary implementation reviewed and challenged the proposal's causal
claims and suggested numeric threshold. Opus accepted all five clarifications
in its final v2 report and collaboration reply; the corrections above are
deliberate. No new source test or build was needed for this documentation-only
decision.
