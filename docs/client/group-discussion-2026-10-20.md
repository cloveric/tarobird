# Group discussion modes

Issue: [#52](https://github.com/cloveric/tarobot/issues/52).

This change adds modes to existing group conversations and topics. It does not
create an Agent Bus workspace, change `/ask`, `/fan`, `/chain` or `/verify`, or
introduce a separate engine. Each speaking turn uses the existing Hub queue,
Gateway/Core runtime, per-Bot group session, run cards, approval/question cards,
and output delivery.

## User flow

This version uses existing single-Hub groups: the authenticated creator and
authorized Bots on that Hub. It does not add cross-host groups or invitations
for additional human users. Existing archive/restore and personal-history
deletion retain their existing scope; changing a mode does not grant Bot-to-Bot
permissions or access to other conversations.

Open **Group settings** from the desktop group's context menu or the phone's
long-press menu. The same settings are available inside a group's conversation
and topics. The creator can edit the group; other members can inspect it.

- **Group chat**: only explicitly selected/mentioned Bots receive the message.
  Without a selected Bot, the message is recorded without invoking an engine.
- **Parallel replies** (added October 22): without @, every Bot independently
  answers the user; explicit recipients override that default. No automatic
  rounds or peer-triggered replies. See [behavior, CLI and upgrade details](group-parallel-replies-2026-10-22.md).
- **Roundtable**: configure a speaking order and maximum rounds, then send the
  question from the main composer or explicitly start a topic. Bots receive
  earlier results and speak one at a time.
- **Independent review**: the first round is concurrent; each Bot receives the
  topic without the other participants' first-round answers. Once those turns
  are settled, later rounds follow the configured order with shared results.

Selecting or saving a mode does not launch work. The compact conversation strip
shows the mode, active speaker/round, or outcome and opens detailed progress.
The main composer follows the saved discussion mode. In roundtable/independent
mode it starts a discussion using the same revision-checked API as the topic
dialog; prior recipient selections cannot make it silently record nothing or
fan out ordinary replies. The recipient picker and single-Bot model shortcuts
are hidden while the composer is addressing a discussion. An active discussion
receives supplemental notes instead of another start; a run in another topic
requires navigating there. Ordinary and parallel group addressing are unchanged.
A new topic has its own per-host, per-conversation persistent draft. The ordinary
message draft is not replaced. Long turn bodies render only after expansion.
The details view shows the current proposal and each member’s explicit position;
completion icons alone do not represent agreement. Unmentioned messages during
an active discussion become supplemental user context for later turns; they do
not themselves invoke a Bot or change the discussion controls. First-round
answers that have already started do not receive them; since 2026-10-23 a
first-round retry does (see the recovery section below). The view discloses this rule.
The group shares its settings with its topics, and permits only one active
discussion across the root group and all of its topics.

Automatic discussions require 2–8 Bots, with a limit of 1–5 rounds. One round
means each participant speaks once; independent answers count as round one.
Starting is explicit and names the exact settings revision. Changing a saved
mode, order or round count applies to the next discussion, not an active one.
The settings form explains this when changing modes; use End to immediately
leave the current discussion.
Removing a participating member is rejected while that discussion remains
active. Bot names are presentation; stable Bot IDs own participation.

## Controls and honest results

- Pause waits for already-dispatched turns to finish, and holds inputs that have
  not reached a worker. It does not interrupt a live answer.
- Continue resumes the next turn. After a failed/uncertain turn it is explicitly
  labeled **Skip unfinished turns and continue** and does not replay that work.
- Retry is a separate explicit operation on an unfinished turn. Retries are
  bounded by the run's total turn limit.
- End targets the exact discussion input in the existing Stop operation, cancels unstarted
  inputs, retains results, and remains “ending” until actual terminal evidence.
- Disconnects, a lost HTTP response, and app reload do not automatically start a
  new run. The UI reads back durable state. A request ID binds explicit retries
  to the same payload; conflicting reuse is rejected.

A worker delivery is not proof that an engine is speaking: while Core still
queues an input the UI says “waiting”. A real active run card changes that
state and invalidates the reader cache. A cancelled queued input is shown as
cancelled rather than an unexplained missing answer. If Core is still handling
an earlier unrelated task, its cancellation receipt is emitted when the queue
reaches this input. The details view explains this wait; another discussion
cannot start until the receipt settles the current one. Earlier work is never
interrupted by ending a discussion.

A delivery acknowledgement alone is not a successful answer. The scheduler
considers durable delivery state, foreground run state, and the worker's own
completed output report. Missing output, failure, cancellation or uncertainty
cannot silently advance as success. Startup reconciliation settles already
known results without rerunning an uncertain turn.

Consensus requires explicit structured positions on the same proposal ID.
A proposal revision invalidates agreement with an earlier proposal. In the
independent first round, simultaneous proposals are applied in configured order;
the last such proposal becomes the current proposal for the later discussion.
Earlier views remain in the transcript and position summaries. Missing or
malformed position blocks are not agreement. Reaching a round limit retains
each participant's last position rather than asking another model to invent a
unanimous summary. The protocol works through all engines' normal final output;
it does not require engine-specific tools.

## Shared API and state

Capabilities: `groups.discussion.v1` for clients and
`group-discussion.worker.v1` for workers. An old host still supports ordinary
group settings but does not advertise automatic discussion controls. An old
worker cannot receive a discussion as if it were a normal bare user message.

- `GET /api/groups/:groupId/settings`: group, effective policy and revision.
- `PUT /api/groups/:groupId/settings`: existing title/member update plus optional
  `policy` and `expectedRevision`; atomically validates and saves. An older
  client that omits policy cannot reset it.
- `GET /api/conversations/:id/discussion`: policy and latest/active run; reading
  does not advance a run. An active run in another topic points to that topic.
  The App requests `brief=1` (600-character step previews), and uses a known-view
  token to avoid downloading an unchanged view. Tokens include the run identity,
  run revision and settings revision.
- `GET /api/conversations/:id/discussion/:runId/steps/:stepId`: the full text of
  one step, loaded only when expanded. Authentication and membership still apply.
- `POST /api/conversations/:id/discussion`: request ID, settings revision, topic
  text, optional existing attachment IDs and an explicit `replyTo` message.
- `POST /api/conversations/:id/discussion/:runId/notes`: request ID, text,
  optional attachment IDs and `replyTo`; atomically requires that exact run to
  remain live. Replaying the same receipt after completion does not send again.
- `POST /api/conversations/:id/discussion/:runId/control`: request ID, run
  revision and `pause`, `resume`, `retry` or `end`.

The Hub is the only scheduling authority. Authentication, conversation
membership, Bot grants, device revocation and attachment visibility retain the
existing API checks. Participants cannot set discussion metadata or report
another Bot's turn. Persisted Hub-owned message markers keep scheduler entries out of generic
resend. Clients render them as compact localized turn records; recovery uses
the discussion’s explicit Retry control. The worker's queue-only branch keeps scheduler inputs out
of slash commands, approval answers, question answers, batching and steering.

The first independent round seals peer answers and associated attachments from
every other Bot, including Bots added during that round, until reveal. Discussion turns cannot use the cross-Bot
message API to share those answers. This is a Hub/protocol boundary, **not an
OS sandbox**: an agent that has independent full host filesystem or network
privileges can access material outside these APIs. Existing per-Bot session
history also remains; independent review means withholding this round's peer
answers, not deleting the Bot's earlier memories.

Each run is bounded to 48 turns (including retries). Topic and stored reply text
are capped at 24,000 characters each, peer references at 40,000 characters total,
user notes at ten entries of 2,000 characters, proposals at 4,000 characters,
and position summaries at 500 characters. The UI reads 600-character previews
and mounts full reply Markdown only on expansion. An unchanged view is checked
before building the turn list.

These are per-run bounds, not a global database quota. Completed runs retain
frozen execution context and the conversation history; there is no automatic
history deletion in this PR. Idempotency receipts older than 30 days are pruned
on a new start. Long-term context compaction/retention needs its own policy and
migration; do not describe total storage as bounded.

Schema 20 introduced settings, runs, turns, request receipts and audit events.
Schema 21 extends the settings mode constraint for parallel replies.
Older runtimes must respect the existing schema compatibility gate. Back up
host state before a future release upgrade; do not launch an older runtime
against a migrated database.

## Compatibility and CLI

The deliberate ordinary-group change is that unmentioned messages no longer
broadcast to all members. Existing direct conversations are unchanged. A saved
reply-recipient selection is still explicit addressing. Older clients may keep
their existing recipient defaults. Ordinary chat still does not broadcast.
Parallel mode explicitly enables the all-Bot default, with a separate client
capability gate to prevent an older App from unexpectedly broadcasting.

Headless CLI commands use these same authenticated Hub APIs; the CLI does not
start a second Hub. Commands return JSON; request IDs for mutations are printed
to stderr before submission. `show` addresses a root group; `status`, `start`
and controls address either that root conversation or one of its topics.

```sh
tarobot groups show GROUP_ID
tarobot groups update GROUP_ID --from group-settings.json
tarobot groups start CONVERSATION_ID --text-file topic.txt \
  --revision SETTINGS_REVISION --request-id my-discussion-1 --file brief.md
tarobot groups status CONVERSATION_ID
tarobot groups note CONVERSATION_ID --run RUN_ID --text-file note.txt --file context.txt
# An attachment-only note does not require a text file.
tarobot groups note CONVERSATION_ID --run RUN_ID --file context.txt
tarobot groups pause CONVERSATION_ID --run RUN_ID --revision RUN_REVISION
tarobot groups resume CONVERSATION_ID --run RUN_ID --revision RUN_REVISION
tarobot groups retry CONVERSATION_ID --run RUN_ID --revision RUN_REVISION
tarobot groups end CONVERSATION_ID --run RUN_ID --revision RUN_REVISION
```

For `note`, use the exact `run.conversationId` returned by `status`. A root
group's status/control can resolve its current topic, but notes, uploads and
quoted messages belong to that topic. If the CLI observes that the specified
run belongs to another conversation, it names the correct `groups note` target
before uploading anything. It does not redirect, select a newer run or weaken
exact-run checks. Idempotent replay still uses the original topic and request.

Use the latest `show` result for the settings revision; controls use the run
revision returned by `status`. The settings file includes `title`, `botIds`,
`expectedTitle`, `expectedBotIds`, `policy` and `expectedRevision`. A lost response
does not automatically retry. Inspect status first; if explicitly repeating the
same operation, retain its request ID, revision and payload.
`start` and `note` also accept `--reply-to MESSAGE_ID`. Notes and quoted starts
require the additive `groups.discussion.composer.v1` Host capability; old Hosts
retain the draft and explain the needed update, rather than falling back to an
ordinary broadcast. Plain topic starts continue to use the existing API.

The composer persists each pending request before HTTP and retains its exact
body across a lost response or reload. It clears the receipt only after the
confirmed source text and attachment draft writes finish. Discussion notes
freeze up to 16 attachment resources from the latest ten user notes onto later
scheduled inputs, using the ordinary file pipeline; the independent first round
does not receive those supplemental resources. Explicit topic quotes use Core's
normal quoted-context handling.

### Main composer correction (2026-10-23)

The earlier acceptance tests started discussions through the separate topic
dialog. They missed selecting a mode and sending through the main composer.
Both owner-reported paths reproduced on the preceding source: with no recipients
there were no engine calls; with all recipients selected both engines started
before the first answer completed. The correction connects the main send action
to the saved mode; it does not replace the scheduler or infer order from UI
timing. Evidence: `/Volumes/gdrive/taro-tmp/group-composer-mode-20261023/`.

Validation: the two new desktop baseline probes fail with zero and concurrent
engine calls respectively. After the correction, Chromium passes the complete
24-case discussion suite, followed by all eight final composer/compatibility
cases (including attachment retry after reload and a concurrent settings edit).
WebKit passes the final complete 26-case suite. Host/Gateway/CLI and adjacent
group, message-context and voice regressions pass 105 tests across eight files.
Client translation/type/production and standalone Host builds pass. Desktop
and phone-width composer screenshots were inspected; the phone placeholder
fits without the former recipient picker.

This is an App/Host/CLI source correction. Browser fixtures exercise the real
Hub, Gateway and Core with scripted engine output. They do not establish real
model, installed App or physical-device acceptance; no installed Host or App is
updated by this change.

The start dialog accepts up to 16 topic attachments through the existing upload
API. Text and attachment drafts are separate from the ordinary composer and
survive reload. A confirmed start clears only the sent draft. Upload failure
retains the draft and does not start a discussion. Files also remain supported
through the ordinary group conversation and CLI.

### Stop, resend and speaker recovery (2026-10-23, Host side)

Owner report: in a roundtable, a mistyped topic was stopped from the main
composer; the corrected question then received no answer, later messages were
not obviously used, and Continue did not say what it continued. Reproduced on
`b3cb23c` with the real Hub and scripted worker callbacks: Stop paused the run
on a `turn_stopped` turn, so the next send became an inert note; Continue skipped
the stopped speaker and kept the mistyped topic; only the newest ten notes were
ever used, and notes written after the last scheduled turn reached nobody.
The App/UI half of this correction is documented separately by its owner.

Additive Host contract, advertised as `groups.discussion.recovery.v1` (the
start/note/control bodies are strict, so clients must check it first):

- **Stop = End of this exact run.** `end` and `pause` accept a stale run
  revision when the run ID matches; neither creates work. `pause` still applies
  only to a running run; `resume`/`retry` keep the revision CAS. End continues to
  wait for terminal evidence, so a new topic starts after `ended`.
- **New topic over a paused run.** `start.supersedes: {runId}` ends that paused
  run (same conversation, controllable, nothing handed to a worker) and starts
  the new topic in one transaction. A running/pausing/ending run is refused
  with `group_discussion_active`, and a run that already ended (for example on
  another device) with `group_discussion_not_active`, so the draft is
  reconsidered instead of silently becoming a plain start; nothing is created.
  A confirmed replacement still replays under its original request ID.
- **Add and continue as one decision.** `note.then: "resume" | "retry"` with the
  run `revision` stores the note and applies the control together, or neither.
  `note.ifRunning: true` refuses (`group_discussion_paused`) instead of storing a
  note in a run another device paused. Plain notes still never resume a run.
- **No silent note loss.** Each Bot receives the notes it has not received
  through its last successful turn, oldest first, at most ten entries; the
  remainder is announced in the last entry and carried to its next turn.
  Notes are only unmentioned, undelivered, non-deleted user messages in the
  run's own conversation between its start and finish (never a topic's or
  another run's topic). Contexts frozen before this change are treated as having
  received the notes written before them (first-round contexts: none).
  The independent first round withholds members' answers only: answers that
  have already started cannot receive a later note (it stays unseen), but a
  first-round retry receives the user's notes, so "add and retry" delivers the
  correction. A quoted Bot message (possibly a withheld answer) and its files are
  omitted from first-round notes and marked as withheld.
- **Run view.** `noteCount`, `latestNote {messageId, text≤500}`,
  `unseenNoteCount`/`unseenNotes` (≤20 IDs; at a terminal run, notes no Bot
  ever received), `next {botId, round, position}` (the slot Continue or normal
  progress schedules next) and `retryTargets`. A reader's own history deletion
  hides that note from their view only. A plain note bumps the run revision.
- **Speakers.** `start.participants` (2–8, a subset of the saved order, which
  they keep) narrows one run; omitted means every member. The saved order and
  group policy are unchanged; the App keeps the selection as a local preference.
- **Addressing.** An @ is refused (`group_discussion_active`) while this
  conversation has an active run. In roundtable/independent groups, two or more
  mentions require a started run (`group_discussion_start_required`); exactly
  one mention outside a run is a directed reply, and a guarded send may name
  `sequential`/`independent` for it. Ordinary group chat, parallel replies and
  the default mode of new groups are unchanged.
- **Independent first round.** Retry reruns every unacknowledged first-round
  failure at once (never a completed answer), within the 48-turn limit. With no
  successful first-round answer Continue is unavailable
  (`group_discussion_resume_unavailable`); Retry or End remain.
- **Speaking prompt.** A speaker with nothing new may answer in one or two
  sentences with its position instead of restating others.

CLI: `groups start --participants A,B --supersedes RUN`, `groups note --then
resume|retry --revision REV` and `--if-running`; on a recovery Host `pause`/`end`
may omit `--revision`. Regressions: `hub-group-discussion-recovery` (owner path,
supersede, add-and-continue, note delivery/visibility, speakers, addressing and
first-round recovery, including retries that receive corrections), updated `hub-group-discussion`, `hub-group-reply-guard`
and `host-cli-group-discussion`. No schema migration; no installed Host was
updated.

## Validation and review

Validation is performed against isolated temporary Host state and scripted
engine output, never the owner's existing conversations or production Bots.
The final PR records the exact tested revision and separate evidence for Codex
self-tests and Opus review. Browser tests are not physical-phone, native Windows
or installed macOS acceptance. GitHub Actions billing restrictions do not count
as a passing CI run.

### Codex self-tests

- **Final stable-tree full regression: 369 test files passed; 5,170 tests passed,
  5 skipped (5,175 total), exit 0.** Run on 2026-10-20 at 18:29–18:39 CST,
  using portable Node 24.14.0, `vitest run --maxWorkers=2 --testTimeout=30000`,
  after building the Host in the isolated verification checkout. Source, tests
  and package metadata were byte-compared with the PR checkout. No code changed
  during this final run; only the delivery docs were finalized afterward.

- New feature tests: **41 passed** (Hub 26, Gateway 12, CLI 3), including
  original failed-Stop/pause/cache reproducers promoted into regressions.
- Adjacent regressions: **258 passed**, covering shared queue, group settings,
  Gateway, Agent Bus, async questions, steering, run scopes and state backup.
- Chromium: **14/14 feature journeys passed** after the control preflight fix.
  These use real isolated Hub/Gateway/Core code with scripted engines and actual
  browser mouse/keyboard/touch interactions. They cover @ routing, order,
  independent first round, pause/end/retry, lost responses, drafts/attachments,
  conditional reads, long reply details, ownership, older host and ADHD layout.
- Root build, client build and translation-key/placeholder validation passed.
- Full default-parallel regression attempt: **5,106 passed, 58 failed, 5 skipped**.
  The 36 `host-cli-update` failures also reproduce on pristine base `d6aabc5`
  with Homebrew Node (runtime freezing rejects its mutable dylib dependencies).
  All other affected files passed when rerun separately; their failures in the
  full attempt were timeout/process timing under load. These are diagnostic
  attempts, superseded by the complete stable-tree result above.
- Baseline WebKit cannot create even an empty page in this environment; both
  headless and headed probes time out before loading the App. No feature
  WebKit pass, native App pass or physical phone pass is claimed.

- Existing browser regressions: **13 passed across runs**. The combined run's
  long-press cancellation/tap case timed out under load; its unchanged isolated
  rerun passed. The earlier pause failure was a real stale-control revision
  issue; controls now read the same run before one mutation, never automatically
  replaying the mutation. All 14 feature journeys then passed together.
- Portable Node rerun: **44/44 Host update tests passed**. The first portable
  rerun exposed four stale schema-19 fixture failures hidden by Homebrew's
  earlier rejection. Fixtures now represent schema 20, while explicit older
  schema tests remain. Rollback to both schema 17 and schema 19 is rejected.
- Gitleaks scanning of staged changes found no secrets. This is a change scan,
  not a new whole-history privacy audit.

Two intermediate portable attempts are not counted as successful full runs:
5,168 passed / 2 failed / 5 skipped while the source was still changing; then
5,157 passed / 13 failed / 5 skipped in a frozen checkout missing its compiled
`dist` entrypoints. After building that checkout, the final unchanged run above
passed. These were verification setup mistakes, not silently excluded tests.
GitHub's existing source checks were also read back: jobs did not start because
of account payment/spending-limit restrictions. CI is not counted as passed.

### Opus 5.5 xhigh review findings and handling

The initial independent review required: real completion rather than ACK-only
advancement; startup/deletion reconciliation; explicit start with settings CAS;
real group sessions so approvals and files remain reachable; first-round peer
read protection; a queue-only path separate from Agent Bus; and durable,
bounded state plus worker/schema capability checks. These requirements are
included in the implementation and verified by integration tests.

Actual Claude Code `claude-opus-5-5`, effort `xhigh`, performed the plan review,
backend collaboration, an independent review and a final independent review.
The final reviewer used a separate build and private reproducers; only the
engine output was scripted. Its final conclusion was that the draft PR can be
opened, with the boundaries below, not that native release acceptance is done.

| Finding | Disposition and evidence |
| --- | --- |
| H1: a later file-repair call could overwrite the turn's stance | Fixed: only primary output is reported, and the Hub accepts the first report. Independently reproduced and retested. |
| H2: ordinary resend could run a scheduler input outside its tracked turn | Fixed: persisted Hub-owned markers gate desktop and phone resend, including failed child replies and reload. |
| M1: deleting a future participant could stall a run | Fixed: unavailable participants retire and the scheduler reconciles the remaining turns. |
| M2/M3: no consensus evidence and unclear supplemental-note behavior | Fixed: proposal/positions are visible; notes are disclosed, excluded from the blind round and placed outside peer-reference text. |
| M4: repeated large status reads | Fixed: run-ID/revision/settings token, 600-character previews and per-step expansion. A same-revision/new-run cache regression is covered. |
| M5: overly strict structured positions | Extra keys and long summaries are tolerated; malformed/trailing blocks still fail closed. Real-model adherence remains unverified. |
| M6: localization | Client controls, scheduler chips and outcome views localized. Stored sidebar previews and legacy CLI conclusion strings remain Chinese. |
| L1/L6: Stop retry and dispatch/start confusion | Failed/unconfirmed exact-input Stop is re-armed; queued and active are separate. End cancels the exact Core-queued input without aborting earlier work. |
| L2: a new member could read a sealed first-round answer | Fixed for messages and attachments for every non-author Bot. The old leak-observation assertion now receives `group_discussion_sealed`; that expected rejection is not counted as a passing leak assertion. |
| L3/L4/L5: keyboard focus, status announcements, phone cue | Focus follows reordered member; status has live-region text; phone shows that unmentioned text is transcript only. Screen-reader hardware was not tested. |
| L7/L8/L9: stance blocks, owner steering, retained context | Explicit limits below. Receipt pruning added; no claim of a global storage quota. |
| L10/L11/L12: missing-resource copy, generated cache, topic files | Resource errors distinguished, generated Python cache excluded, topic file picker/drafts added through existing upload. |
| N1: End appears stuck behind unrelated Core work | Exact cancellation independently verified; explanatory waiting copy added and separately rechecked. Immediate cancellation acknowledgement is deferred to avoid changing shared queue settlement semantics. |
| N2/N3/N4/N6/N7 | Explicit remaining limits below; no claim these edges were repaired. |

Independent evidence: **41/41** focused repository tests; **5/5** additional
Chromium user journeys on a fresh client build, plus targeted real-Hub/Gateway/
Core reproducers for exact queued cancellation, stop during preparation and
sealed quoting. Phone widths 390 and 320 pixels had no horizontal overflow.
The journeys exercised keyboard reorder, desktop/phone settings, topic links,
notes, pause/resume, failure/skip/end and resend gating. The reviewer did not
independently repeat the topic-attachment journey (covered by Codex's test).
After the final waiting-copy change, Opus reran the exact queued-End journey
(**1/1 passed**) against the rebuilt client, checking the new explanation at
1360, 390 and 320 pixels. This follow-up resized a desktop browser; it was not
a new physical-phone or touch-device test.

There is no unresolved implementation-vs-reviewer disagreement to decide for
this draft. The reviewer suggested earlier cancellation settlement and context
compaction; this PR uses explanatory UI and documented retention instead. Those
suggestions are deferred, not represented as implemented.

## Remaining limits and merge gates

- **Native/WebKit/live models:** complete WebKit, native desktop, physical-phone
  and real-engine discussion acceptance before a release claim. Scripted
  consensus tests do not measure whether every model emits the stance protocol.
- **Post-turn engine questions (N6):** engine-native follow-ups after the origin
  turn has ended can run as ordinary turns, without updating its already stored
  stance. This is a code-review risk, not an independently reproduced exploit.
  Do not rely on such a follow-up to change the discussion's result; use an
  explicit new discussion. Hardening this path and live-model verification are
  merge-review items.
- **Sealed quote UX (N2):** explicitly quoting a still-sealed peer answer while
  addressing another Bot is rejected and invokes no engine. Its existing
  delivery error is generic and may suggest retry too early. Wait for reveal;
  this is not a credentials or connectivity failure. Dedicated copy/admission
  handling is deferred; the read/attachment protection remains enforced.
- **Preparation Stop window (N3):** if Stop arrives before Core creates a run it
  is re-armed and retried on the next publication. The real bridge checks an
  aborted signal before spawning. The tested preparation race was stopped;
  there is no claim of eliminating every pre-publication timing window or of
  verifying worker reattach during End.
- **Control races (N7):** a state change between the read-before-control and its
  POST can still return a conflict. Refresh and click again; a mutation is never
  silently retried or shown successful without server acknowledgement.
- **Model text (M5/L7):** the [October 23 output repair](group-stance-visibility-2026-10-23.md)
  separates internal position data from presentation before streamed events enter
  Core. Malformed or incomplete control blocks are hidden without counting as
  consensus. Ordinary chats remain unchanged, so a later ordinary model turn may
  still remember the earlier instruction. Existing stored replies are not migrated;
  no production reliability percentage is claimed.
- **Presentation (M6/N4):** stored scheduler text in sidebar previews and legacy
  CLI conclusions can remain Chinese even in an English client.
- **Retention (L9):** frozen per-turn context is retained after completion. At
  the configured maxima a run may retain roughly 15 MB of CJK JSON context plus
  reports. Long-term compaction and a global retention policy are separate work.
- **Owner intervention (L8):** explicit user steering and copying/forwarding are
  not a security sandbox. Automated scheduler inputs themselves cannot become
  approval/question answers or steering requests.

This is a draft PR, not a release. No production Host, App installation, user
conversation or existing Agent Bus definition was changed during validation.

## Integration follow-up (2026-10-21)

The PR has been integrated with the other pending changes. Current results and
remaining physical-device boundaries are recorded separately in
[integration verification](integration-release-2026-10-21.md). Earlier draft
and disk-permission notes describe the original PR handoff.
