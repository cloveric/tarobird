# Desktop Agent Bus workspace

Agent Bus workspaces make the existing same-host collaboration commands reusable
from the desktop App. A named Bus stores a coordinator, ordered members, a mode,
and the conversations in which its work is recorded. It is not a group chat:
Bus membership does not merge conversation histories or share attachments.

## Interaction

- Open Agent Bus beside the sidebar's new-conversation control or from the ADHD
  toolbar. The App enters ADHD and opens the configuration pane on the right.
- Choose the owning host, name, mode and managed Bots. A Bot can fill multiple roles, including the coordinator
  role; each slot binds a different conversation. Choose dedicated
  record conversations (created on save) or existing direct conversations owned
  by that host. IDs, not display names, are the stored identity.
- Save first, then write and explicitly start a task. Saving a definition never
  sends a task, enables a service or changes collaboration permissions.
- Chain and Fan member cards expose a persistent **−** control in their upper
  right corner, including unassigned slots. Removal edits the draft until Save;
  it retains conversations, messages and existing ADHD panes. Removing another
  member preserves the current inspector's Bot and record binding, and steps
  are renumbered. Keep at least one member besides the coordinator. Active runs
  and disconnected/read-only hosts cannot change membership; Ask, Verify and
  Crew retain their fixed role counts. Keyboard removal restores focus to the
  selected surviving card.
- If necessary, explicitly prepare the selected reciprocal permissions. This
  uses the existing shared preparation algorithm and idle-restart receipts.
  Unknown listeners and disabled permissions containing an unselected Bot or
  a wildcard require review before any writes. Silently enabling them could
  grant more access than selected. Already active grants are preserved.
- Saved Buses appear in the left sidebar under their owning host. Opening a Bus
  reveals its member conversations in ADHD, within the existing twelve-pane
  limit. Other open panes and their drafts are preserved. Closing a member pane
  changes only the local layout, not membership or execution.
- Click the left sidebar's **Agent Bus** heading to collapse or expand the saved
  Bus list. The compact heading retains its total count and a running indicator;
  existing polling continues while folded. The preference is local to this App,
  shared by normal and ADHD views and retained across reloads. The independent
  new-Bus button remains available in ADHD. Folding never closes member panes,
  changes task state or clears configuration/composer drafts.
- Closing the settings pane keeps its draft mounted. Switching Buses or leaving
  ADHD prompts before discarding unsaved configuration or an unsent task.
  Reloading configuration also asks before replacing an edit.
- Stop applies to a particular run. Delete removes the saved definition and keeps
  its conversations and messages. Running work must finish or stop first.

The panel is a persistent side column on wide desktops, and a right-side overlay
below 1360 pixels so it does not squeeze conversations beyond usable widths.
Open/close, mode changes and active flow indicators respect reduced-motion
preferences. Status describes actual stages and never invents a completion
percentage. The phone App has no visual Agent Bus or ADHD entry.

For the subsequent participant-graph redesign, see
[interactive graph and verification](agent-bus-graph-redesign-2026-10-18.md).
The subsequent [independent audit and verified repairs](agent-bus-independent-audit-2026-10-18.md)
records DeepSeek Max findings, Opus review, reproductions and disposition.

## Conversation-bound participants follow-up

Flow cards show the Bot name and bound conversation title, with role and status
on a compact shared line. The member inspector always shows the conversation
selector. All managed Bots remain selectable for every role; conversations
already used elsewhere in the flow are disabled and labelled. An omitted
binding gets a distinct per-slot dedicated conversation on save. Reordering
saved slots keeps both IDs together. Historical snapshots and ADHD badges use
the same Bot/conversation pair, including after renames or later definition edits.

Execution carries a slot index to the observer and a conversation ID to the Hub.
It never infers a role from the first matching Bot or from completion order.
Ambiguous legacy reports and a changed conversation on an existing stage ID are
rejected. Old unique-Bot stage reports remain replayable. The original repeated-Bot update used `agent-bus.runs.v2` and schema 18.
The [per-stage task update](agent-bus-stage-tasks-2026-10-19.md) advances these
to v3 and schema 19, retaining existing conversation bindings and old run
snapshots. Older workers fail closed before receiving a task; both Hub and
workers need the corresponding update.

A coordinator Bot used in another slot executes via the existing local Bus
handler with a fresh temporary session and unique conversation lock scope,
budget/usage recording, cancellation and a timeout. It does not need a self-peer
network grant. Remote participants
retain both sides' Bus authorization checks. Permission preparation deduplicates
remote Bots and never enables dormant grants for local-only roles. A single
run admits at most four member calls per Bot, so an eleven-slot repeated-Bot
Fan does not overrun its eight-request Bus server limit. Ordinary slash-command
self-delegation and duplicate-target rules are unchanged.

This is a source follow-up, not part of the already published App 1.0.93.
Conversation binding still specifies **where tasks/results are recorded**, not
which historical engine session to resume; each Bus stage remains isolated.

