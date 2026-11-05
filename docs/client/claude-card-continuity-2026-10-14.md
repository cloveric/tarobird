# Claude Code dialogue and card continuity

## Problem and behavior

A background task can report after its original turn has ended, including while
a newer question is being answered. Previously it looked like another answer
to the new question. A missing status was also labelled completed. Child-agent
messages ran together, and their final tool result replaced all earlier progress.

The App now keeps a background report on one white card with a compact source
strip: original request excerpt, timestamp and navigation within the same
conversation. Recovered reports without a known owner explicitly say they are
separate notifications, have no link to the new prompt, and do not refresh the
new turn's progress timestamp. A missing status means an update, not completion.
Reports remain immediately visible; they are not held in an in-memory queue
behind an arbitrarily long foreground task. Delivery retains its existing
ledger and fallback paths.

Claude `Agent` and `Task` steps display their explicit assignment description.
Public child messages have paragraph boundaries and readable Markdown/code.
Their progress is retained separately from the final result; raw parameters
and output remain available. Child session IDs, tools, approvals and private
reasoning still cannot become parent messages or gain parent capabilities.

Claude public thinking blocks retain real block boundaries without adding
breaks inside token fragments. Ordinary streamed narration is labelled
“正在输出文字” rather than implying a final answer. A completed reply with known
background work shows “本轮已回复” and a historical note about the missing terminal
receipts **at the time that reply ended**. This note is not a claim that the
tasks are still running now. Later results are separate attributed reports.
Earlier narration remains available in the ordered process journal.

Claude process exit produces an interrupted-task report. Host-authored empty
result/exit explanations are localized; authored CLI text is preserved.

## Correctness and compatibility

- Persistent CLI callbacks are explicitly bound to the Gateway rendering
  profile. A retained callback invoked outside its original async dispatch
  previously fell back to Feishu formatting, losing App metadata and headings.
- `EngineStreamEvent.origin` is derived from an actual original callback and
  turn identity, not from task text or the most recent request. Diagnostic
  timelines record provenance and fallback reason without extra prompt text.
- `card.extra.backgroundTask` is additive v1 metadata. Its reader tolerates
  future extra fields. Original message navigation uses `Message.replyTo`,
  checks the same conversation and cached existence, and never accepts a
  foreign conversation target from the metadata.
- Missing/unloaded original messages use neutral wording. Forwarding strips
  live background metadata and keeps a readable snapshot.
- `runs.v1` strict schemas and Hub schema version are unchanged. Child progress
  uses existing `RunEntry.text`; its final output uses `output`. Background
  start/end receipts use the existing narrative kind, do not count as tools,
  and do not settle a foreground turn. Existing capture limits still apply.
- Older clients retain understandable Markdown fallback. Feishu topic routing
  keeps its thread anchor; only App reports drop an unverified `replyTo`.
- App choice and attachment continuations use the same notification card
  renderer. Oversize/file-only delivery retains established fallback handling.
- No migration, session reset, network membership or permission change.
- **CLI impact:** the headless host and bundled desktop host share the adapter,
  run journal, Gateway and notification logic. No separate CLI command is needed
  for this presentation change. A later release must update both host artifacts
  per the repository release checklist.

## Review and verification

Two independent review calls use the installed Claude CLI with
`--model claude-opus-5-5 --effort xhigh`, no session persistence, no MCP servers
and no access to production chat data. The first review is source-based; the
second checks the candidate diff. Model review is not runtime validation.
The second review's profile-consistency concern is covered by explicit channel
profiles and a retained choice callback invoked inside a foreign async context.
Forwarded snapshots also drop the source strip; deleted and merely unloaded
requests use distinct wording. A terminal marker without a reported status is
not upgraded to completed when the worker closes.

Regression coverage includes:

- Claude native-frame replay: child fences, partial-text deduplication,
  explicit thinking/message boundaries, original task callback ownership,
  unattributed recovery, interruption and active-turn settlement.
- Real isolated Gateway/Hub storage: old and new requests interleave, recovered
  reports omit the new request, late callbacks preserve App headings, forwarding
  removes live metadata, and choice continuations retain the same report card.
- Chromium and WebKit desktop/phone journeys: child Markdown, source navigation,
  a concurrent current reply, unknown provenance, retained drafts and safe-area
  headers. Screenshots are produced by `claude-card-continuity.spec.ts`.
- Five-engine desktop/phone run matrix; existing Markdown, code copy, theme,
  detail-pane, disconnect, stop and layout checks.
- Optional legacy notification regressions, including retained topic routing.

Local results: 649 tests across 18 primary suites; 15 targeted optional-channel
tests; 17 Chromium and 2 WebKit browser cases passed. After final review changes,
the 7 affected primary suites (145 tests) and both builds passed again. The
standalone build contains 328 modules and excludes legacy transport/Feishu SDK.

These use native-frame replay and a stub engine driving the real isolated
Gateway/Hub/browser flow. They do not constitute a new installed macOS build,
a physical Android/iPhone test, or a production CLI round trip. No production
processes were restarted and no installer was released as part of this change.

## Completeness check (2026-10-15)

The main foreground turn maps public thinking/text deltas, tool starts/results,
questions and terminal results to the shared run presentation. Completed native
blocks do not duplicate already-streamed text; actual thinking block boundaries
remain intact. This is not a claim that every Claude activity has a full journal:

- Forwarded child `assistant` text becomes progress on the matching parent
  `Agent`/`Task` step. Child partials, thinking, internal tool events and session
  identity are not imported as a nested timeline. Final parent tool output is
  kept separately from the child progress.
- Background review turns use the attributed notification path. Their
  thinking/tool/text events can update answer-progress feedback, but do not
  receive a complete foreground-style run journal. Their final report remains
  separate from a concurrent user turn.
- Run capture has the documented entry/byte/text caps and retention period in
  [native run presentation](native-run-presentation-2026-10-13.md). Missing,
  unreported or truncated evidence cannot be described as a complete transcript.

These are current presentation boundaries, not proof that a model task failed.
Source verification and browser replay must remain distinct from an installed
App/host upgrade and a real Claude/mobile round trip.
