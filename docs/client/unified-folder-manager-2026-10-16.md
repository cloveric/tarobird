# One folder-management entry

The inbox/sidebar previously exposed New folder, Adjust folder order and More
as separate buttons. More opened an edit/delete list while order opened another
list. The toolbar now has one labelled More entry, including when no folders
exist. It opens the shared folder manager on phone and desktop.

The manager contains New folder and a sortable list. Each row has one More
button for up/down/rename/delete and a drag handle. Unfiled can move but cannot
be renamed or deleted. Handles retain keyboard arrows and Home/End. There is no
separate global order page, and folder headings retain their existing shortcuts.

Order changes remain local until Save; create/rename/delete use their existing
explicit form/confirmation and immediately synchronize. The order draft lives
above those forms, so local edits do not discard pending moves. A successful
local edit updates the draft's base only at its expected next revision. Remote
changes and uncertain/conflicting receipts still require loading the latest
order. Offline/older-host capability gates remain distinct for editing/sorting.

CLI impact: navigation and presentation consolidation only. Existing shared
folder APIs, permission checks, revision rules and metadata are unchanged;
there is no new host operation or headless command.

## Validation and boundary

- The initial focused test reproduced three toolbar buttons where the single
  management entry was expected. New journeys cover create/rename/delete while
  an unsaved order exists at 320/390/1360px, plus a rename retry after a remote
  update that must not silently rebase stale order.
- Translation checks, TypeScript and the final client production build passed.
- Chromium and WebKit each passed all 37 relevant journeys across
  `conversation-folders`, `sidebar-layout`, `mobile-conversation-actions` and
  `mobile-im`, including focused reruns. These cover touch/mouse/keyboard sorting,
  drag cancellation/auto-scroll, Unfiled, empty-folder creation, archived/offline
  constraints, old-host capability gates, synchronization, reload, same-ID host
  isolation and modal cleanup on notification/layout navigation.
- Broader regression exposed outdated expectations for the existing conversation
  avatar action, draft preview priority and conditional steering entry. Updated
  those fixtures against current product behavior; real draft isolation, unread
  state and source messages remain asserted. An initial Chromium navigation run
  also overlapped the final rebuild and hit a removed lazy asset (404); rerunning
  on the fixed build passed. No host behavior was changed to satisfy these tests.
- Inspected light/dark and CLI manager screenshots, including the narrow layout.
  Evidence: `/Volumes/gdrive/taro-tmp/tarobot-folder-manager-20261016/`.

This is source/browser acceptance. No native installer or installed application
was updated; physical-device acceptance remains separate.
