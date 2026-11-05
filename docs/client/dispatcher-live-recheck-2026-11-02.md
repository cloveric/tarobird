# Chancellor routing: real execution recheck

## Scope and installation boundary

This recheck starts from source `ad75eeee838e0649ef51a22c9fa89a50f456cf7e`, including
context repair `6143a55399c7f0ecd7ba7febfdcc0cbc0da0bb0d` and per-task selection
repair `ad75eee`, then applies contract follow-ups `08ad88966c0409b57f3a3ee533a0fbab91dc7af9` and
`e735deeed5ce29829369aa426c09d6f6840f8832` below. The owner requested
another review with Opus 5.5. The final real run used that follow-up source,
not the earlier baseline build.

The installed Mac remains **1.0.125 / Host 0.1.470**. A fresh installed-source
readback found neither `dispatcherExecutionInstructions` nor the new simple-task
routing rule. These repairs are not installed. This task does not publish a
release, replace the App, or change the production Chancellor's settings.

## Real end-to-end evidence

Unlike the preceding plan-only check and scripted-worker tests, this run used
an isolated, initialized Host with the production `HubServer` and `BotManager`.
The manager forked the built source Gateway entrypoint. The normal Gateway,
Core, Bridge and Codex adapter ran a real coordinator, which invoked the
bundled CLI itself to create and dispatch tickets. The manager then launched
real Codex workers. No model or ticket creation was mocked or pre-filled.

The isolated coordinator was `gpt-6.1-sol / low`, separate from the user's
production Bot. A temporary allowed-engine list restricted this small test to
Codex; the model catalog was the real Host catalog, without synthetic model
capability labels.

| Scenario | Observed result |
| --- | --- |
| Auto mode, sort three CSV rows by ID; no model named in the task | Coordinator independently chose `gpt-6-luna / low`, created a ticket and dispatched it. Real worker returned the correct complete CSV; ledger recorded `completed`, ticket became `needs_review`. |
| Switch the isolated fixture to ask mode; explicitly request `gpt-6.1-sol / low` for a multiplication | Coordinator returned a plan. Before confirmation, total attempt count remained one: no second worker started. |
| Confirm that plan in a new message | Coordinator created/dispatched the second ticket using its new turn context. A distinct worker conversation actually ran `gpt-6.1-sol / low` and returned `323` with the requested calculation. |
| Same coordinator session across original task, completion notices, plan and confirmation | Five actual Codex turns retained complete, independent `tarobot.execution` contexts without truncation. Coordinator saved model/effort remained unchanged. |

Actual worker rollout `turn_context` records independently confirmed the two
model/effort pairs, rather than relying only on the planned settings or ticket
labels. Sessions:

- Coordinator: `01a1998b-20ac-7c22-ada3-9b09877ceb7f`.
- CSV worker: `01a1998b-8ec4-74e1-90c6-c3ee8144248d`.
- Multiplication worker: `01a1998c-4c91-7120-bfa1-1bf5995c754e`.

