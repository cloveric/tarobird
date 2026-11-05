# Group discussion modes: Host, Gateway and CLI (2026-10-20)

Issue #52 adds three group modes. This note covers the shared Host behavior used by
the desktop/mobile App and the headless CLI. UI notes live with the client change.

## Modes and delivery

| Mode | Unmentioned message | `@` one or more Bots |
|---|---|---|
| `mentions` (ordinary) | Saved only, delivered to no Bot | Only the mentioned Bots, in parallel |
| `sequential` | Saved only; during a run it is a user note for later turns | Separate question, outside the run |
| `independent` | Same as sequential, but never shown in the independent first round | Same |

Intentional change: a group or topic message without a mention is never
broadcast. This now overrides the per-Bot `/group all` reply mode for App groups
(Owner decision). Direct chats are unchanged. A discussion never starts from a
missing mention; it starts only from an explicit start request.

Settings belong to the root group (topics inherit). `GET/PUT
/api/groups/:id/settings` extend the existing compare-and-swap: the settings
revision is a content hash of title, member set, mode, order and round limit.
A request without `policy` (older clients) keeps the saved mode; the saved order
follows membership (removed Bots drop out, new Bots are appended). Discussion
modes require 2–8 members and 1–5 rounds. A member of the group's active run
cannot be removed (`group_discussion_active`); mode/order/round edits apply to the
next run.

## Runs

`src/hub/group-discussions.ts` owns runs (`group_discussions`) and turns
(`group_discussion_turns`, schema 20). Each speaking turn is one ordinary queued
input in the original group/topic: user-authored by the initiator, mentioning one
Bot, replying to the topic message. There is no hidden session, no Agent Bus run
and no delegation. Approvals, questions, run cards, Stop, the prompt queue,
attachments and native App delivery work as for any other input.

- Start: `POST /api/conversations/:id/discussion` with the settings revision the
  user saw, the topic text and optional upload IDs. Revision mismatch rejects the
  whole start before any message is written. `requestId` makes the start
  idempotent. One active run per root group (unique partial index). Every
  participant must be authorized for the initiator (same rule as group creation).
- Sequential: speakers in the saved order, rounds 1..N. Independent: round 1 is
  dispatched to everyone at once with only the topic; after every first-round turn
  is terminal the answers are revealed and rounds 2..N proceed in order.
- Context: frozen per turn in `context_json` (bounded): the topic, the
  attachments' names, other members' completed text not yet seen by this Bot
  (≤8,000 characters each, about 40,000 in total; older items shrink first), every member's latest position,
  the current proposal and up to ten user notes. Each Bot keeps its own engine
  session; the frozen summary covers earlier material after `/new` or a rebind.
- Messages: the topic and every scheduler input carry a Hub-owned
  `Message.groupDiscussion` marker (persisted in `messages.discussion_json`).
  Clients gate resend/retry and render localized chips from it; client frames and
  Bot publications cannot set it.
- User notes (unmentioned messages during a run) reach later non-blind turns as
  user text, outside the members' untrusted reference block.
- Dispatch: the Hub adds `groupDiscussion` metadata to `instance.message` only
  from its own turn record (`groups.discussion.v1` Host capability,
  `group-discussion.worker.v1` worker capability). Message text is never trusted to
  identify a turn.

### Advancement and receipts

A turn settles from durable state, and the run advances at most once per change,
inside one write transaction (receipt, publication, deletion, worker attach,
startup reconciliation). An acknowledgement alone is never success.

| Observed | Turn result | Run |
|---|---|---|
| Delivery accepted, replies terminal, worker report present | `answered` (`partial` if the run card is partial or a reply is an error) | Advance |
| Run card `error`, or no report and an error reply | `failed` | Pause |
| Run card `stopped` (Stop) | `stopped` | Pause |
| Run card `interrupted`, or `delivery.fail` | `interrupted` / `failed` | Pause, never rerun |
| Accepted with no report (normalizer drop, budget, prepare error) | `no_reply` | Pause |
| Bot deleted / no longer a member | `unavailable` | Pause; resume skips it |
| Worker without the capability | `worker_update_required` (input withheld) | Pause |
| Reply still pending/streaming/active phase | still live (`attention` = approval/answer) | Wait |

A receipt that precedes the final run-card publication is handled by settling
again on each terminal publication. Reads (`GET …/discussion`) never settle or
advance anything.

### Controls

`POST /api/conversations/:id/discussion/:runId/control` with the run revision,
`requestId` and `pause | resume | end | retry`. Only the initiator or the group
owner may control; members can read. Stale revisions conflict unless the
requested state already holds.

- `pause`: the current speaker finishes (`pausing`), then `paused`. An input that
  no worker has received yet is held by the queue claim until resume.
- `resume`: continues with the next speaker. A failed/stopped/uncertain turn is
  never rerun automatically; an unavailable Bot is skipped from then on.
- `retry`: explicit new attempt for the failed slot (new input, same blind state).
- `end`: never-dispatched inputs are withdrawn in the same transaction. A
  dispatched input receives an exact-message Stop, which cancels that pending
  Core queue task or aborts its own active run, never unrelated work. The
  discussion stays `ending` until actual terminal evidence; a cancelled Core
  task emits its normal skipped receipt when its queue advances. Failed or
  unconfirmed Stop requests are re-armed for publication, reattach or startup
  reconciliation. There is no timer-based skip.
