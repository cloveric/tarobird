# Group position output repair — 2026-10-23

The reported final reply showed a `group_stance` code block containing an
agreement with `proposalId: "P3"` and `proposal: ""`. The prior prompt demonstrated
every possible field, although the strict schema disallowed `proposal` on an
agreement. This rejected the position and left the control JSON visible. A focused
test reproduced both effects before the repair.

## Changes

- The prompt now gives one example per position and says to omit unused fields.
  Parsing tolerates only empty unused string fields. Missing required fields,
  nonempty conflicting proposals, malformed proposal IDs and invalid JSON remain
  invalid; the Hub's consensus validation and frozen proposal checks are unchanged.
- Presentation removes top-level internal position fences independently of their
  validity. Unclosed, duplicated, nonterminal or malformed blocks do not become
  votes. Header variants are hidden but not accepted as positions. Ordinary code
  fences, nested examples and ordinary chats retain their original text.
- A per-call Gateway filter handles both streamed assistant text and result
  events before Core creates cards, fallback answers and run journal entries.
  Normal prose streams immediately; possible fence headers wait for classification.
  Processing is incremental, without repeatedly scanning an ever-growing answer.
  Tool activity and scoped child events keep their existing semantics.
- Position-only answers have readable labels, including agreements with an ID.
  Invalid-only output gets an explicit notice, while its discussion report stays
  empty and carries no position. It cannot fall back to exposing the control JSON.
  This is a `no_reply` turn: the discussion pauses for retry or skipping instead
  of counting a JSON-only malformed response as a readable answer.
- The primary raw engine result is still used for validation; repair calls do not
  replace the speaker's primary discussion report.

## CLI and scope

This is a shared Gateway output change. App and CLI readers receive the same clean
new reply, report and journal data; no new command or capability negotiation is
needed. Host/worker software must be updated for this behavior. Stored historical
messages are not rewritten. Ordinary chats are deliberately unaffected, including
messages explaining this protocol.

## Validation

- Reproduced the screenshot-shaped empty-field failure before editing production
  code. Exercised strict/invalid, duplicate, partial and nested-fence cases, every
  two-chunk token boundary, character-by-character output and large prose.
- Real isolated Hub → queue → Gateway → Core tests inspect streamed/final
  publications, run journals and discussion reports, with scripted model output.
  They cover preserved agreement, rejected conflicting proposals, position-only
  output, engine failure fallback, malformed-only replies and ordinary-chat
  compatibility.
- Chromium and WebKit browser journeys at desktop and phone widths inspect
  streaming and completed replies and verify consensus still completes.
- Final focused Gateway/output and Codex process/Claude stream adapter regression:
  185 tests passed across 4 suites. Earlier scheduler/CLI/card runs passed 94 tests
  across 7 suites, and adjacent renderer/service/workflow runs passed 202 across
  5 suites (these overlap; counts are not a unique total). Final browser journeys
  passed 2 cases per engine.
- Production Host build passed. Repository-wide test-inclusive TypeScript checking
  still reports 128 pre-existing diagnostics; normalized output matches unchanged
  baseline `0a84f94` exactly. This is not a clean all-tests typecheck claim.
- Opus 5.5 (`xhigh` configured; runtime effort not introspectable) independently
  reviewed the original leakage paths and the repair. Its event-ordering finding
  was fixed: adapters that do not await callbacks still dispatch a split event's
  children synchronously in order, before any following tool or text event.

Evidence is in `/Volumes/gdrive/taro-tmp/group-stance-visibility-20261023`.
Browser and scripted-engine checks do not establish physical-device or live-model
acceptance. No App package release, production restart or local activation is
part of this patch.
