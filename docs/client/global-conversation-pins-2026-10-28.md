# Two levels of conversation pinning — 2026-10-28

The owner requested that the existing conversation pin be named **分组置顶**
(Pin in section) and that a separate **全局置顶** (Pin to top) extract a
conversation into one **置顶** (Pinned) section before all ordinary groups.
Unpinning must restore its original grouping without moving its membership.

## Behavior and ownership

- Existing `pins` now rank conversations within their current container: a
  folder in the inbox, a Bot's conversation list, the memberless conversation
  section, the group section, or a group's topics. Bot layout no longer extracts
  these rows into a second top section. Existing flags are retained without
  migration. Folder pinning (`置顶分组`) remains a separate operation.
- New `globalPins` live in the same per-host, per-device client settings store.
  Setting a single pin uses an atomic read/modify/write transaction; it never
  replaces another row's pin. Old caches default to no global pins.
- The two pin states are independent. Global pin/unpin does not change an
  existing group pin, folder assignment, conversation ID, session, history,
  draft or selection. Moving a globally pinned conversation into another
  folder still changes its real folder; unpin later reveals that current folder.
- One global section precedes folder, Bot, host and Agent Bus directory
  sections, in both combined and host-grouped layouts. Rows retain their
  owning connection and source badges; matching IDs on two hosts stay distinct.
- Search, scope, unread/attention filters, disconnected-Bot visibility and
  archive/parent validity apply before display. Pinning cannot restore access
  to a hidden/archived conversation or override a filter.
- A globally pinned topic is independently reachable. Its unread/attention and
  preview are excluded from the ordinary parent row to avoid counting twice.
  Unpin restores the topic projection under its parent, including its activity.
  Parent/group membership is never rewritten.
- Global rows use existing activity ordering with a deterministic host-scoped
  tie break. Group pin state does not rank globally pinned rows.
- A collapsed folder or Bot remains collapsed after unpinning; keyboard focus
  returns to its heading. Pinning also preserves other chats' drafts and the
  currently selected conversation. Pin-list refreshes can be asynchronous, so
  focus restoration follows accepted directory data rather than a fixed frame
  delay. If the user moves focus to another conversation or control while a
  refresh is pending, that deliberate move wins.
- Phone search keeps matching Bots first, then conversations (globally pinned
  results before ordinary results). Host headings without ordinary rows or
  custom folders are hidden; global rows retain their host badge.
- The shared desktop directory also serves ADHD. Its pane membership, folded
  topic preference and conversation drafts remain separate from list pinning.

## Compatibility and CLI

This is an App presentation preference, matching the existing device-local
conversation pins. It is not a new shared Host capability or a cross-device
sync feature. No Hub schema, protocol or headless CLI command changes are
needed. The CLI's shared folder pinning remains unchanged. Source completion
does not update installed desktop or phone packages.

## Validation

Independent review used `claude-opus-5-5[1m]`, with separate ownership of the new
projection tests and six end-to-end journeys. Review findings fixed before
completion included row focus after extraction, topic actions and parent labels,
English wording, empty host headings, and genuinely group-local behavior in Bot
view. No Host data or installed App state was changed during verification.

Evidence is retained under
`/Volumes/gdrive/taro-tmp/global-pins-20261028/`.

| Check | Evidence and outcome |
| --- | --- |
| Projection and directory sharing | 11/11 Vitest cases: independent states, deterministic cross-host ordering, stale/archived/orphan flags, parent/topic aggregates and global-only directory updates |
| New Chromium journeys | Opus ran all six successfully; the added Bot-view group-pin round trip also passed its focused rerun. On final r5, the complete slow-focus and English journeys passed again (2/2) |
| New WebKit journeys | Final r5 run passed 6/6, including host/folder layouts, topics/ADHD, user focus changes, English narrow menus and real IndexedDB |
| Existing regressions | Initial 28-case run passed 27; one stale reduced-motion expectation was updated to the existing always-on policy. Focused reruns covered Bot folds, independent host actions, phone actions, group settings, ADHD topics, and memberless cached chats. Final r5 pin/action run passed 4/4 |
| Directory refresh race | Injected 250 ms readonly IndexedDB delay exposed the initial lost-focus bug. The data-aware fix passed Chromium and WebKit, including unpin into a collapsed folder |
| Builds | Client TypeScript/Vite build passed; Host standalone build passed (459 modules). The existing Capacitor keyboard static/dynamic import warning is nonblocking |
| Visual review | Desktop combined/grouped/Bot lists, phone list and action sheet, topic/ADHD lists, 800 px English desktop menu and 320 px English phone sheet inspected |

One focused Bot regression timed out during pairing before reaching any pin
operation under concurrent test runs; its subsequent rerun passed. This is
recorded separately from feature assertions, without changing pairing or route
validation. Earlier unsuccessful runs remain in the evidence directory.
The earlier WebKit English failure was a test assertion expecting the superseded
`folder` translation; the corrected `section` wording passed before the final
full run as well.

A final 800 ms refresh probe also reproduced focus being stolen from another
row after a deliberate user move. Restoration now cancels unless focus remains
on the original trigger (or fell back to the document body after unmount).
The region's accessible name describes the pinned state rather than the pin
action. Opus's final review accepted these changes; Chromium's two focused
journeys and WebKit's complete six journeys passed on the frozen r5 build
(`index-C9OUp12m.js`). The source, screenshots and logs are tied together in
`verification.json` in the evidence directory.

Browser checks do not establish native iPhone/Android touch, VoiceOver/TalkBack,
or physical-device acceptance. This change is source-only until a later release
is packaged and installed. It does not introduce cross-device preference sync.
