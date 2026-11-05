# Dock badge excludes archived unread history

The installed Mac App (1.0.117) showed a Dock badge of 53 after the visible inbox
had no unread messages. A read-only native-window check showed `(53) TaroBot`
and no visible conversation unread labels. The earlier window sample was 55 with
2 current unread messages: the same extra 53 remained after those were read.

A read-only SQLite transaction on the App's WebKit IndexedDB cache confirmed:

| Scope | Conversations with unread | Unread messages |
| --- | ---: | ---: |
| Live inbox | 0 | 0 |
| Archived conversations | 14 | 53 |
| Topics under archived parents | 0 | 0 |
| Orphaned/missing conversations | 0 | 0 |

The activity cache intentionally retains archived history. `HostApp.tsx` and the
standalone `Workspace` badge path summed every cached activity entry, whereas
`buildConversationRows` excludes archived roots/topics. The native badge bridge
was displaying the application's incorrect total; resetting Dock state or
marking archived history read would mask the cause.

`conversationUnreadTotal` now counts only canonical unarchived conversations and
topics with a live root. Unknown activity entries are excluded. Search, folder
folding and offline Bot presentation do not change the application-wide total.
The existing host registration and private-network visibility guards remain in
`HostApp`. Both entry points share this calculation; the standalone effect also
reacts to conversation metadata changes, so archive/restore does not need a new
message to update its badge. No read receipts, conversation history, model
sessions or archive state are modified by counting. Restoring a conversation
reveals its retained unread count again.

CLI impact: presentation only. There are no changes to Host state, APIs, schema,
CLI commands or message delivery. The same count feeds the page title, macOS
Dock badge and native tray description. The installed App remains unchanged;
source/browser verification is not installed-native acceptance.

Evidence is under `/Volumes/gdrive/taro-tmp/dock-unread-20261028`.
`read-cache-counts.py` opens the production cache with `mode=ro` and
`PRAGMA query_only=ON`, reads only conversation/activity records, and writes only
aggregate counts. It fully consumes supported WebKit v15 serialized records and
rejects unknown tags; no decoded text or identifiers are saved. The format was
checked against WebKit's [StructuredCloneTags.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/StructuredCloneTags.h)
and [CloneDeserializerBase.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/CloneDeserializerBase.h).

The browser regression uses an isolated real Host, creates 53 unread messages
across a direct conversation, a group and its topic, plus one live unread
message. It archives through the public client protocol and waits for the rows
to disappear. Against the original code it fails with `(54) TaroBot` where
`(1) TaroBot` is expected (`baseline-final.log`), reproducing the extra 53.

The candidate checks page title and the count passed to `updateBadge`, reading
the remaining live message, restoring archived unread history, archiving again,
and reloading. Bridge interception in a browser is not a real macOS Dock update.

Validation on 2026-10-28:

| Check | Result |
| --- | --- |
| `tests/client-conversation-unread.test.ts` | 3 passed; archived state preservation, topic visibility, missing activity and message-ID counts |
| Chromium `unread-badge` + `directory-performance` | 3 passed |
| WebKit `unread-badge` + `directory-performance` | 3 passed |
| Client `npm run build` | Passed translation checks, TypeScript and Vite build |
| Root `npm run build` | Passed; standalone graph 458 modules |
| `git diff --check` | Passed |

Both browsers cover the full `54 → 1 → 0 → 53 → 0` lifecycle and zero after
reload. The existing 202-conversation streaming/reconnect checks pass at desktop
and phone widths, including retry after an initial native-bridge failure and no
redundant badge/title updates during background streaming. Browser tests use
isolated state and do not send real model requests. The installed App, production
cache and host service were not changed or restarted by this fix.