Verification: 42 Chromium journeys pass across Agent Bus, collaboration setup
and delegation, plus 10 focused WebKit journeys. They cover repeated-Bot
selection, disabled occupied chats, save/reorder, independent ADHD badges,
historical snapshots, removal, permissions, drafts, narrow/dark layouts and
reduced motion. The production client build and translation checks pass.
Runtime tests use isolated real Hub/Gateway/Bus transports with deterministic
engines; browser Bus responses are controlled fixtures. Neither is installed
Tauri, physical-device or live model acceptance.

The full standalone gate passes: 338 files, 4,609 tests passed and one
Windows-only skip, with the history secret scan and 367-module build. Running
the broad browser matrix concurrently initially caused nine existing 5-second
async test timeouts; rerunning the complete gate alone passed in 185 seconds
without relaxing timeouts. Focused regressions additionally cover out-of-order
replies, four repeated Crew roles and revisions, local-only roles without grants,
eleven-slot fan admission, cancellation before admission, spoofed stage bindings,
legacy dedicated-chat reuse and default-chat allocation after reordering.

## Existing collaboration modes

| Mode | Work |
| --- | --- |
| Ask | Delegate to one member and return its answer. |
| Fan | Coordinator and selected members answer in parallel; preserve each result. |
| Chain | Ordered members receive the original task and the preceding output. |
| Verify | Coordinator answers, then one member reviews the answer. |
| Crew | Coordinator plans; researcher, analyst, writer and reviewer execute the research workflow. |

Execution continues through the existing Bus and Crew implementations, including
permission checks, usage accounting, budgets and cancellation. Delegated members
use independent Bus sessions; their selected record conversations do not supply
prior engine history. The visual Bus also isolates the coordinator's own Fan
and Verify answers; Crew uses independent sessions for planning and member work.
The standalone `/fan` and `/verify` commands retain their existing conversation
context behavior. Recorded member output is not enqueued
as another prompt or counted as a second engine invocation. Independent member
records retain their streaming-to-terminal lifecycle for completion notifications
and unread tracking, but do not activate the ordinary chat's typing, queue hint
or stop control. Real foreground replies in the same conversation still do.

## Persistence and requests

Definitions belong to a host and are addressed by host identity plus Bus ID.
Revision checks protect configuration from edits in other clients. Every create,
start and stop request has an idempotency receipt. An uncertain retry preserves
its request ID; after a confirmed successful start, intentionally submitting the
same task text again creates a new request ID and a new run.

The App's permission preparation and the CLI share
`src/client-protocol/collaboration-prepare.ts`; the old client module remains a
compatibility re-export. Bus definitions, runs and stage records use the shared
`src/client-protocol/agent-bus.ts` contract. A saved run includes an immutable, fully resolved configuration snapshot. Editing
members after completion changes the next run only: historical roles, record
conversations and stage badges continue to use that snapshot. Reusing or
renaming a Bus does not rename its existing dedicated conversations.

A run and its stage mapping remain tied to the original authenticated
coordinator and source message. Record targets must be unarchived direct
conversations containing exactly the selected Bot and belonging to the owner.
The Hub checks these bindings before starting and rechecks record-conversation
type and Bot membership before publication, so adding another Bot later cannot
expose a private task to it.

The owning Hub exposes `/api/agent-buses`, `/:id`, `/:id/runs`, and
`/:id/runs/:runId/stop`. Mutations require host owner authority and current
membership. No new Hub or separate background CLI is started by this feature.

The database advances to schema 18. Older Hubs reject this state instead of
reading a queued Bus task as ordinary chat. The host updater and backup range
advance together; downgrades require the existing compatible-backup restore
path. A connected worker without the Bus capability gets an explicit failure
for the Bus task, while normal queued messages remain dispatchable.

## Headless use

