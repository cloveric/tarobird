# Workbench files on this device

The new **Settings → Workbench files** page lists saved whiteboards, Markdown
notes and Design documents across accessible paired hosts and conversations.
The Workbench's **All tabs and closed content → Manage all workbench files**
action opens the same page. Desktop and phone share the implementation; the
phone uses the existing full-screen settings navigation.

This is an App-local library. Each document remains owned by its original
`[host public key, user ID, conversation ID]` scope in this device's IndexedDB.
It is not a filesystem browser, cloud drive or synchronization service. Files
on another phone/desktop, chat messages, model sessions and website data are
not deleted here. A removed host's inaccessible cache is not silently reopened.

## Reading and navigation

- Search names, conversations and hosts; filter by type, host or tab state.
- Include open tabs, closed tabs, content without a tab reference, and tab
  references whose content is missing. Archived/removed conversations' local
  documents remain available for cleanup; opening their conversation is disabled.
- Read layouts and content keys, not the full board images, note text or Design
  files. Bound each host listing and explain truncated or unrecognized results.
  Each listing is capped at 1,000 content-bearing scopes and 5,000 rows per
  host, with separate bounded key/layout scans. Empty and browser/chart-only
  layouts do not consume the content-scope allowance. When the layout scan
  budget is exhausted, content-bearing conversations still read their own
  layouts by key, preserving exact open/closed state; only reference-only
  records outside that scan are omitted. A scan cap produces an
  explicit partial-results notice; the UI never claims that every file was
  scanned. No database-version migration or invented size/date metadata is
  introduced.
- Open the exact owning host/conversation and stable document ID. Restore a
  closed tab or orphan reference only after checking scope/content. ADHD uses
  existing panel navigation and preserves other panels and drafts. If the board
  already contains twelve conversations, the target is refused explicitly and
  the pending file-open request is discarded, so it cannot replay later.

## Deletion contract

Select individual rows or the current page (40 rows), up to 200 items per
confirmation. Changing filters clears selection so hidden items are not deleted
by surprise. Confirmation lists names and owning conversations, explains the
local-only irreversible scope, and points to existing editor export actions.

Deletion acquires the existing editor locks without waiting. Busy documents
are retained and reported individually; unrelated items may succeed. Content,
open/closed tab references and split visibility retire together in one
transaction per conversation. A layout record is retained for native browser
cleanup. Cache reset fencing, revision checks and cross-window invalidation
prevent stale controllers from restoring deleted content. The App never
silently closes another editor to force deletion. Design frames acquire their
shared editor lock before loading editable content, refresh the document under
that lock and retain it through saving and teardown. An environment without Web
Locks refuses deletion rather than guessing whether another editor is writing.

The settings navigation remains locked while the operation is in progress.
Host/user changes invalidate pending reads and later deletion groups. Partial
success stays explicit and failed items can be selected for a new confirmation.
If the host/identity changes during a batch, unstarted host groups stop; the
receipt retains completed counts without exposing the previous identity's
filenames in the new view.

## Entrypoints and CLI boundary

`WorkbenchLibrary.tsx` owns list/search/selection/confirmation UI.
`workbench-library.ts` coordinates scoped reads/deletion receipts and locks;
`storage.ts` owns bounded metadata enumeration, atomic storage changes and
invalidation. `WorkbenchLibraryContext`, `HostApp` and `App` perform user-driven
navigation; `WorkbenchController.openLibraryFile` validates and opens the item.

CLI: not applicable to this device-local management page. The headless Host
cannot read a phone's IndexedDB. Existing conversation-scoped `workbench` Bot
and CLI commands remain unchanged; no Bot gains cross-conversation discovery
or deletion rights through this feature.

## Verification

The focused regressions use isolated IndexedDB databases and local test Hosts,
not the owner's saved work. They cover scope ownership and same IDs on different
hosts, metadata-only reads, stale writes/reset fencing, partial deletion and
retry, active editors in another window, navigation to the exact owning
conversation, draft preservation, and ADHD capacity/cancellation. The list also
has a regression for 1,001 retained empty workspaces before real content.

Desktop and 390-pixel phone views were inspected, with Chinese/English layout
checks. These are browser-engine tests, not physical iPhone/Android or installed
Electron acceptance. No release or installed-App update is included.

Final validation on 2026-10-31 (root and Claude Opus 5.5):

| Check | Result |
| --- | --- |
| Existing/new workbench unit tests (`vitest run client/tests/workbench-`) | 145 passed |
| Real IndexedDB, Web Locks and BroadcastChannel storage scenarios | 10 passed in Chromium and 10 in WebKit, including the two-window stale-layout Design scenario |
| Library UI (cross-host IDs, partial receipts, 1,001 empty layouts, Chinese/English desktop/phone) | 9 passed in Chromium and 9 in WebKit |
| Built App with isolated real Hosts: desktop and phone navigation, open-editor deletion refusal, reload/draft retention, ADHD normal/full-board paths | 2 passed in Chromium after the final build |
| Client TypeScript and production build | Passed |

Root rechecked the production-file hashes against Opus's frozen implementation
and against the build inputs. The source files did not change during final
App navigation validation. The final settings screenshots were inspected.

An earlier full-run desktop navigation failure used an in-progress capacity
fixture; the corrected fixture and final built App passed. An older storage
upgrade fixture was also corrected to exclude the newer Design store from its
v10 setup and expect the actual v12 schema. Neither issue required changing the
production database version. Existing chunk-size/dynamic-import build warnings
remain; they did not fail the build.

Older browser tabs loaded before this version do not have the new Design
editor lock; they should be reloaded before using cross-window cleanup. CAS
still rejects writes back to a deleted document. Without BroadcastChannel,
other windows may retain a stale tab until their next layout check, but cannot
restore deleted content. The bounded scan notice remains visible when a host's
records exceed the listing limits.