Local evidence:
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-opus-recheck-20261102/`.
The final successful run is `final-2026-11-01T23-56-22.894Z/`, with `result.json`,
`first.json`, `ask-before-confirm.json`, `second.json`, `tickets.json`,
`native-model-readback.json`, and `final-evidence-sha256.json` in the parent.
`live-e2e-final.mjs` and `readback-final-v2.py` preserve the harness and readback
procedure. The earlier successful `live-2026-11-01T23-35-12.586Z/` run binds
only to `ad75eee`; its evidence is retained separately. The final five contexts
also retained the owner-confirmation, max/ultra and result-acceptance clauses.
Both actual worker-completion notice turns carried the delegated-source flag;
the three owner-input turns did not. The earlier `final-2026-11-01T23-44-30.452Z/`
run belongs to the first follow-up only, not the final source/cron change.
The temporary Host and its managed children were shut down after readback.
Two earlier fixture preparations failed before any task ran (Unix control
socket path too long; an invalid permission enum in the harness). They were
corrected and remain recorded; they are not product failures or passing tests.

## Review follow-up repair

Opus's independent content probe found that several original rules still
existed only in the longer, truncatable contract: expensive max/ultra choices
need owner confirmation, and successful work stays `needs_review` until owner
acceptance. The short ask-mode sentence also did not explicitly name the owner
as the source of confirmation. The longer completion-notice instructions said
to redispatch immediately, without stating the same ask-mode boundary.

The short contract now retains these rules, including owner confirmation for
expensive choices in auto mode, and explicitly applies the same confirmation
and cost rules to redispatch. The full notice instruction is consistent with
that contract. This preserves existing policy; it does not add a Host task
classifier or a server-side confirmation token.

A new Gateway contract assertion failed before this follow-up
(`contract-red.log`). After repair, seven relevant suites / **214 tests** passed
(`contract-green.log`), and `npm run build` passed with the 484-module standalone
graph (`build.log`). These are separate from Opus's pre-follow-up baseline of
219 passing tests and must not be added as unique coverage.

## Independent findings and disposition

Opus 5.5's report is `opus-review.md` in the evidence directory. Its original
scope is `6143a55` / `ad75eee`, not a claim that it tested the installed App.
It independently passed 219 baseline tests; an expanded run passed 263 tests
but could not load the client settings suite because the copied workspace
lacked `lucide-react`. The main implementation reran that suite with the
existing client dependencies: **5/5 passed** (`client-settings-check.log`).
The probe fixture's early 1,985 vs 2,024 length failure compared the function
body with the tagged transport entry; the 39-character wrapper explains it.

- **Critical context retention:** accepted. In addition to confirmation/cost/
  result acceptance, the short context now carries an authenticated delegated
  source flag. A Bot request, reply or ticket notice cannot confirm a plan or
  accept a result for the owner. Gateway coverage includes a delegated message
  that says “可以，执行吧”, proving the source flag survives into its independent
  context rather than relying on the text or display name.
- **Scheduled dispatcher runs:** the actual Gateway cron entry has no active
  Hub delivery authorizing ticket writes. It formerly received contradictory
  “route every execution through tickets” and “no context, no tickets” rules.
  We adopted the review's minimal fail-closed option: give this path a separate
  contract that explains scheduled ticket dispatch is unavailable and asks the
  owner to send the task in the conversation. No synthetic context, owner
  impersonation, direct execution, schedule changes or success claim is allowed.
  **Automatic scheduled ticket dispatch remains unsupported.** This does not
  implement that feature or establish live model behavior for scheduled jobs.
  The real Gateway `runCron` component regression verifies the emitted contract;
  its model response is scripted.
- **Plan-only evidence depended on labeled fixture models:** accepted as an
  evidence limit. The later actual managed-worker runs use the real Host catalog
  without supplied labels, and actual worker rollout readbacks; the earlier
  plan-only report is not repurposed as execution proof.
- **Catalog defaults vs CLI defaults:** retained as a limitation. The catalog's
  creation defaults need not equal an unpinned worker's CLI defaults. Do not
  claim such a default actually ran. This patch selects explicit model/effort
  when available and verifies actual execution separately; it does not rewrite
  the user's CLI defaults.
- **Custom model identifiers:** not restricted to the static catalog. Existing
  custom-model compatibility is preserved; catalog membership is not a new
  server authorization rule.
- **Ask mode and same-OS-account CLI access:** existing boundaries, not newly
  introduced isolation guarantees. Ask remains model-mediated. Full-access
  processes are not isolated from the user's own OS account by Bot environment
  variables. No production owner identity was used in the tests.

The source/cron assertions failed before repair (`source-cron-red.log`, two
failures). The repaired tree passed **9 suites / 266 tests**, including Gateway
schedules and async questions (`source-cron-green.log`); the final Host build
passed (`build-final.log`). Counts overlap earlier runs and are not summed.

## Final independent sign-off

Opus 5.5 completed the final read-only review in `opus-final-review.md` against
clean commit `e735deeed5ce29829369aa426c09d6f6840f8832`. It confirmed the three
source/test files match its previously tested stage B byte for byte, reproduced
the two new failures with the earlier source, then passed **8 files / 239 tests**
on the final source. Its verdict is no new blocking findings; F1 and F2 are
closed within the explicitly documented scheduled-task boundary. This count
includes overlapping tests and is not added to the primary 266-test run.

The earlier v3 report's “uncommitted B layer” is now commit `e735dee`; the final
real run above also contains that layer. Opus did not run the live end-to-end
harness or the build itself. The primary implementation supplied those separate
results and matched the captured Gateway/guidance source to the final commit.
The final report corrects an earlier patch-hash label; the committed source and
byte comparison, not that obsolete label, establish the review binding.

## Limits

This is a bounded, source-built, real Codex test with two small tasks. It does
not prove all engines, every future task classification, cost or latency
savings, or the installed App. The ask-mode observation is model behavior;
it does not turn the existing prompt-level policy into a Host-enforced
per-ticket approval token. The worker's CLI model configuration is verified;
provider-internal inference routing is not observable here.