The visual configuration is desktop-only; the underlying host capability remains
available to the CLI. For exact options and JSON configuration, see
[the host CLI](../host-cli.md#agent-bus-协作工作区).

Sidebar folding is a local presentation preference; it adds no host state,
protocol or CLI command. Its browser regression checks keyboard expansion,
reclaimed sidebar space, current status while folded, switching desktop layouts,
reload retention, and unchanged panes, drafts and task mutations. The focused
four-journey matrix passes in Chromium and WebKit. The client production build
and complete standalone gate pass (4,596 tests, one Windows-only skip), including
the history secret scan. The folding follow-up is included from App 1.0.93; the 1.0.92 installers do not
contain it.

Inline member removal moves an existing editor action into the graph. It uses
the same revision-checked configuration update; the CLI can already reduce the
`members` array through `tarobot bus update`. No host capability, protocol,
execution path or new CLI command is introduced. This follow-up is source-only
and is not included in the already-published 1.0.93 installers.

The removal regression first failed against the old renderer because no graph
card exposed the action. With the fix, 24 focused unit tests and eight browser
journeys in each of Chromium and WebKit pass, as does the production client
build. They cover Chain/Fan removals, unassigned slots, selection and record
bindings, save/reload, retained task drafts/messages/ADHD panes, fixed roles,
active-run locks, keyboard focus, dark/narrow layouts and reduced motion.
Bus API responses are controlled fixtures; these results are not installed
desktop or physical-device acceptance. The full standalone gate also passes:
338 files, 4,596 tests passed, one Windows-only skip, history secret scan and
the 367-module standalone build.

```sh
tarobot bus list --json
tarobot bus create --from ./research-bus.json --request-id research-team-1 --json
tarobot bus permissions COORDINATOR_ID --json
tarobot bus prepare --coordinator COORDINATOR_ID --members RESEARCHER_ID,REVIEWER_ID --yes --request-id prepare-team-1 --json
tarobot bus run BUS_ID --text-file ./task.txt --revision REVISION --request-id research-run-1 --json
tarobot bus show BUS_ID --json
tarobot bus stop BUS_ID --run RUN_ID --request-id stop-run-1 --json
```

This does not change cross-host Agent Bus routing. A Bus remains on a single
host. Existing cross-host `messages send` is a separate capability.

## Verification record

The implementation was jointly reviewed with an independently running Claude
Opus 5.5 at xhigh effort. The UI and CLI were also exercised by independent
reviewers. Confirmed findings were reproduced and fixed; optional future
features were kept separate from defects.

- Browser journeys use the production App and an isolated Hub for pairing,
  history, host identity and ADHD persistence. Controlled Bus API responses
  cover configuration, uncertain receipts, revision conflicts, history snapshots,
  role loss, disconnected hosts, stop races, draft guards, narrow/dark layouts
  and reduced motion. These are UI checks, not model execution evidence.
- Adjacent ADHD, collaboration preparation and delegation browser regressions
  cover existing chat, layout, independent fonts, scrolling and sharing controls.
- Native acceptance uses a macOS WKWebView test shell with an isolated real Hub,
  Gateway and Bus transport. Deterministic member replies make invocation order,
  result forwarding and record destinations verifiable without sending tasks to
  the owner's active Bots. This is not a packaged Tauri or physical Windows test.

Confirmed review findings addressed in this change:

- Repeated intentional tasks now get fresh run receipts after a confirmed start;
  uncertain retries retain their original receipt.
- Initial detail-load failure can recover, first creation opens Run, and manual
  configuration reload does not unexpectedly switch tabs.
- Ordinary ADHD entry does not reopen a stale Bus. Cancelling an entry during
  draft persistence or attachment-capacity review preserves the user's draft.
- Completed runs retain their original mode, members and record destinations
  after the reusable definition is edited.
- Private member output cannot be bound to a group or a conversation containing
  another Bot; bindings are checked again when records are published.
- Worker capability and schema checks keep Bus tasks from becoming ordinary
  prompts on an older runtime.
- Stage reports are durably ordered before input acknowledgement. Failed local
  persistence cannot be hidden by a later successful terminal report; model work
  is not repeated to reconstruct a missing record.
- Independent Bus records preserve completion/unread semantics without occupying
  ordinary foreground typing and Stop controls. A deliberately stopped member
  record does not send a misleading completed-answer notification.
- WebKit first-open visibility, stale stop confirmations, unavailable hosts,
  permission preparation and unsaved-edit guards have dedicated regressions.

The browser matrix covers 47 distinct journeys in Chromium and WebKit (94
engine/case pairs), through successive frozen builds with affected paths rerun
after fixes. This is not a claim that all 94 were repeated on the last build.
A further real-Hub journey passed in both engines without Bus API fixtures:
list/detail refresh, queued-to-running updates, closing a member pane while work
continues, and explicit cancellation before the next member executes. Each run
called only its first member once. Focused record/view/Stop helpers pass 20 tests.

The native WKWebView shell verified creation without execution and a real
researcher-to-reviewer chain: two calls in independent Bus sessions, the prior
output forwarded to the second member, and completed records in their selected
conversations. The shell's background panel-refresh/animation observation was
inconclusive; the same live Hub refreshed normally in both browser engines.
Packaged Tauri foreground/background acceptance and physical Windows acceptance
remain release checks. Deterministic bridge replies validate routing and control
flow, not the answer quality of five real model engines. No production Hub,
installed App or release package was replaced by this change.

The final repository gate (`VITEST_MAX_WORKERS=4 bash scripts/pre-complete-hook.sh`)
passed: full-history privacy checks, standalone host build, and all 336 Vitest
files (4,535 tests passed, one platform-specific test skipped). The client
production build also passed. Staged privacy and three repository privacy-script
checks passed separately.

The first full run exposed a test-fixture race: a question card could become
visible before the test installed its completion callback. The callback is now
installed before publishing the card. Two other Gateway cases exceeded their
original deadlines in that run, then passed unchanged in their focused suite.
The final gate bounded parallel workers to four; no deadlines or assertions were
relaxed. Both original failure logs and the successful rerun are retained in the
local verification artifacts.
