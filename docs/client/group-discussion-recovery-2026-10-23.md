# Group discussion recovery and speaker selection

The owner reported a stopped typo correction receiving no reply, missing `@`
completion and speaker selection, and an ambiguous Continue action after several
new messages. The original UI -> Hub -> Gateway integration reproduced both
Stop leaving the run paused and `@` showing no suggestions. Independent Opus
5.5 review also reproduced seven scheduler/contract problems before edits.

## Interaction contract

- The main composer's Stop ends the exact discussion the user saw. It withdraws
  undispatched discussion inputs and requests cancellation of dispatched ones;
  a new topic waits for terminal evidence. Per-message Stop keeps its existing
  single-turn meaning. A composer in another topic stops only that topic's
  reply; the explicitly labelled discussion bar controls its displayed run.
  Ordinary/direct conversation Stop is unchanged.
- Pause waits for the current speaker. The original topic remains visible, with
  separate Continue, Retry unfinished speakers, and Skip and continue actions.
  A failed turn is never silently described as a normal continuation.
- While paused, the composer offers Add and continue/retry or Start a new topic.
  The former stores the note and applies the control atomically. The latter ends
  that paused run and starts the new topic in the same transaction. Conflicts
  preserve the draft; a lost receipt replays the exact original operation.
- During running discussion, new human messages are additions to subsequent
  turns. They do not interrupt current workers or launch a parallel broadcast.
  A pause/end racing a send cannot silently strand the addition.
- Allowed speakers are separate from ordinary group recipients. The default is
  all members, with a device-local preference per host/conversation. Explicit
  Select all retains the dynamic all-members choice when new members join. Selecting
  participants grants participation, not a requirement to reply to every human
  message or repeat an existing position. The scheduled order is still the
  group's configured order. Once started, a run's participants are fixed.
- `@` completion is available in discussion mode. Outside an active run, one
  named/selected Bot receives an ordinary directed reply; two or more start an
  ordered discussion. Within a run, mentions remain note text and cannot
  bypass the scheduler. Group modes and ordinary/parallel defaults are retained.
- The topic, latest addition, addition count and additions not incorporated in
  a turn are visible. A late addition is not claimed as answered just because
  the final speaker has finished. Bounded context overflow is disclosed and
  retained for a subsequent turn instead of silently taking only the last ten.

## Shared API and CLI

`groups.discussion.recovery.v1` advertises the additive contract. New fields are
omitted on older hosts; unsupported operations retain drafts with an upgrade
explanation. Worker dispatch schemas are unchanged: internal note tracking is
stripped before dispatch.

- Start: `participants?: string[]`, preserving `botOrder`; optional
  `supersedes: { runId }` for a paused run. CLI: `groups start --participants
  alpha,beta --supersedes RUN`, using the settings revision as before.
- Note: `then: resume | retry` with the run revision for an atomic combined
  action, or `ifRunning: true` to reject a send that raced a pause. CLI:
  `groups note --then retry --revision REV`, or `--if-running`.
- Pause/end target an exact run and tolerate revision churn that cannot redirect
  them to another run. Resume/retry retain revision checks. On capable hosts,
  CLI pause/end can omit revision and perform one status read.
- The Hub rejects ordinary multi-Bot fan-out in automatic discussion modes and
  human mentions that would run alongside the same active discussion. This
  applies to App and CLI, including older unguarded callers.
- Independent first-round retry retries every unresolved failure without
  repeating successful speakers. A first round with no successful answers
  cannot be silently skipped into a discussion with no positions.

## Validation boundary

The automated client journeys use real Hub, durable queues, Gateway and Core;
only model responses are scripted. They validate scheduling, cancellation,
message context, persisted drafts, participant selection and UI behavior.
Browser screenshots cover desktop and phone dimensions. These do not establish
physical-device touch performance or acceptance in the installed application.
No production host restart, application installation or release is part of
this source change.

Independent review uses the owner's CC1 Bot configured as
`claude-opus-5-5[1m]` with `xhigh`; this is a separate implementation/review, not
an alias for a Codex subagent. Local evidence is retained in the external-disk
group-discussion-recovery verification folder.

## Review corrections and checks

The independent client review found and closed four further issues: a composer
Stop affecting another topic, Continue/Retry silently adopting a newer pause
revision, Enter bypassing the transitional-state guard, and Select all freezing
an explicit member list. The opposite-direction backend review also tightened
replacement of a run already ended elsewhere and first-round correction delivery.
Control permission failures now have an explanation, and the paused view names
both retry speakers and the next speaker after skipping.

Recorded checks (overlapping runs, not an aggregate unique-test count):

| Boundary | Result |
| --- | --- |
| Full Chromium discussion journeys | 57 passed |
| Adjacent client settings, offline routing and Stop | 21 passed |
| Final Chromium review cases (2 send races, topic Stop, dynamic all, permissions) | 5 passed |
| Final WebKit recovery journeys, including phone widths | 16 passed |
| Backend discussion, Gateway, policy and CLI | 80 passed across 8 suites |
| Backend queues, recovery, message transport and Agent Bus | 401 passed across 19 suites |
| Client production build and Host standalone build/typecheck | Passed |

The first WebKit run exposed an assertion that checked completion immediately
at worker entry; it now waits for the terminal receipt. The cross-topic fixture
also needed a fresh snapshot after direct store setup (which bypasses the API
route notification). Both corrected journeys pass; these fixture failures are
kept in the local evidence alongside the final passing runs.

Message-scoped Stop, `/stop` and CLI `turn.stop` retain their existing per-Bot
permissions and may pause an affected discussion turn. This change does not
redefine that independent task-control permission boundary.
