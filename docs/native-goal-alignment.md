# Native goal commands

TaroBird uses the engine's native goal execution, shared by App conversations
and messages sent through the headless Host CLI. It does not implement another
autonomous scheduler. Native behavior was checked against Codex CLI 0.167.2 and
Claude Code 2.1.323.

## Codex

| Input | Behavior |
| --- | --- |
| `/goal <objective>` | Create a fresh goal; replace the previous pursuit. |
| `/goal --budget 50000 <objective>` | Create a goal with a native token budget. |
| `/goal` or `/goal status` | Read the actual native state and usage. |
| `/goal pause` | Stop autonomous continuation; the current native turn may finish. |
| `/goal resume` | Resume the retained goal with an attached progress/approval observer. |
| `/goal edit` | Show the current goal and text-command editing instructions. |
| `/goal edit <objective>` | Edit without resetting usage, budget or status. |
| `/goal edit --budget 50000` | Change only the token budget. |
| `/goal edit --unbounded` | Remove the budget; retain objective and usage. |
| `/goal clear` | Wait for the native clear receipt, interrupt only the goal-owned turn and end observation. |

An edit does not implicitly resume a paused goal. The App uses text commands
instead of the native terminal's interactive editor. All six native statuses
are retained: active, paused, blocked, usageLimited, budgetLimited and complete.
The end of a progress observer is not evidence that the objective succeeded.
Paused, blocked and limited goals remain available for inspection and recovery.

Status, pause, resume, edit and clear remain usable while ordinary input is
running. They retain the normal access checks and cannot follow an App session
selection change into another native session. Bot-origin, forwarded and group
workflow text does not gain a control-command bypass.

After a Host restart, an active goal without its original observer is suspended
before ordinary input. The reply explains that its target and accounting are
retained and `/goal resume` reattaches observation. TaroBird does not claim to
recover tool/approval ownership for native turns that began while disconnected.
A completed or suspended native goal is no longer erased by ordinary input.

The existing background-goal capability boundary remains: native goal turns
are not ordinary App delivery turns. They cannot call conversation-scoped
`app_send_file` or Workbench tools, even if a resumed native thread remembers
those tool names. Use an ordinary follow-up turn to deliver the resulting files
or place them in the Workbench. This change does not widen tool permissions or
attach a stale App message identity to autonomous work.

## Claude

`/goal <condition>` must reach Claude as a native command. Private per-turn App
instructions and attachment references precede a separate, final command text
block; they do not prefix the slash or become part of the completion condition.
Ordinary message framing is unchanged.

TaroBird normalizes `/goal status` to bare `/goal`, and clear aliases to
`/goal clear`. Native Claude would otherwise treat the literal word `status`
as a new completion condition. Queries and clear commands are local commands,
not ordinary model prompts. `--budget` is rejected explicitly: Claude has no
native enforceable token budget equivalent to Codex's.

Native continuation, completion checking and stop behavior remain engine-owned.
An ended model turn alone does not prove that the goal was satisfied. The UI
shows the goal banner only after native acceptance. At the end it reports
whether a goal is still set, no goal is set, or the state could not be verified.
An idle worker can answer one local `/goal` query without a model request;
background work takes precedence. No goal remaining is not proof of success:
the evaluator can also decide that the condition is impossible.
If Claude starts background processing just before consuming the local query,
that query can be queued by the CLI and delay the final state receipt. The
already streamed answer remains visible; the host does not replay the task.

Goal turns use the neutral heading **Turn ended** in both the fallback card and
the App's native run view. The presentation hint lives outside the strict v1
run summary so old clients can still read the response and its explicit state
explanation. Ordinary replies and local status/clear commands keep their normal
headings. Stopping interrupts the turn but retains the native goal; use `/goal`
to inspect it or `/goal clear` to remove it.

The adapter does not parse Claude's private session files. A restored goal is
recognized when current native feedback and a query establish it. If a restored
goal ends before either establishes its identity, the ordinary turn has no goal
receipt. TaroBird does not infer a successful goal from that absence.

## Verification boundaries

Tests cover parser routing, shared Host/CLI lifecycle, state preservation,
exact native turn ownership, admission/access checks, delayed native receipts
and final-card delivery failures. Isolated native CLI probes use local synthetic
providers to verify protocol execution without modifying user sessions.

These checks are source/protocol evidence. They do not certify real-model
completion quality, usage billing, signed installers or installed device flows.
No release or installation is implied by this source change.

The optional isolated Claude protocol check is
`TAROBIRD_LIVE_CLAUDE_GOAL=1 npx vitest run tests/claude-native-goal.test.ts`.
It uses the installed CLI with a temporary configuration and local synthetic
provider. Browser coverage in `client/e2e/goal-native-ui.spec.ts` exercises Core,
Gateway, Hub and the App rendering with synthetic engine receipts.

Upstream references: [Codex commands](https://learn.chatgpt.com/docs/developer-commands#set-or-view-a-task-goal-with-goal),
[Codex App Server](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal),
[Claude goal](https://code.claude.com/docs/en/goal).