- The control URL may name the run's conversation or its root group (a topic run
  is visible from the root group's status read).

## Positions and consensus

Every engine ends its final reply with one fenced block:

````text
```group_stance
{"stance":"propose|agree|disagree|abstain","proposalId":"P2","proposal":"...","summary":"..."}
```
````

The worker (`src/gateway/group-discussion.ts`) parses only a trailing block of
the Bot's own final output (unknown keys ignored, an overlong summary shortened;
position, proposal ID and proposal text strict), strips it from the visible reply,
and sends the completed text and position through the durable outbox
(`groupDiscussion.report`) before the input's receipt. Only the turn's primary
engine call reports; a Core artifact-repair call in the same turn never replaces
the speaker's answer or position. A malformed or missing
block is "no position", never agreement; no keyword matching is used. Peer text
in reference material cannot imitate a block or close the reference markers.

- `propose` creates the next proposal revision (`P1`, `P2`, …); earlier
  agreements no longer match. The proposer counts as agreeing with its own text.
- `agree` counts only for the exact proposal ID frozen into that Bot's turn
  context (a guessed, future or blind-round ID does not count).
- Consensus = every active member's latest successful position agrees with the
  same proposal. `run.positions` exposes this evidence per member.
- Independent round: after reveal, proposals are applied in configured order, so the
  current proposal is the last blind proposer's; others remain visible as positions. At the round limit the run completes with `different_views` and
  each member's latest position; no extra model call writes a summary.

The same fenced protocol is used for all five engines, which keeps one parser and
one test surface. Native tools could replace it per engine later without changing
the Hub, which only accepts the structured report for the reporting Bot's own
dispatched turn.

## Isolation boundary (independent first round)

TaroBot does not provide another member's first-round answer to a participant:

- The first-round input contains only the topic; its context has no peer material.
- `fetch` of another participant's reply (and its files) to a blind input is
  refused (`group_discussion_sealed`) until reveal, by joining the Hub's turn
  records, not by message fields.
- Cross-Bot messages that use a discussion turn as context are refused
  (`group_discussion_bot_messages_blocked`); discussion turns get no cross-Bot CLI
  context, an empty `TAROBOT_MESSAGE_ID`, no delegation/schedule recipes, and
  capability hints are selected from the user's topic only.
- Schedule directives from a discussion turn are refused by Core
  (`allowCronMutations: false`), with a discussion-specific notice. Slash
  commands, card answers, approvals-by-text, steering, batching, crew/Bus
  commands and archive workflows never run for discussion inputs.

This is not an operating-system sandbox. A Bot with full host permissions could
still read local state, shared workspaces or another engine's files. The user can
see every first-round run card, approval and question live.

## Reads

`GET …/discussion` is read-only. `?known=<runId>.<runRevision>.<settingsRevision>`
(`none.<settingsRevision>` without a run)
answers `{unchanged:true}` when nothing changed; `?brief=1` returns 600-character
step previews; `GET …/discussion/:runId/steps/:stepId` returns one full step. The
run revision also changes on dispatch and on approval/question waiting changes.

## Compatibility

- Automatic discussion arrived in schema 20; [parallel replies](group-parallel-replies-2026-10-22.md)
  extends settings in schema 21 (`package.json` `maxHubSchema: 21`). Older Hubs
  refuse this state and the update guard refuses rolling the runtime back.
- Old clients keep working for ordinary chat and can save title/members without
  losing the mode. They cannot start or control runs.
- Old workers never receive discussion inputs; starts are refused while such a
  worker is attached, and withheld inputs pause the run.
- Optional Telegram/Feishu adapters are untouched.

## CLI

`tarobot groups show|update|status|start|pause|resume|end|retry` (see
`src/host-cli/groups.ts`) uses the running Hub's HTTP API with the local
controller session; it never starts a second Hub. `update --from FILE` sends a
complete settings document (title, members, expected values, optional policy and
expected revision). `start` uploads `--file` attachments through the ordinary
upload API. Request IDs are printed to stderr; uncertain operations are not
retried automatically.

## Tests

- `tests/hub-group-discussion.test.ts`: settings CAS/old-client retention, mention
  delivery, explicit start, order/context, consensus and revision clearing, guessed
  IDs, receipt classification (receipt before final card, swallowed error, Stop,
  interruption, no report), controls/CAS/permissions, independent sealing and
  reveal, reconciliation after restart, deletion, worker gating, cross-Bot block.
- `tests/gateway-group-discussion.test.ts`: real Hub + three real Gateways with
  scripted engines (no model calls): sequential consensus, blind isolation even
  after a peer finished, swallowed engine failure, mention-only delivery, stance
  parsing and reference neutralization.
- `tests/host-cli-group-discussion.test.ts`: CLI against the real Hub HTTP API,
  including attachment upload, conflicts and option validation.

## Limits / not verified here

- No real-device, native App or real-engine run. Push notifications are unchanged
  (each Bot reply still notifies as before).
- Conclusions are deterministic text from positions, not a model summary.
- Workspace sharing between participants is not detected or warned about.
- Native steering into a live discussion turn (including a blind one) stays allowed:
  it is an explicit action by the user, not peer input.
- Stance parsing has not been measured with live models; consensus frequency with
  real engines is unverified.
- Turn contexts (`context_json`, bounded) are retained with the run; request receipts
  are pruned after 30 days.
