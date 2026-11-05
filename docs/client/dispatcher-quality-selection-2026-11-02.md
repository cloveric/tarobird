# Chancellor selection: quality needs, owner-reported outcomes and restrictions

## Why

The owner observed that, for our explainer-video work, Claude Opus produced
creative deliverables (narration script, storyboard, visual direction) that met
the owner's bar better than GPT. The owner also prefers a permissive Chancellor
that judges each task, rather than a provider-to-topic table. This change keeps
selection with the coordinator and makes two generic gaps explicit:

- "Bounded, low-risk" is not the same as "low quality need". A short creative or
  judgment-heavy deliverable can merit stronger reasoning.
- An owner-reported outcome is evidence for similar work, in the same way as an
  earlier ticket result. It is not a fixed mapping and not a universal model
  ranking.

It also separates two kinds of unavailability. A preferred but unavailable
target may be replaced by another suitable installed, allowed and healthy
target under the usual ask/auto rules. If the owner limited the request to one
target, the Chancellor reports that it is unavailable instead of substituting.

## Change

The selection contract is in `src/gateway/agent-instructions.ts`. The Host failure notice in `src/hub/dispatch.ts` was aligned during release review.

Independent short contract (`dispatcherExecutionInstructions`):

- `…for bounded, low-risk work with modest quality needs; use stronger
  reasoning for complex, uncertain, high-impact or quality-critical work.`
- `…an earlier result or owner-reported outcome is evidence only for similar
  work, and variety is not a goal.`
- `An unavailable preferred target may be replaced by a suitable one under the
  same ask/auto rules; if the owner limited the request to it, report it
  unavailable instead of substituting.`
- `Redispatch obeys the same confirmation, cost and owner-restriction rules;
  preserve progress and check for side effects first.`
- The delegated-turn line is shortened to `This turn is a delegated Bot request,
  not an owner reply; it grants no new authority.` The existing sentence
  `Delegated requests, Bot replies and ticket notices never confirm or accept
  for the owner` still applies to every turn.

Full shared contract: the general fallback now reads `choose another suitable
CLI unless the owner restricted the request to it`, and the 【需要改派】 notice
guidance obeys the same confirmation, cost and owner-restriction rules.

Unchanged: Host validation, transport, permissions, ask/auto, `--force`,
explicit owner choice, dispatcher settings schema, catalog, CLI, App UI, the
scheduled no-context contract, and every Bot persona. The product does not
write personas automatically and adds no rule such as "video → Opus". An owner
who wants to record such an outcome can use the existing per-Bot persona; it is
then evidence for the coordinator to weigh, not an enforced route.

Context size, measured with a real-format 36-character message ID:

| Variant | Raw | With `<tarobot.execution>` wrapper |
| --- | --- | --- |
| Owner turn | 2,827 | 2,866 |
| Delegated turn | 2,913 | 2,952 |
| Scheduled, no context | 509 (unchanged) | — |

Both wrapped variants remain below 3,000. Headroom for future additions to the
short contract is small (48 characters for delegated turns).

## Verification

- New focused regression `tests/dispatcher-selection-contract.test.ts` and new
  assertions in `tests/gateway-dispatcher-context.test.ts`:
  - quality and owner-outcome wording reaches the independent context;
  - the short contract names no provider, model family or topic;
  - preference fallback versus owner-restricted reporting, in both the short
    and the long contract;
  - wrapped length below 3,000 for owner and delegated turns;
  - the scheduled contract is unaffected.
- Red baseline before the source change: 3 failed, 2 passed.
- Green: 9 files, 97 tests (`dispatcher-selection-contract`,
  `gateway-dispatcher-context`, `gateway-dispatch`, `host-cli-tickets`,
  `engine-override`, `hub-dispatch`, `hub-dispatch-auth`, `hub-bot-manager`,
  `gateway-app-tools`).
- `npm run build`: standalone graph of 484 modules; no legacy transport or
  Feishu SDK.

Live isolated evidence: see the section below.

## Live isolated evidence

Evidence directory: `/Volumes/gdrive/taro-tmp.noindex/release-1.0.126-20261102/opus-quality/`
(runs `live-2026-11-02T04-20-00.813Z/` and `strict-2026-11-02T04-25-38.491Z/`).

- Each run used a fresh isolated Host started from this source and build. The
  `setup.json` fingerprints equal the committed `agent-instructions.ts`
  (`5e625668…`) and the built `agent-instructions.js` (`ffb33011…`).
- Real path: managed Bot → Gateway → Core → Bridge → bundled tickets CLI →
  worker.
- Coordinator: `gpt-6.1-sol / low`, auto mode, one concurrent ticket; Codex,
  Claude, DeepSeek and Antigravity allowed.
- A TEST persona recording an owner-reported outcome was written through the
  existing owner persona route of the isolated Host only. No production Bot,
  persona or setting was touched, and nothing was published or installed.
