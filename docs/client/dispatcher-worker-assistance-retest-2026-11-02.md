# Execution-time assistance: additional real-task checks

Tested source: `95b64e7ef1fde80933a3cb5132106867eed6db06`.
Evidence: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-worker-assistance-retest-20261102`.
The run used the source build, an isolated Host and independent ticket conversations.
The initial parent was fixed to GPT 6.1 Sol/high for comparison; these are **not**
tests of the coordinator's initial model selection. No helper provider, model or
effort was prescribed. Neither the installed App nor production settings changed.

## Observations

| Task | Assistance instruction | Actual execution | Result |
| --- | --- | --- | --- |
| 60-second product script and six-shot storyboard | Help optional | GPT 6.1 Sol/high alone | Completed in 78.6 s, no helper requested. |
| Stratified success rates and causal interpretation | Independent helper required; target free | GPT 6.1 Sol/high → GPT 6.1 Sol/medium → original GPT session/high | All three attempts completed in 79.8 s. |
| Concurrent requests, crashes, timeout and deduplication retention | Help optional | GPT 6.1 Sol/high alone | Completed in 45.5 s, no helper requested. |

Native session logs confirm every actual model/effort in the table. The
statistics helper had a different native session, and its result returned to the
original parent session. See `live-1793621241171/native-readback.json`; exact
prompts are retained in `cases.json`. Targets at test start included allowed,
installed Codex, Claude, DeepSeek and Antigravity candidates. This does not prove
that all external services would have accepted a request at that instant.

Quality checks:

- The storyboard has six contiguous 10-second intervals and stays within the
  supplied product facts. Its narration is repetitive and largely describes
  interface areas; meeting the structural constraints is not evidence of strong
  creative quality or superiority to another model.
- The statistics result matches independent arithmetic: A 93.10% / 73.00% /
  78.00%, B 86.67% / 68.75% / 82.57%. It correctly distinguishes the aggregate
  reversal from the within-stratum comparison and does not infer causation from
  observational success rates.
- The concurrency review gives concrete duplicate-send and crash/retry examples,
  keeps a stable business ID, records uncertain outcomes and explains that an
  external idempotency contract is needed. It does not promise exactly-once
  payments from a local database transaction alone.

The mechanism works when help is requested. These three cases show **no
spontaneous cross-provider selection**. Two tasks did not seek help, while the
one requiring independent help still chose GPT. This is a small observation,
not proof that other models are unusable, that GPT is optimal, or that provider
bias has been resolved. Timings are observations under concurrent load, not a
latency benchmark.

## CI regression found and corrected

The prior commit's [source CI](https://github.com/cloveric/tarobot/actions/runs/41439463526)
finished with 25 failures in two files (`hub-state-backup`, `hub-server`), 7,852
passing tests and 12 skipped tests across 595 files. Desktop-native and secret
scanning passed. This was a code regression, **not** a billing/runner issue.

Database creation and runtime metadata had advanced to schema 24, but the
read-only whole-state backup inspector still accepted only schemas 8–23. It
rejected current databases before backup, including official same-path restore
fixtures used by the transport tests. The negative local run
`backup-red.log` reproduced `unsupported_hub_schema_version`.

The correction adds schema 24 to that explicit backup allowlist and advances the
future-schema refusal fixture to 25. It does not disable validation or allow
unknown future schemas. A new backup/restore regression verifies retained helper
receipts, parent metadata/native session, zero remaining allowance and unchanged
source database bytes. Both affected files now pass **92/92** locally in
`backup-transport-green.log`; this is focused coverage, not another complete
7,889-test run.

Opus 5.5 independently reviewed both changed source/test files, searched the
remaining Hub schema readers and found no further missed acceptance gate. Its
independent runs passed the same **92/92**, plus **280/280** across 12 related
schema/assistance files. Production `npm run build` passed (`build.log`). These
are separate runs, not a claim that the replacement full CI has passed.

The fix is separate from model selection and does not change the source-built
runtime that produced the real-task observations above. Review receipts are
`opus-backup-review.md`, `opus-backup-run.log` and `opus-schema-group.log` alongside
the run. No release or App update is performed by this follow-up.
