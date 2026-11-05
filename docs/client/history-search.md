# Paged history search

The old search panel stopped at the newest 100 matches and downloaded complete
message blocks. The current panel reads 50 short excerpts per page and supports
previous/next navigation to older matches. Clicking a result opens the original
message through existing conversation navigation. Message storage and full-text
matching remain unchanged.

`GET /api/search/page` is additive; `/api/search` retains the earlier complete
message response for older clients. The new client needs an updated Hub for
paging and reports a missing endpoint rather than inventing more results.

## Consistency and access

- Descending creation time plus message ID defines a stable tie-breaker. A
  position cursor avoids offset shifts when newer messages arrive or previously
  visited hits are deleted. Cursors are scoped to the applied query, filters and
  user; they do not grant access. Each page reapplies current membership and
  device session validation.
- Each request is a fresh read. This is not a frozen multi-page snapshot: edits
  and inserts above an already visited cursor require applying the search again.
  The UI shows the page number and current-page count, not a claimed total.
- Filters are applied explicitly. Editing fields shows an unapplied-change hint;
  paging continues the applied query until the user chooses Apply filters.
  Failed requests keep the current page and cursor for retry. New queries,
  closing the panel, Back and unmounting cancel/supersede older requests.
- Search still supports literal Chinese/Unicode, `%`, `_`, backslashes, Bot/date
  and attachment filters. Only actual message attachments count, not link covers.
  Older full-message callers retain their existing 100-result behavior.

## Bounded responses

SQLite slices excerpts before returning rows to Node. A hit contains only the
message ID, conversation ID, creation time and at most 320 Unicode code points
around the first match, plus optional ellipses. Up to 50 hits are rendered at a
time, and no full answer/tool-output blocks are sent by this endpoint. Key and
excerpt bounds also keep a page below 128 KiB even with JSON escaping; the
cursor is at most 1,024 ASCII characters.

Searches retain the independent WAL reader queue, so they do not hold the
database writer/authentication queue. Short queries and very broad matches may
still scan/sort many candidates. This is not a universal latency guarantee.

## Verification, 2026-10-03

- The initial three pagination regressions failed because the paged method was
  absent. After implementation, **54 focused root tests** passed, covering
  literal equivalence, equal-time ordering, 125-result traversal, concurrent
  insertion/deletion, scoped/invalid cursors, membership removal, bounded long
  excerpts and revocation during both search HTTP routes.
- **9 Chromium and 9 WebKit cases** passed: desktop/phone pagination, previous
  page navigation, page failure/retry, unapplied filter edits, stale-page races,
  navigation to older original messages, ordinary search/filter behavior,
  pairing/revocation, Back and local identity reset.
- Required full gate: **227 files / 3,551 passed / 1 skipped**, root build passed.
  Client translations, TypeScript and Vite build passed.
- Synthetic local benchmark: 30,000 messages of 1,350 characters. The first
  three broad-match pages took 97.7–99.4 ms; the empty-query pages took
  79.3–80.7 ms. Responses were 24,979 bytes per page. An additional 125 replies
  of roughly 45,000 characters produced an 18,697-byte first page in 78.5 ms;
  a concurrent database write completed in 0.7 ms. The legacy 100-full-message
  response was 13,522,127 bytes; the new response contains 50 excerpts, so these
  are different response contracts, not an equal-record throughput comparison.

The benchmark is local synthetic data, not public-route, real-workspace or
native-device acceptance. Reproduce with `npm run build` followed by
`TMPDIR=/tmp/t node scripts/benchmark-hub-search.mjs`.

Evidence receipt（本地材料：`evidence/search-pages-2026-10-03.json`）,
desktop capture（本地材料：`screenshots/search-pages/search-page-desktop.png`）,
phone capture（本地材料：`screenshots/search-pages/search-page-phone.png`）.


## Current-conversation search (desktop, 1.0.51)

The magnifying glass in the conversation header, or Cmd+F / Ctrl+F, opens
search scoped to the selected conversation. Results cover its full stored
history, including messages outside the loaded timeline. Clicking a result
opens and highlights the original message. Escape or the close button returns
to the conversation without discarding the composer draft. Shortcuts do not
intercept an open settings dialog or file preview.

The sidebar search and phone inbox search remain host-wide. The header names
the applied scope. Scoped search keeps keyword/date/attachment filters and
omits the redundant Bot selector. A group’s default discussion and each topic
have distinct conversation IDs, so this search does not include sibling topics
or other conversations with the same Bot.

Both `/api/search` and `/api/search/page` accept an optional validated
`conversationId` in addition to existing filters. SQL intersects this exact ID
with current user membership; every page rechecks access. Scoped cursors bind
to the conversation ID and cannot be reused for another scope. Existing
host-wide cursor hashes remain compatible. No database migration is required.

Hosts predating this filter reject it as `invalid_request`; the client prompts
for a TaroBot host update, with no host-wide fallback. A response containing
an out-of-scope hit is also rejected before rendering. Mac 1.0.51 bundles the
matching 0.1.415 host; remote hosts must be updated independently.
