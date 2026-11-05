# Mobile conversations by Bot

The mobile Bot directory used to open only a Bot's most recent direct chat.
Users with several conversations had to find older chats in the mixed inbox.

## Behavior

- Tap a Bot's avatar/name to view its conversations in Messages. The directory
  shows the count and keeps a separate New chat button.
- The mixed Messages inbox has no separate Bot selector row. Scoped lists
  show the Bot name and a Back button in the existing titlebar, plus the host
  name when multiple hosts are paired. Identity uses both host ID and Bot ID,
  never the display name or Bot ID alone.
- The selected scope includes live direct conversations and groups containing
  that Bot. Group topics remain inside their group; archived conversations stay
  in the existing Archives view and are explicitly excluded from the count.
- Existing ordering (pins, then recent activity), unread/attention/group filters
  and title/Bot/topic-name search still apply. A scoped search does not offer
  the host-wide history search action or unrelated Bot suggestions.
- Search, scope, filter and scroll survive opening a chat on another host and
  returning. The Bot directory's search is independent from conversation search.
  Changing tabs remounts the search field to release focus from the prior page.
- The selected Bot's Plus and empty-state actions preselect that Bot when
  creating a conversation. Unavailable Bots cannot be targeted by the empty
  state's create action; the titlebar Back button can always clear a stale scope.
- Use the titlebar Back button or Android Back to return to all Bots. Back first
  closes existing overlays/chat surfaces; it only clears scope on the inbox.

This is a client-only projection of existing synchronized conversation data,
with no new dependency, network endpoint or server-side index. Navigation state
is kept for the current App session, not persisted across a full reload.

## Follow-up: reachable from the chat in 0.1.397-test.1

The route is the bottom Bot tab → the Bot row. To make this discoverable while
reading a renamed conversation,
phone chats now also offer “查看此 Bot 的全部对话” in the ellipsis sheet and in
conversation details. The Bot name beside the title is a shortcut as well.
Group details use the explicitly selected member. These paths reuse the same
host-scoped inbox, clear previous search/unread filters, and retain conversation
drafts. Cached lists remain browsable offline. The fallback single-workspace
App also owns its inbox state so these shortcuts do not require HostApp.

Browser regression covers all three chat entries, matching rows, exclusion of
other Bots, draft preservation and offline navigation. Existing same-ID
multi-host tests still pass. The packaged Android emulator journey covers the
ellipsis shortcut and scoped list along with native safe-area/keyboard checks.
The user's physical phone remains an acceptance boundary.

## Original validation

- Client translations, TypeScript and Vite production build passed.
- Standalone build and full suite passed: 213 test files, 2,823 tests passed and
  1 skipped. An initial full run failed the existing Kimi background completion
  test; that test passed in isolation and the subsequent full run passed.
- `mobile-im.spec.ts` and `mobile-attention.spec.ts`: 9 Chromium and 9 WebKit
  journeys passed. Coverage includes scope + search + filters, empty Bot and
  preselected creation, archive/topic exclusion, same-ID Bots on two hosts,
  scroll restoration after host switches, drafts, unread and native Back.
- Inspected 390px scoped-list and 320px empty-state browser screenshots; checked
  narrow-screen overflow, and retained the existing English/desktop checks.
- These are browser checks against temporary real Hub servers. No updated
  Android/iOS package has been installed or physically tested for this change.

## Follow-up: compact inbox in 0.1.398-test.1

The always-visible “全部 Bot” selector consumed a full row on the phone inbox.
It is removed. Bot-directory and chat shortcuts remain, and the scoped list now
uses its existing titlebar for “Bot name 的对话” and a Back action. Multiple-host
lists show the host name there; stale scopes can still be cleared. The mixed
inbox has only its title, search and four status filters above conversations.

Validation for this follow-up:

- 11 Chromium and 11 WebKit journeys passed (`mobile-im`, `mobile-attention`,
  `safe-area`). Existing scope/search/filter, empty Bot creation, same-ID host
  isolation, scroll restoration, offline browsing, drafts and Back checks remain.
- Inspected the 390px inbox and scoped-list screenshots and the 320px empty
  state. No Bot selector remains in either layout.
- Clean client install, translations, TypeScript and production build passed.
  Standalone build and full suite: 219 files, 2,851 passed and one skipped.
  Both independently installed package forms started their isolated Hub and
  served the client without the legacy SDK in the production dependency tree.
- Android release build, JVM regression task and release lint succeeded. The
  signed APK contains all 399 current public assets, the new compact header,
  native inset configuration and all 15 selected mascot icon variants. Its
  certificate matches 0.1.397-test.1; version code is 2026101213.
- APK SHA-256: `860da30dc5b336620b53028daa7f119f46a3a55a22d7a81d4d5f1303bdc28d90`.
  This follow-up has not been installed on the user's physical phone. The
  native journey selector was updated, but instrumentation was not rerun;
  the 0.1.397 native-inset results above are historical evidence.

## Follow-up: search entry in 0.1.399-test.1

Search now opens from the titlebar magnifying glass instead of occupying a
permanent row. Bot and conversation lists have no horizontal separators. Android
Back closes an expanded search before clearing the Bot scope. See
[behavior and validation](mobile-inbox-voice-2026-10-12.md).
