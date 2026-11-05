# Joint review with Opus 5.5 — 2026-10-12

Baseline: `6da3f4a` (Bot permissions, PR #22). This is a source and isolated-runtime
review of TaroBot, followed by regression fixes. It does not change installed Apps
or restart user services.

## Review provenance

Codex reviewed the implementation and reproduced findings alongside a real
Claude Code invocation using `claude-opus-5-5[1m]`, `--effort xhigh`, no session
persistence, no Chrome and no external MCP configuration. The returned model
usage identifies `claude-opus-5-5`; the broad read-only review completed 127 turns.
Supplementary Codex reviews covered client lifecycle and portable integrations.
Subsequent Opus reviews examined the patch and the supporting source. Raw provider
transcripts remain outside the repository; no credentials or personal runtime
configuration are part of this change.

The final targeted Opus 5.5 follow-up returned **no confirmed findings** after
checking backup sync, directory sync, replacement ordering and failure cleanup.
This conclusion applies to the reviewed source, not physical power-loss or
installed-device acceptance.

## Confirmed defects and repairs

| Area | Failure before the fix | Final behavior |
| --- | --- | --- |
| Execution permissions | Missing, unreadable or malformed config, or an invalid permission value, could be treated as absent and resolve to Bypass/YOLO. Some process adapters read permission and model settings from different snapshots. | All seven native adapter variants validate execution-critical fields from one snapshot and stop with a fixed, non-secret error. Valid omitted fields retain documented defaults. Service construction and inspection remain tolerant so a broken instance can still be repaired. |
| Configuration recovery | After execution correctly blocked corrupt config, an unrelated model/budget change could quarantine it and recreate a config with default Bypass; engine selection also treated invalid permission values as absent. Moving the old file before replacement could recreate this failure after an interrupted write. | Recovered configs use normal approval. Copy the original to an exclusive backup, sync the backup and supported parent directory, and keep the original in place until the fsynced replacement is ready. Backup, updater or sync failures cannot turn damaged config into missing config or overwrite an older backup. Explicit permission choices still work; new-instance defaults are unchanged. |
| Concurrent settings | An idle count captured before waiting for the config lock could allow a permission save after work had started. | Count active work inside the lock and again after the temporary file is synced. Reject the save without changing the original config/revision, and remove the temporary file. |
| Delegation and approval | Bus requests did not appear in the conversation run map, so an executing Bot appeared idle. | A live getter includes Bus requests and pending approvals; count each conversation once. Permission changes are blocked while work remains; effort responses report the current count. |
| Engine selection | Selecting or reselecting Antigravity changed explicit normal approval to full-auto. The legacy Claude process adapter ignored its native mode selection. | Keep the user's Antigravity approval choice. Pass Claude manual/auto/acceptEdits through unchanged; never silently use Bypass instead. |
| Error guidance | Permission changes blocked by background work could produce a generic execution failure or suggest restarting/resetting. | Explain that current/background work must finish before retrying. Invalid config tells the user to repair it; neither asks them to discard the conversation. |
| Settings dialogs | Reading settings locked every exit. A delayed save from a removed group Bot could overwrite the remaining Bot's UI. | Reads can be abandoned; requests have bounded waits and belong to one Bot/connection. Retired responses are ignored. Saves retain explicit success/failure handling and never retry automatically. |
| Image preview | The custom overlay did not participate in native Escape behavior; a native close without cancel could leave React state stale and prevent reopening. | Use a native modal dialog, handle cancel and close, restore focus and allow the same image to reopen. Keep Android back behavior. |
| Portable ASR | The agent only recognized the old Qwen installation path, and an explicitly empty HTTP endpoint was replaced with a default URL. | Match the voice router's new-install/legacy/override precedence, quote paths, and honor HTTP opt-out. |
| Long-audio cleanup | Errors after an OSS object was created but before the upload receipt was returned could leave the object behind; receipt-write errors could obscure the original failure. | Clean up the remote object for upload/signing/receipt failures and soft termination; preserve the original error if cleanup metadata cannot be written. |

## Review findings that did not require a change

- A patch review suggested Claude `manual` was unsupported. The installed Claude
  Code 2.1.296 help explicitly lists `manual`, `auto` and `acceptEdits`; the stream
  adapter already used this contract. Added process-adapter mode regressions.
- A conditional concern that soft termination bypasses `except Exception` did
  not apply: `TerminationRequested` inherits `Exception`, and SIGTERM/SIGINT are
  converted to it. Added a mid-upload termination regression alongside the
  existing real subprocess SIGTERM test.
- Compatibility salvage does not drop a valid normal approval mode when an
  unrelated field is invalid. Permission fields are validated before salvage;
  a regression verifies normal is retained with an invalid budget and
  incompatible effort.

## Validation

- `scripts/pre-complete-hook.sh`: **213 test files passed, 2,823 tests passed,
  1 skipped**. The standalone build contains 289 modules, no legacy transport or
  Feishu SDK. This was run after the Bus, Antigravity, recovery and boundary regressions.
- Configuration recovery reproduced 8 failures before the initial fix and 3 more
  interruption/backup-overwrite failures before the atomic recovery correction.
  A further regression reproduced the missing backup-sync ordering. The final
  focused configuration/permissions suite passed 96 tests, including
  failed sync, cross-engine changes and explicit wider-access selection after recovery.
- The optional legacy adapter also passed TypeScript checking with
  `tsconfig.legacy.json`, including the final recovery change.
- Client translation validation, TypeScript and production build passed.
- Chromium: 13 focused cases passed across settings lifecycle, permissions,
  effort, attachment reply/forward and Word/Markdown preview. WebKit: 8 focused
  cases passed. After the final native-close correction, both image cases were
  rerun successfully in both browsers at desktop and phone sizes.
- Broader Chromium checks covered IME, message/Bot/conversation menus, search,
  conversation files, pairing/recovery/route repair, multiple hosts and worker
  recovery. 24 of 25 passed in the combined run. The remaining IME case failed
  during initial pairing because a concurrent client rebuild removed its loaded
  JS chunks (HTTP 404 in trace); both IME cases passed after the build completed.
- Focused tests use held real Bus requests, actual config-file mutex contention
  and sync, and Python adapter fixtures for OSS cleanup. Source review also
  checked attachment membership/copy flow; Hub forwarding, file listing and
  Gateway regressions passed.
- Gitleaks found no secrets in the changed source and documentation. GitHub
  source and optional-Feishu checks for the first PR commit did not start:
  both annotations report account payment or spending-limit problems
  ([run 38178835954](https://github.com/cloveric/tarobot/actions/runs/38178835954)).
  Hosted CI remains a separate infrastructure limitation from the passing local gate.

These checks do not establish physical Android/iOS behavior, the currently
installed desktop App's behavior, production relay connectivity, actual cloud
speech/OSS credentials or every provider's live tool-approval round trip. Native
background jobs may defer a permission switch until they finish; this change
does not promise revocation of an already running task.
