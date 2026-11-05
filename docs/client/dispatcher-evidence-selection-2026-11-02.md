# Chancellor: evidence-led model selection without Jev

The owner observed repeated Luna selection and requested the non-Jev plan agreed
with Opus 5.5. This change improves the coordinator's instructions and the facts
it can inspect. It does not implement a provider/topic table, forced rotation,
model ranking or an automatic outcome-learning store.

## Problem and resulting behavior

The previous short turn contract led with lightweight models for bounded work.
A brief request can still require difficult judgment. The replacement starts
with acceptance criteria and adequate quality, then weighs speed/cost; lighter
models win when equally adequate. The lowest adequate effort remains valid.
Results must be reviewed against the actual task criteria. A substantive failure
requires reassessment and an explanation for retrying or changing model/effort;
a same-model repair can still be appropriate. Formatting, tool/access and
transient transport failures are distinguished from reasoning failures.

The per-turn contract preserves owner restrictions, ask/auto, concurrency,
cost confirmation, current-message authorization, side-effect checks and
needs_review settlement. No new instruction bypasses those existing boundaries.
Defaults remain legitimate candidates: empty model/effort selects the CLI's
configured default, not the catalog's Bot-creation preset. DeepSeek remains
unrestricted to its current configured default, without a new hardcoded ID.

The old target catalog supplied availability, IDs and supported efforts, but no
skill/tool facts. A new read-only query works before workers exist:

```sh
tarobot tickets capabilities --engine claude --match video
# Use hasMore, offset and total when more than 40 entries match:
tarobot tickets capabilities --engine codex --offset 40
```

Owner requests can add `--bot`; a dispatcher can inspect only its own permitted
engine choices. Host/App endpoint: `GET /api/bots/:id/dispatch-capabilities`;
Bot endpoint: the existing `/api/instance/tickets` with operation `capabilities`.
Both use HubDispatch authorization and the same scanner. No worker, ticket or
engine process is created. Executable-presence checks deliberately avoid
`catalog()`, whose Antigravity model discovery may launch `agy models`.

The shared scanner reads bounded, redacted user-scope skill/MCP declarations.
It excludes workspace/other-Bot/project-plugin contents. Output is explicitly
partial and runtime-unverified: discovered/configured/disabled states do not
prove effective runtime access or comparative quality. A missing entry does
not prove an engine cannot do the task. DeepSeek dynamic harness configuration
is not guessed. Host user-level environment matches workers unless their own
configuration overrides it; per-ticket workspace behavior remains unverified.
Descriptions are third-party evidence, not instructions to execute. Config
commands, URLs, headers, credentials and file bodies are not returned.

Scans run outside the database queue. Concurrent reads for one engine share the
same in-flight scan; at most two different engines scan at once. Completed scans
are not cached, so later requests observe changed/disabled declarations. Each
response is bounded to 40 entries with a 100-character literal match filter.
Pages may reflect different configuration snapshots if files change between
requests; use a focused filter or restart inspection when comparing revisions.
No score or quality guarantee is derived from the metadata.

Historical evidence remains explicit: existing own `tickets list/show` can
inspect similar work and notes, and owner feedback may inform similar requests.
Ticket completion or a done status alone is not proof of owner acceptance or
model superiority. No new preference is written to the user's persona/memory.

## Entry-point and compatibility assessment

The new entry is agent/headless diagnostic metadata, not a new UI preference.
Owner App API and Bot CLI share the same rules; the existing App capability
panel retains its original registered-Bot/workspace scanner behavior. Existing
settings, allowlists, ticket persistence and worker execution adapters remain
unchanged. Target defaults/evidence strings and model label fallbacks are
additive. No schema migration, dependency, API key or external evaluator is added.

## Validation

Implementation review: actual Opus execution model was verified from its native
assistant records. Both implementations and assertions were independently
reviewed. A discovered catalog-launch side effect was removed before the final
candidate. Tests cover all five engine metadata branches, user/project
isolation, disabled entries, redaction, bounded file reads, pagination/filtering,
owner/Bot CLI, no implicit process/workspace creation, concurrent read bounds,
DB responsiveness, error recovery, and authorization/allowlist changes during
an in-flight scan. The short contract has a negative-before-change regression
and real Gateway context delivery coverage.

Focused verification (overlapping suites are not added together):

- Core dispatch/health/efficiency, CLI, settings, manager, override and Gateway:
  102 checks passed. Final CLI plus shared/new scanner: 40 passed. Final
  capability API/CLI: 15 passed. Final short-contract/Gateway: 6 passed;
  Gateway operations: 1 passed. The wrapped owner/delegated contracts are
  2,836/2,922 characters, both below the existing 3,000-character limit.
