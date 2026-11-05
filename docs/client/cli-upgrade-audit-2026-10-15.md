# CLI upgrade compatibility and recovery audit

Scope: the local five-engine upgrade, the `cup` updater, and TaroBot's shared
engine adapters. This is a source checkpoint and local tooling repair, not an
App/CLI package release. The running production host and conversations were not
restarted or migrated. Tests used disposable workspaces and native sessions.

## Fixed defects

### Delayed Claude stdin errors

The prompt write callback cleared `worker.pendingTurn` and rejected the promise
captured when that write started. Native events could already have supplied tool
calls; clearing the turn lost those observations. If a later turn had started,
the callback cleared that turn while rejecting the already-settled earlier
promise, leaving the active request unresolved.

All prompt pipe failures now use the common worker-failure path, which records
observed work, closes scoped progress, rejects the actual active turn and kills
the broken worker. Two new fault tests failed before this fix and pass after it.
This does not automatically retry a prompt or rerun tools.

### Optional interruption-receipt I/O

Previously, both next-turn guidance and adapter shutdown waited on an unbounded
file read/write chain. A blocked filesystem could freeze them even though these
receipts only supplement native history. A failed initial read also allowed a
later write to replace a file whose contents/version could not be understood.

Receipt initialization and persistence now have one-second deadlines. Memory
mutations remain ordered independently of writes. Writes serialize and coalesce
to the latest snapshot; a clear arriving during an older write is persisted
after it. Storage failure switches this adapter to memory-only operation without
overwriting an unreadable file. Late reads cannot restore stale data. An OS write
already underway cannot be forcibly canceled, so persistence is not guaranteed
after a timeout. Native transcripts and user instructions remain unchanged.

Regressions cover stuck reads/writes, late read completion, clearing during a
write, future-format preservation, restart persistence, and Bot/session/workspace
isolation. The stuck-I/O cases failed before the fix.

### Local `cup` utility

The installed user utility was backed up and repaired independently of the
repository:

- A failing updater no longer skips all subsequent engines. Results distinguish
  completed, failed and absent tools, and any failure makes the final exit nonzero.
- The active executable's resolved installation path selects npm/Homebrew and
  its actual prefix. npm Codex no longer invokes `brew list --cask codex`, which
  was observed hanging in Homebrew initialization. Unknown installation methods
  fail explicitly rather than installing an unrelated duplicate.
- Missing Claude/Homebrew no longer prevents other installed engines updating.
  Kimi uses its supported `upgrade --yes` flag.

Six hermetic shell scenarios cover successful updates, AGY/npm failures,
continued execution, cask selection, unknown managers, missing Claude and the
noninteractive Kimi command. Real installations were not repeatedly upgraded to
test error handling. The script backup remains next to the local executable.

## Installed versions and actual verification

| Engine | Installed version | Evidence and limits |
| --- | --- | --- |
| Claude Code | 2.1.300, previously 2.1.296 | Real stream-adapter reply; process shutdown and native-session resume retained a private test nonce. A separate harmless sleep tool was stopped; one observed call and zero results survived adapter restart, and the resumed model correctly acknowledged the call. Repeated after the final source build. |
| Codex | 0.162.1, unchanged | Real app-server stdio initialize exchange succeeded. This check did not make a new model request. |
| Kimi Code | 2.2.0, previously 2.1.1 | Real ACP initialization, thinking/text events, reply and native-session reload retained the test nonce. The probe disabled the optional hook relay to avoid changing global hook settings; hook behavior is covered separately by protocol tests. |
| Antigravity | 1.3.5, unchanged | Default-model probe produced no public events before its 30-second inactivity deadline. A fresh probe explicitly selecting an available Gemini model replied and resumed correctly. Model listing succeeded. The default-probe timeout cause is unresolved; production model selection was not changed. |
| DeepSeek Harness | 0.2.0-rc.2, unchanged | Fresh isolated settings and empty credentials, native loopback host boot, transport connect and `session.list` succeeded. No model/API request or production credential change was made. |

AGY's updater manifest hostname failed DNS resolution, so its update remains
blocked. Successful model-list/reply checks do not prove its separate updater
service is reachable. An initial DeepSeek fixture lacked the profiles/settings
required by the host; creating those disposable fixture inputs made its native
probe pass without a product change.

The Claude stop/resume probe did not observe a synthetic no-response frame on
stdio. That limited result neither proves nor disproves what the earlier
2.1.296 incident emitted. The earlier raw stream was not captured, so the
missing-placeholder transport question remains unproven.

## Validation and release boundary

- Initial five-engine focused suite: 12 files / 521 tests passed.
- After the production fixes: default full suite 279 files / 3,705 passed, one
  skipped. Two additional receipt-ordering/version-preservation cases were then
  added; the complete seven-case receipt suite passed. Product code was unchanged
  after the full run.
- Standalone build passed: 336 modules, no legacy transport/Feishu SDK imports.
- Extra broad `tsconfig.json --noEmit` check has 544 existing diagnostics. A
  compiler-host comparison substituting the exact pre-change files produces the
  identical diagnostic list, with no new diagnostics. This extra legacy/test
  check is not being represented as passing; the standalone build uses
  `tsconfig.app.json` and passed.

Desktop hosting and headless TaroBot CLI share these adapter fixes. Mobile sees
the same host result, with no new command, Hub schema, UI or network-membership
change. Existing running engine processes were left alone; upgrading an
executable does not replace a process already running. All audit-owned probe
processes were closed.

The installed App remains 1.0.67; the source client is 1.0.69 and host/CLI source
is 0.1.422. This audit does not claim the newly repaired host code is installed on
the user's desktop or phone. Installers and the standalone CLI package require
the normal coordinated release gates.
