# Preserve the cause when automatic recovery stops — 2026-10-28

The comprehensive audit's earlier failed reply was triggered by a native Codex
`server_overloaded` error. Two test commands were still running, so TaroBot
correctly withheld automatic continuation to avoid duplicate execution. The
confirmed product bug was in error reporting: the recovery wrapper hid the
original provider category and used a receipt-conflict log message even when
the actual stop reason was unfinished work.

## Incident evidence

Read-only native events, the Bot timeline and the persisted run journal were
correlated. Times below are on October 28, 2026, UTC+08:00.

| Time | Observed evidence |
| --- | --- |
| 15:30:34.720 | Codex terminal event included `codex_error_info: server_overloaded` and `Selected model is at capacity. Please try a different model.` |
| 15:30:35.209 | TaroBot recorded an error outcome. Its wrapper message incorrectly described a conflict between the recovery receipt and observed state. |
| 15:30:35.341 | The next queued turn started; the audit later continued to the documented source checkpoint. |
| 15:43:52.430 | The outstanding logic-test command reported completion with exit code 1. |
| 16:41:42.636 | The outstanding browser-test command reported completion with exit code 130. |

Both command completions occurred after the failed foreground turn. The journal
also retained their incomplete tool entries. This supports the unfinished-work
guard; the red marks on earlier individual tool calls did not themselves decide
the whole run's outcome. The original card included the explanation that work
had not reported completion, but omitted the provider failure that led to recovery.

Message publication completion is distinct from native run success: publishing
an error card successfully does not make the failed model turn successful. The
historical card remains an error record. The later audit checkpoint and its
remaining verification limits are recorded in the
[comprehensive audit](../comprehensive-audit-2026-10-28.md).

## Repair and scope

`EngineRecoveryUnconfirmedError` now preserves the adapter's structured
`capacity`, `connection` or `rate-limit` category. Its log message distinguishes
unfinished work from a receipt conflict and includes the known provider category.
Chinese and English user-facing errors lead with that category before explaining
why continuation stopped and that the conversation is preserved.

Only known categories are exposed. Raw provider diagnostics, session identifiers
and unclassified error text are not copied into the public error or wrapper log
message. No category is inferred from an arbitrary error string.

Recovery guards, backoff, usage accounting, terminal status and Agent Bus
non-retryable semantics remain unchanged. The fix is in shared Host/Core code,
so App and headless CLI use the same error semantics; no new CLI command or
client protocol is needed. Other engines use the same category handling when
their adapters provide a verified recovery receipt.

This does not fix upstream model-service overload or authorize replay of
unfinished work. Production history, installed Apps, running Bots and model
settings were not modified.

## Verification

- Baseline: `0705ace4e956972b88cf3d8f45634dabf7b354c7`.
- Before the production fix, the updated focused recovery tests had 12 failures
  and 45 passes, reproducing the missing category and misleading log message.
- After the fix, six suites passed: `engine-recovery`, `bridge-retry`,
  `core-engine-recovery`, `core-recovery`, `gateway-run-recovery` and
  `gateway-recovery`: **79 tests passed**.
- Coverage includes all three categories and both locales, unknown-cause
  fallback, diagnostic privacy, native/observed unfinished tools, background
  work and child agents, conflicting receipts, retained context and no replay.
- `npm run build`: passed; standalone dependency graph has 459 modules and no
  legacy transport or Feishu SDK dependencies.

Sanitized incident evidence and test/build logs are retained locally under the
external-disk task directory `taro-tmp/recovery-error-20261028`. Raw conversations
and native logs are not committed to the repository. This is source verification,
not installed-App acceptance or a release receipt.
