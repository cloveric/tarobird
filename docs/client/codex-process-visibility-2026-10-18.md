# Codex process visibility — 2026-10-18

## Evidence and cause

The reported audit spanned an overloaded turn and a successful continuation.
Read-only comparison of the original Codex session and the two Hub messages
found 26 native `SubAgentActivity` receipts, but no corresponding Hub journal
entries. Ordinary work was retained: the Hub had 231 and 56 public journal rows,
including the later test, commit and push operations. This is a confirmed adapter
omission, not evidence that all work was lost.

The installed Codex CLI's generated public `ThreadItem` bindings expose these
as `subAgentActivity` with started/interacted/interrupted/completed kinds, child
identity/path and optional resolved model/effort. The adapter previously ignored
this item type. Its older `collabAgentToolCall` representation was also ignored.

A separate presentation issue compounded the confusion: the legacy collapsed
process text retained only its first 3,000 characters. Long quoted/fallback cards
could show early planning and omit later repairs without explaining the limit.
The modern process reader already uses a separate paginated journal.

## Repair and boundaries

- Validate and capture native child activity receipts only for their owning
  foreground turn or exact live Goal turn. Foreign turns and child threads do
  not feed an unrelated conversation.
- Reuse bounded v1 journal text entries with `subagent_*` names. Receipts preserve
  native IDs, lifecycle kind, label and supplied model/effort. They do not count
  as invented tools, acquire a fabricated duration, or finish the parent turn.
  Duplicate receipts remain one entry. Shared diagnostic timeline metadata
  retains their identity without treating them as background task ownership.
- Preserve public native collaboration tool arguments and returned agent states
  in the existing tool journal; returned report text remains available on demand.
- The App labels lifecycle receipts in Chinese/English and exposes supplied model
  details. Pagination, search and export share the same journal on desktop,
  phone and ADHD panels.
- Long App fallback summaries show recent complete steps and an explicit excerpt
  notice pointing to the original message's run details. Optional transport card
  limits and normal short summaries retain their existing behavior.

Only public native protocol fields are captured. This does not read arbitrary
child sessions, replay tools, inspect hidden reasoning, or invent a child report
when the CLI supplies only a lifecycle receipt. Existing retention/size limits,
authentication and queue behavior remain unchanged. Historical dropped child
events are not retroactively inserted into production messages; old ordinary
journal rows remain available through the process reader.

The shared adapter/timeline also serves headless CLI execution. No new CLI
command, wire schema version or state migration is required. New labels are
presentation only; the same stored public journal powers existing read/export.

## Validation

Four focused regressions failed before the repair: missing collaboration tools,
missing lifecycle events, missing lifecycle labels and a silently truncated old
process summary. Validation after the repair:

- 229 focused tests passed, plus 91 legacy renderer checks.
- The full completion gate passed: host build, 328 test files, 4,390 tests passed
  and one platform-specific test skipped. The client translation/type/build
  checks also passed.
- Chromium and WebKit each passed eight process-reader journeys, including new
  desktop, phone and ADHD cases for pagination, search, export, parent lifecycle
  isolation and layout overflow.
- Read-only offline replay of the 26 original native receipts captured all 26,
  retained one entry per duplicate receipt and left the parent phase unchanged.
  No production messages were modified and no original actions were replayed.

Browser journeys use isolated real Hubs and simulated native events; they do not
claim a deployed Mac App or a new live model session acceptance.

## Opus follow-up: readable reports and latest saved events

An independent, read-only review used actual `claude-opus-5-5` with `xhigh`
effort. Findings were checked against source and focused regressions before
implementation. The follow-up keeps the 3,000-character legacy excerpt budget;
that budget is neither model context nor journal storage. The excerpt now says
that other **retained** steps can be read in the original message, rather than
promising a complete history when capture itself may have reached its limit.

- Native collaboration steps show their action (start, wait, send, resume,
  close) instead of an unexplained `CodexAgent` label. Expanded results display
  each child's status and Markdown report separately, with raw output still
  accessible. Unknown future statuses remain visible; a malformed child does
  not hide valid siblings. Lifecycle details also expose full path and child ID.
- Oversized `agentsStates` results previously lost their JSON structure when
  the generic output limit sliced them. The adapter now serializes valid,
  bounded JSON, accounting for escaped text, metadata and exact identities.
  It shares remaining space among reports, preserves short reports first,
  marks truncation, and retains bounded raw previews for unsupported shapes.
  In-budget native output is unchanged. Oversized capture retains at most 128
  representable child entries; identities are never shortened or invented.
- Public activity receipts are accepted from both `item/started` and
  `item/completed` under the same exact foreground/live-Goal ownership checks.
  Journal identity deduplication handles repeated receipts. This does not imply
  that a child has produced a report when only a lifecycle receipt exists.
- Hosts advertise additive `runs.tail.v1`. `GET /api/messages/:id/run?tail=1`
  returns the latest saved page; `before=<seq>` reads earlier matching entries.
  `after`, `q` and `scopes` retain their existing semantics. Reverse selectors
  cannot be combined with each other or a positive `after`. Each response stays
  ascending and bounded to 40 entries / approximately 512 KiB; optional
  `previous` complements `next`. Membership, personal deletion, retention,
  scoped records and file authorization apply identically in both directions.
- Desktop, phone and ADHD readers offer first/latest navigation only when the
  Hub advertises support. Jumping to latest then anchors the visible first
  sequence, so live updates do not slide the page or take over scrolling.
  Newly saved later events can be reached through next/latest. Search resets
  page position. An older Hub retains ordinary forward pagination.

Storage limits remain 30 days, 2,000 entries and 8 MiB per run, with existing
per-field capture bounds (32,768 characters for text/input, 65,536 for output).
The bounded report serializer honors the output limit, including JSON escapes.
This is not a promise of unlimited or complete child-session history: internal
child tools, grandchildren, or late events not emitted to an owning active turn
remain outside this capture contract. No production history is backfilled.

CLI impact is shared native-adapter capture and the authenticated Hub read API;
no new CLI command, execution permission, schema migration or Agent Bus routing
is introduced. Optional transport deployments are not part of this change.

### Follow-up verification

- Actual Opus 5.5 xhigh performed a second, read-only review of the final change
  and reported no blocking source findings. Model review is not a substitute
  for the execution evidence below.
- Final completion gate: 331 test files passed; 4,411 tests passed, one skipped;
  history secret scan and standalone host build passed (362 modules).
- Client translation checks, TypeScript checks and build passed. Legacy card
  rendering passed all 91 tests.
- Chromium and WebKit each passed eight reader journeys, covering desktop,
  phone and ADHD, latest/earlier/forward navigation, retained scroll position
  during live updates, child reports, search, export and close/focus behavior.
  Browser testing found and fixed WebKit's oversized `scrollTop` behavior;
  explicit latest jumps now clamp to actual content height.
- An earlier full pass had one intermittent late-Claude-receipt assertion
  failure. Its whole file then passed (23 tests), the affected scenario passed
  20 isolated repetitions, and the final full gate passed. This follow-up does
  not claim to have diagnosed or repaired that intermittent failure.

These are source/build and isolated-Hub browser checks. They do not certify a
new installed native App, a release, or a production-session history backfill.
