# Conversation and subagent isolation audit — 2026-10-14

## Incident evidence

The reported immediate “Background task completed” reply is consistent with a
stale Claude task recovery notification, rather than evidence that another Bot's
conversation was resumed. Read-only inspection of the local Hub, Bot timeline and
Claude transcript found the following sequence (Asia/Shanghai):

- At 08:16 a command in the same native Claude session timed out and became a
  background task.
- At 17:42:31, immediately before the new user prompt, Claude recovered that
  task with status `stopped` and a summary saying the previous session ended
  without a completion record.
- At 17:42:32 the App published the generic completion message. The new user
  run continued to call tools after this message; the banner did not mean that
  new work had completed.
- The compared App conversations had different native Claude session IDs and
  no explicit Hub resume selections. Across the five local Bots and seventeen
  stored conversation bindings inspected, there were no duplicate native IDs.

The historical raw stdout wire was not retained. The precise frame that lost
metadata cannot be reconstructed from the timeline alone. Fault injection does
reproduce the adapter's generic completion from an empty task-origin result with
no task ID, status or summary. We fixed that false completion and independently
reproduced the isolation defects below. Private prompts, task output, credentials
and production identifiers are deliberately not copied into this report.

## Reproduced defects and repairs

| Priority | Defect / trigger | Repair |
| --- | --- | --- |
| P1 | Forwarded Claude child `init` frames could rebind the parent worker; child assistant/result frames during a background review could overwrite or close that review. | Handle `parent_tool_use_id` before session binding, host tools and task lifecycle. Only a live parent tool may receive child progress. Child control requests fail explicitly without borrowing parent capabilities. |
| P1 | A result explicitly identifying task B during task A's review used A's callback/metadata and cleared A's text. Promoting another queued review could also erase the previous streamed result. | Match explicit task IDs to their retained owner/queue entry, keep foreign results out of the active review buffer, reject unowned interlopers, and capture the result before advancing the queue. Already-collected notifications cannot replace another review. |
| P1 | The one-shot Claude JSON parser accepted child/background results as the parent answer and native session binding. | Exclude child and task-origin records from the foreground parser, including its fallback. A sole child/background record cannot supply a foreground response. |
| P1 | Kimi ACP updates with another session ID appended text/thinking/tools to the active session. | Require the live worker's exact native session ID before updating conversation state. |
| P1 | Kimi ACP permission and form requests with another session ID invoked the current conversation's approval callback. | Cancel mismatched requests before publishing a question/permission event or invoking the approver. The wire request receives a cancellation response. |
| P2 | Empty Claude task-origin recovery results without any terminal metadata fabricated a completed-task message. | Omit the content-free notification; preserve known task summaries and stopped/failed/completed status. A background notification still cannot complete an unrelated foreground turn. |

P1 findings are demonstrated with injected interleaved/foreign engine frames;
they are not a claim that those cross-session events occurred in the reported
production incident. The original regression tests failed before the respective
repairs. Additional variants cover queued reviews, unknown task results and child
control responses.

## Boundaries checked

- **Bot and conversation state:** each managed Bot's state directory owns its
  session store. Explicit conversation keys are used instead of display names.
  Missing/reset bindings mint fresh logical sessions. Conversation locks include
  the canonical state path; native-session locks serialize explicitly shared
  native sessions.
- **Resume:** App selections are scoped to the selected Bot's session store and
  use binding-operation receipts. A stale applied selection does not undo a
  reset. Explicitly resuming a chosen native session intentionally inherits its
  context; it is not an isolated new conversation.
- **Codex:** thread/turn matching, retired turns, Goal ownership, unrelated-thread
  cancellation, scoped dynamic tools and child/request rejection.
- **Claude:** worker aliases, retired-worker events, parent/child routing,
  foreground vs background ownership, review ordering, original-turn callbacks
  and native App-tool grants/cancellation.
- **Antigravity:** distinct conversation workers, unexpected conversation-ID
  changes, user-echo admission, retired output and persistent/Goal results.
- **Kimi:** ACP session identity, hook session/turn/task ownership, background
  continuations, approvals, form questions and terminal session checks.
- **DeepSeek:** session-keyed events, RPC/turn ownership claims, Goal vs user
  work, background jobs, reconnect replay and native App-tool lifetimes.
- **Gateway and collaboration:** asynchronous message context, explicit delivery
  destinations, scoped file tools, quote resource membership and authenticated
  Bus delegation. Delegation uses fresh ephemeral sessions rather than recycled
  synthetic chat IDs; it does not resume another dialogue's stored context.

## Verification and limits

The final macOS regression run passed **23 suites / 792 tests**. The standalone
host build also passed (325-module graph, no legacy transport or Feishu SDK).
The final suite includes all five engine adapters, session store/manager,
Bridge/Goal locks, Hub authorization, Gateway bindings/message delivery, Bus,
App tools, async questions and Claude/Kimi native callbacks. New fault-injection
tests cover eight cases across the Claude and Kimi suites.

This is source/protocol regression verification plus read-only production
forensics. It is not a live five-provider model run, a Windows/Android hardware
test, or proof that every upstream CLI version emits perfect ownership metadata.
No running production sessions were reset, rewritten or restarted by this audit.

Different conversations of one Bot intentionally share that Bot's workspace,
persona and persistent memory. These are not filesystem or OS-user security
sandboxes. A model explicitly instructed to read shared files, use memory, resume
a selected session or delegate context can receive that information. Native
subagents can receive their parent's delegated context by design; they must not
overwrite an unrelated parent's session or delivery permissions.

## Desktop, mobile and headless CLI

All repairs are in the shared host adapters. They apply to a desktop-hosted or
headless CLI-hosted Bot and its connected desktop/mobile clients. No parallel
runtime, command, pairing or network-membership change is required. No App
installer or standalone CLI package is published by this source-only audit;
installed hosts need the corresponding updated host build to receive the fixes.

## Follow-up: a Monitor expiry is not a completed task

A second report showed a generic completion card at 18:20 on October 14. The
read-only Claude transcript identifies a Monitor started at 17:50 for disk-scan
events, followed by its 30-minute expiry at 18:20:08. Its review returned only
`No response requested.`; the Bot timeline and Hub recorded the generic card at
18:20:13 in the same conversation. This is distinct from the recovered stopped
task at 17:42 described above. The original stdout wire was not retained, so the
exact intermediate frame shape cannot be reconstructed from that transcript.
The live worker was still using the installed 1.0.67 App host.

Fault injection against current source confirmed a remaining case: a
task-notification envelope containing `<event>` but no terminal status was
treated as a completed background lifecycle. An empty review fell back to the
Monitor's label; a no-response marker appeared as a separate chat reply.

The shared Claude adapter now distinguishes these Monitor events from terminal
receipts. Empty reviews and the exact no-response marker stay silent. Substantive
review text is delivered as an update, without completing the foreground turn,
forgetting the tracked task owner or announcing a terminal lifecycle event.
Ordinary foreground text containing the same phrase remains intact. The
timeline restart guard also leaves progress/update reports pending until a real
terminal receipt arrives, including the optional legacy service entry point.

Regression coverage replays empty and marker-only expiry reviews, releases the
next user prompt, preserves meaningful Monitor output and original ownership,
and checks that the foreground stays active beyond the completion grace timer.
The existing completion/failure and task-isolation tests remain required. These
repairs apply to both desktop-hosted and headless CLI-hosted Bots; no new command,
network membership or client protocol is needed. The focused verification passed
six suites / 365 tests, the standalone host build (332-module graph) and the
legacy-entry-point TypeScript check. Source verification does not update the
installed App host or establish real-device acceptance.