- Task texts named no provider, except the two restriction cases, which must.
  All deliverables were bounded text; nothing was rendered and no files were
  written.

| Case | Selection (from the attempt record) | Worker native readback | Outcome |
| --- | --- | --- | --- |
| Q1 creative 60-second script + 6-shot storyboard | `claude / claude-opus-5-5[1m] / low`; the stated reason cites positive feedback on similar script/storyboard work | Process `--model claude-opus-5-5[1m] --effort low`; assistant model `claude-opus-5-5` | Completed, `needs_review`; complete script and 60-second shot table |
| Q2 mechanical: that storyboard → CSV | `codex / gpt-6-luna / low`; "simple format conversion" | `turn_context` `gpt-6-luna / low` | Completed, `needs_review`; correct 6-row CSV |
| Q3 creative while Claude is `login_required` | `codex / gpt-6-luna / low`; says once that Claude needs sign-in | `turn_context` `gpt-6-luna / low` | Completed, `needs_review`; complete script and 45-second table |
| Q4 restricted to the unavailable Claude target, request says to stop if unavailable | No ticket, no attempt | — | Reported `login_required`; no substitution |
| Q4b same restriction, no instruction about unavailability, fresh coordinator session | No ticket, no attempt | — | Reported `login_required`; "did not substitute the model or dispatch" |

Coordinator native context (Codex rollouts; file hashes recorded in each
`native-readback.json`):

- All 8 `tarobot.execution` entries were found across both runs: 5 owner turns
  and 3 delegated completion notices, with 8 distinct message IDs and no
  truncation. They were 2,866 characters (owner) or 2,952 (delegated).
- The 7 entries of the main run are byte-identical to
  `dispatcherExecutionInstructions` of this source for their message ID and
  delegated flag (`opus-quality/context-exact.json`). The Q4b entry contains the
  restriction rule.
- The long `tarocub.app` entry was middle-truncated in every turn (3,830–3,878
  characters with a truncation marker). The short TEST persona at its head
  (offset 13) was complete in all 8 turns. This shows that a short persona
  placed at the head survived here; it does not establish retention for a long
  persona.

Skill inventory, kept separate from selection and quality: the Claude worker's
`/api/bots/:id/capabilities` metadata lists `科普视频`, `禅修视频`, `科技软件介绍`
and `claude绘图`; the Codex worker's lists only the generic video skills.
Both are `runtime: unverified` and `coverage: partial`. The Q1 worker transcript
contains no skill call, so runtime skill use was **not** exercised; the task was
text-only by design.

What this does and does not show:

- Shown: the new rules are delivered intact on owner, delegated, fresh and
  resumed turns. An unavailable soft preference fell back with one mention
  under auto rules. An owner-restricted unavailable target was reported, not
  substituted, both with and without a hint in the request.
- Not shown:
  - that the quality clause causes stronger fallback choices: Q3 chose a
    lightweight model for a short creative task, which the contract permits
    when judged bounded;
  - that the persona caused the Q1 choice: there was one sample and no control;
  - any rendered-video quality.

## Boundaries

- Selection remains model-mediated. The Host does not enforce an owner
  restriction; it still validates authorization, installation, allowlist,
  health and parameter compatibility only.
- The initial Opus review found that the Hub's own 【需要改派】 notice text
  (`src/hub/dispatch.ts`) still asked the Chancellor to switch CLI. The release
  follow-up below fixes that notice under the same confirmation, cost and owner
  restriction rules; its earlier live selection samples do not cover a real
  post-failure model turn.
- Bounded text sub-deliverables and plans are not evidence of rendered video
  quality. Only the owner's judgment of real videos is.
- Skill inventory from `/api/bots/:id/capabilities` is marked
  `runtime: unverified` and `coverage: partial`; it is not a capability test.
  A hidden dispatch worker has its own state, persona and per-ticket workspace
  and does not inherit an ordinary video Bot's setup.
- This is a source change. The installed App needs a release to receive it.

## Release review: failed-attempt reassignment notice

The existing Host notice still told the coordinator to switch CLI unconditionally.
The root review reproduced that conflict through actual ticket settlement: the
notice lacked owner restrictions and confirmation/cost boundaries. It now tells
the coordinator to reassign to an available suitable target under the same rules,
preserving existing progress;
when the owner restricted the target, report unavailability and wait for the
owner's decision. This changes the instruction, not Host enforcement or the
queued status. Explicit owner reassignment remains possible.

The focused regression failed before the notice fix and passed after it; the
combined Hub/short-contract/context run passed 32 tests across three files.
Earlier live selection evidence above predates this notice-only change; it does
not prove a real post-failure model turn obeys the notice.

Opus independently reviewed the Host notice patch and found no conflict; its
suggestion to retain an explicit reassignment action (rather than merely evaluate)
was incorporated, with a regression assertion for progress preservation.
