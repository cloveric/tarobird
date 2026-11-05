# Reply status on user messages

User messages now carry a quiet icon and short status beside their timestamp.
Queued messages have no reply marker until there is evidence of a foreground run.
This is reply progress, not a sent/read receipt. A spinner means replying, a reply
arrow means replied, and an alert means reply failure. Approval, questions,
stopping, stopped, interruption, incomplete results and disconnected uncertainty
remain distinct. Only active replying animates; reduced-motion users see a static
icon. The existing metadata row keeps bubble height stable across transitions.

The replying label and its spinner use the theme accent. In Monochrome, a
selected accent uses the same readable text mix as the header's replying status,
including light warm grey and sage. This also covers the group status dialog
and ADHD panes. Completed/waiting states keep their muted ink; failure and
incomplete states keep the error colour. This is App-only presentation with no
CLI, Host, reply association, or state-transition change.

The accent follow-up passed the existing three reply-status journeys in both
Chromium and WebKit, plus the client translation/type/production build. Actual
page checks covered all eight Monochrome accent choices at desktop/phone widths
in light/dark mode: label and spinner matched, completed/error ink stayed stable,
and replying text contrast was at least 5.42:1. These are browser checks, not
installed-App or physical-device acceptance.

## Identity and evidence

`client/src/user-reply-status.ts` indexes the complete cached conversation by the
Bot message's explicit `replyTo` and author. It never infers association from
visual adjacency, current queue position, the current group membership, or reply
text. Queue edits/reordering preserve the user message ID. A retry that creates a
new user message has an independent status; it does not rewrite the old failure.

Only valid `card.extra.nativeRun` foreground summaries or explicit error messages
are evidence. Tool failure counts do not make a successful run fail. Ordinary
text, file deliveries, forwarded Bot cards, `scopedRun` and background task
notices cannot finish or fail the foreground prompt. A forwarded *user* message
can still receive its own new run. Steering retains its existing control receipt
and does not pretend to have a separate foreground answer.

For each user/Bot pair, the latest run is selected by start time, with a stable
run-ID tie break; copies of that run use revision, failure state, update time and
message ID. This avoids order-dependent selection of equal-start attempts.
An explicit Hub delivery failure is final for that user/Bot pair, consistent with
`HubStore.publishBotMessage` refusing further publication after `failDelivery`.
A stale run or skewed timestamp cannot override it. Offline activity becomes
unconfirmed, while already-confirmed terminal states remain intact.

Groups show a bounded, priority-ordered annotation and a count of other observed
replies. Clicking it opens the per-Bot state list on both desktop and phone.
Counts refer only to observed replies: they never claim that all original
recipients finished. No hover-only information is required on phones.

## Review decisions

Opus 5.5 at xhigh reviewed the design and independently reviewed the first
implementation. Adopted: reply arrow instead of a read-receipt-like check,
explicit waiting/stopped/unknown states, stable run ordering, small-screen
aggregation, accessible group details and reduced-motion support. The first
320px screenshot exposed truncated status words; the compact group trigger
replaces the overflowing row.

Several review suggestions were checked against actual source rather than
accepted as facts. The current cache/snapshot contains the complete conversation,
`runs.recovery.v1` already settles orphan runs, and a failed delivery cannot later
resume successfully under the same user message. A new host summary/schema or a
"late success overrides delivery failure" rule would therefore be inappropriate
for this change. Old unstructured/command replies without trustworthy run evidence
are left unmarked rather than guessed from their prose.

The regression run also exposed a missing draft-preview notification:
`ClientCache.clearDraftIfMatches` cleared sent text but did not notify subscribers.
It now notifies after the successful transaction only when matching text was
actually cleared, preserving newer drafts from this or another tab.

## CLI and engine scope

This is desktop/mobile presentation over the existing shared host protocol.
There is no new host capability, CLI command, schema, queue or model prompt.
Codex, Claude, Antigravity, Kimi and DeepSeek use their existing native run
summaries. Pairing, network membership and device/host identity are unchanged.

## Verification

- Unit coverage: all run phases, explicit failures, shuffled replies, tied runs,
  multiple Bots, retries, disconnected states, scoped/background exclusion,
  forwarded cards, invalid metadata and user/control-message boundaries.
- Browser coverage: real isolated Hub/cache/publish flow; waiting/running/done/
  failed/unstarted prompts, reload, mixed group replies at 320px, stable row
  height and light/dark default/CLI/pixel layouts.
- Five-engine normalized event matrix exercises shared Hub/App run rendering,
  file-before-finish semantics, completed runs with failed tools and confirmed
  stop on desktop and phone. These are simulated engine events, not live model
  calls or installed native-device acceptance.
- Draft cache regression preserves a newer draft and refreshes after clearing.

Validated locally: 32 focused unit tests; 18 Chromium and 18 WebKit browser
cases; standalone host build and client translation/type/production build.
Screenshots were inspected for phone, narrow group, CLI and pixel presentation.

Source publication does not update installed applications. Native Mac/Android
installation and real-device acceptance remain separate release work.