- The adapter run covered 634 adapter checks plus 6 contract checks. Its first
  run was **not clean**: three assertions caught the intermediate over-budget
  contract, and two Kimi terminal-process timing checks failed during concurrent
  build/test load, with an associated unhandled `Adapter destroyed` rejection.
  The contract was shortened and all 6 checks passed. The two Kimi failures and
  the associated session check passed in an isolated 3-check rerun without
  changing adapter code. Other adapter checks passed on the first run.
- Existing capabilities browser coverage: 6 passed, including touch and desktop
  source layouts. The integration used the unchanged 1.0.126 client bundle with
  the current Host/scanner; it is not installed-App or physical-device evidence.
- Final `npm run build` passed (484-module standalone graph). Opus's separate
  broad `tsc -p tsconfig.json` probe reported errors in unchanged adapter/test
  files; this change does not claim that broader probe was green.
- A real isolated Host returned filtered metadata for Codex, Claude, DeepSeek
  and Antigravity in 193/273/6/24 ms respectively in one probe. DeepSeek returned
  no guessed entries and its dynamic-configuration warning. These are metadata
  response timings, not tool-health or model-quality measurements.

Work evidence is under
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-evidence-20261102/`, including source
and built-file SHA-256 fingerprints, the initial negative regression, all test
logs and Opus's implementation review. No production source changed during the
paired candidate run.

## Real paired task comparison

Four neutral text-only tasks run once each against the 1.0.126 source baseline
and once against this candidate. Each used a fresh isolated Chancellor/session,
empty persona, `gpt-6.1-sol/xhigh` coordinator, auto mode and concurrency one.
Codex/Claude/DeepSeek/Antigravity were permitted; user task text named no model
or provider. Actual workers are checked against native session records, not
only the dispatch request. This is a comparison of the whole coordinator flow,
not a controlled comparison of worker models with identical rewritten prompts.

| Task | Baseline actual worker | Candidate actual worker | Baseline / candidate total seconds | Content review |
|---|---|---|---|---|
| Inventory JSON | Luna / low | Luna / low | 139.7 / 113.8 | Both correct, one attempt |
| Async cache race | Luna / medium → Sol / medium | Sol / medium | 383.4 / 267.2 | Both final answers correct; baseline required a second attempt |
| Causal decision | Sol / medium | Luna / medium → Sol / medium | 187.9 / 211.9 | Both final answers correct; candidate required a second attempt |
| Recovery messages | Luna / low, twice | Luna / low | 132.9 / 82.5 | Both final answers correct |

`Luna` means `gpt-6-luna`; `Sol` means `gpt-6.1-sol`. All attempts in this table
were Codex. Native `turn_context` records match the ticket model/effort, and
candidate developer contexts contain the complete quality/reassessment/capability
rules at 2,836/2,922 characters without truncation. Actual coordinator tool calls
confirm one capability query in each candidate case. All tickets remain
`needs_review`; no model accepted on the owner's behalf.

Both root and Opus independently reviewed the actual answers against each input,
not just completion flags. Inventory quantities/units/order match. Both cache
answers identify the old-rejection/new-cache race and give the same identity
guard; an independent four-combination reconstruction confirms that both the
pending and fulfilled replacement traces fail before the guard and pass after.
This is reviewer execution, not a claim that the model ran those tests.
Both final causal answers contain correct overall/stratified rates, explicit
common weights, confounding limits and a proposed randomized follow-up. Both
final recovery answers preserve local-saved versus unsaved distinctions and
length limits. The different offline buttons are allowed design choices, not
proof of one model's superiority; actual rendering of those hypothetical
message labels was not tested.

Counterexamples are retained. Baseline already upgraded Luna to Sol after an
invalid second cache test; it was not incapable of reassessment. Candidate's
first causal answer used incorrect combined-device weights (55/45 rather than
110/300 and 190/300), and its coordinator caught the error and upgraded to Sol.
Baseline chose Sol directly on that task. For recovery copy, baseline repaired
an unsupported automatic-sync promise using the same Luna model; that was a
reasonable same-model correction.

There were six baseline worker attempts versus five candidate attempts, with
about 844 versus 675 total seconds. Each task/variant has only one sample and
the coordinator rewrote the worker request differently, so these totals are
**not** a statistical speedup or a model-quality ranking. Worker-attempt time
was about 152/110 seconds in total; the remaining per-task time ranged from
72.2 to 284.0 seconds and includes coordinator generation, tool calls,
scheduling and polling. It cannot all be attributed to model computation.

The four tasks were text-only and did not need specialized tools. The probe and
tests verify metadata access, not that metadata improved these choices. Both
variants still chose only GPT: this run does **not** establish improved
cross-provider selection, optimal first-attempt routing, or better final quality.
No extra forced-provider comparison was run. The new behavior supplies bounded
evidence and explicit acceptance/reassessment guidance while retaining autonomous
selection; future comparisons should use repeated tasks requiring different
capabilities and independently accepted outputs before making broader claims.

Installed App acceptance is not part of this change. No release, production
Bot settings change or local App replacement is authorized by this continuation.
