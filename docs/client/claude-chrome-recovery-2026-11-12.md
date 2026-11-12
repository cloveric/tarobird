# Claude Chrome: recover a closed window without restarting

The main Chrome can still be running with no windows. A process check therefore
does not establish that the extension is connected. An older App rule summary
could also survive in a model's notes and be copied into a publishing subtask,
forbidding the window activation that the current App contract permits.

## Current behavior

For Claude Bots with Chrome integration enabled, native App instructions now
require reading the current browser capability before browser work or drafting
a browser subtask. This reminder also covers continuation and publishing
requests without browser keywords. Children unable to call the App capability
use the steps carried in the parent's brief; no child tool authority is added.
Sessions using the non-native fallback
receive the same recovery procedure in their turn instructions.

The procedure applies only to the selected main Chrome:

1. Check the browser tool. A connected session needs no new window.
2. If disconnected, make at most one permitted recovery sequence. On macOS,
   normally open/activate Chrome and recheck; if still disconnected, a guarded
   AppleScript attempt creates a window only when its window count is zero.
   Use a short tool timeout and stop on an Automation prompt or denial. Other
   platforms require their supported normal open/activate action; this guide
   has no verified native commands for them.
3. Allow at most two browser-tool checks within a ten-second retry budget. Only a successful
   call against the intended browser/profile proves recovery. A process,
   window or socket alone is insufficient.
4. If it still fails, the profile is uncertain, or login/permission is required,
   report the result. Do not inspect profile files or force a profile to guess
   identity. Quit/relaunch still needs approval. The procedure does
   not grant Automation permissions, change settings, switch profiles or
   introduce a debugging port. Preserve the user's tabs and the last tab of
   every window when cleaning up a task.

Current steps replace only obsolete **App-rule summaries**, not explicit user
or skill restrictions; unclear sources remain restricted. Child-task briefs must carry these same boundaries.
This is model guidance, not an automatic browser service or proof that every
extension failure is recoverable. No browser is opened by the Host itself.

## Scope and verification

- `src/gateway/agent-instructions.ts` owns the shared contract. There is no
  change to engine launch arguments, Chrome settings, identity, persisted tool
  schemas or browser permissions. Disabled integration and other engines do
  not receive this Claude-specific procedure.
- The Host supplies the same guidance to App-connected Bots started by the
  desktop or headless CLI. No new CLI command or daemon is introduced; this
  is not a change to standalone Claude Code outside TaroBird.
- Focused regression covers native reminders, keyword-free Chinese/English
  follow-ups, legacy fallback, one recovery attempt, connection evidence,
  explicit restrictions, disabled integration and persisted native sessions.
- Source tests and the standalone build are separate from installed-Host,
  real-model and zero-window runtime acceptance. This change does not release
  or install an App. Private workflow repairs and historical execution records
  are kept outside the repository.
