# Personal conversation folders

Desktop's **按对话** layout and the phone **消息** list support custom folders. The
original **按 Bot** layout remains the default. Open **… (管理分组)** above the
conversation list to create, rename, delete or reorder folders. The toolbar has
one entry point; the redundant **管理分组** text label is removed on desktop and
phone. This is presentation only; folder APIs and CLI behavior are unchanged.
On desktop, open the chat's top-right **更多聊天操作 → 移至分组**
or right-click a conversation in either sidebar layout. On phone, long-press a
row and choose **移至分组**. The picker also supports creating a folder and moving in one
operation.
On phone, holding a folder heading for 500 ms opens **分组操作**. Choose
**上移一位**, **下移一位** or **移到最上面** to move the entire folder immediately.
For example, long-press **禅修** and choose **上移一位** to put it above **项目**.
On desktop, right-click the heading or use Shift+F10 for the same actions.
**重命名分组** opens the rename editor with the current name selected.
Ordinary taps still expand/collapse; finger movement, scrolling and cancellation
stop a pending hold. The release click is consumed, so opening actions does not also
fold the section. The system **未分组** section cannot be renamed.
The visible **调整分组顺序** action opens the full ordering editor on desktop and phone. Drag the right
handle or use the up/down arrows, then Save. **未分组** can move as well, including
when there is only one custom folder. Keyboard users can focus a handle and use
Up/Down or Home/End. Cancel discards the draft; moving a row does not immediately
write to another device. Long lists scroll at the edges while dragging. Names
retain normal touch scrolling. Folder membership and conversation ordering inside
each folder remain unchanged.

Deleting a folder returns its conversations to **未分组** and keeps all history.
The desktop move picker explains that folders are displayed in **按对话** when
opened from the Bot layout; moving a chat does not change the user's layout.

Direct chats and top-level group chats can be filed. Topics stay with their group;
newest topic previews, unread and attention state still aggregate onto the group
row. Inside each folder, local pins precede recent activity. Folder headers show
conversation counts directly beside the folder name, with the optional source
host kept separately on the right. Long names truncate before the count; the count
is not part of a host name. This presentation is shared by desktop and phone and
does not change CLI operations or stored folder metadata. Unread/attention
indicators remain visible when collapsed. Search and
filters reveal matching rows even when the folder was previously collapsed.
Folding is a view-only choice for the current mounted list. Organization never
alters sessions, Bot membership, persona, permissions or contextual isolation.

Folders and assignments are personal to the authenticated user on one Hub. The
same user's devices receive immediate socket updates and the full snapshot on
reconnect; cached folders remain readable offline, with editing disabled. Multiple
hosts retain distinct folders, including when conversation IDs are identical.
On phone, an inbox with custom folders is partitioned by host before folders;
without folders the original cross-host recent-message ordering is preserved.

## Implementation

- `client-protocol/conversation-folders.ts`: bounded names, folders, assignments,
  snapshot revision and strict operation schema.
- `hub/conversation-folders.ts`: additive JSON metadata in SQLite `meta`, with
  serialized read and transaction-checked create/rename/delete/move/reorder. Changes
  require current conversation membership; archived chats/topics cannot be moved.
- Authenticated `GET/PATCH /api/conversation-folders`, ready snapshots and
  `conversation-folders.updated` notifications are scoped to the session user.
  Device/session validation runs inside the queued transaction. A stale revision
  is rejected, not replayed over another device's edits. Renames/deletes capture
  the revision when their editor opens. Unknown receipts refresh the view and
  leave the editor available for explicit retry.
- `connection.ts` and identity-checked `storage.ts` retain monotonic snapshots,
  so an older HTTP response cannot undo a newer socket notification. Older Hubs
  omit the new field; editing is disabled until the host supports folders.
- `ConversationFolders.tsx` and `conversation-folders.css` supply shared controls,
  sections, manager and move picker. `ConversationList` and `MobileHome` preserve
  existing row actions, avatars, selection, drafts and unread behavior.
- Folder heading holds reuse `useConversationHold` with a scoped selector.
  `FolderActions` uses the existing revision-checked complete-order write and
  rename form. Native selection/callouts are
  suppressed on headings only. Pending holds and editors follow the visible
  inbox; layout changes or removing the target folder dismiss the editor.

### Folder ordering checkpoint

`FolderOrderDialog.tsx` keeps a revision-bound draft. `folder-order-drag.ts`
captures the pointer on the stable list while keyed rows move; touch cancellation,
lost capture, Escape, blur, resize and leaving the view cancel the active drag.
Reordering retains current-chat selection, drafts, memberships and collapsed
sections. The move destination picker follows the same saved order.

The Hub validates a complete, unique permutation of every custom folder ID plus
`null` for Unfiled. Custom order uses the existing folder array; optional
`unfiledIndex` preserves the system section position without a database migration.
Deleting folders before Unfiled adjusts its index; a default last-position Unfiled
stays last as new folders are created. Transactions retain user scope, device
authorization and revision checks. A stale editor must explicitly load the latest
order before saving, rather than silently replacing another device's edits.

The new Hub advertises `conversation-folders.reorder.v1`. New clients keep the
ordering entry available on older Hubs, showing an explicit host-upgrade message
with move/save controls disabled. Offline clients show a reconnect explanation.
Existing folder operations remain available when the host supports them.
Both the client and its Hub must update for sorting to become available.

The store regression first failed against the old implementation at its missing
reorder operation. Focused tests cover persistence, membership retention, invalid
orders, concurrent changes and authorization. Browser journeys use two devices
on a disposable Hub, actual Chromium touch events, mouse and keyboard controls,
long-list auto-scroll, cancellation, reload, live sync, conflicts, offline state,
older-host compatibility and modal cleanup on layout changes. WebKit uses real
mouse input for drag paths; it does not claim native phone touch acceptance.

Validation: 40 focused protocol/Hub checks and 30 browser journeys in each of
Chromium and WebKit pass. The expanded host-switch cleanup journey additionally
passes at both phone and desktop widths in each browser. Root and client builds
pass. Physical-device acceptance remains separate from these browser checks.

### Direct folder actions checkpoint

The heading action journey moves **禅修** above **项目** on phone, moves it down
through the desktop context menu, and returns it to the top with Shift+F10.
It verifies synchronized order, persistence after both clients reload, retained
conversation membership, draft and collapsed state, focus restoration, and
offline disabling. The hold/rename journey also covers Unfiled actions without
rename, consumed release clicks, scrolling, cancelled holds and layout cleanup.
Validation: all 14 folder journeys pass in Chromium and WebKit (28 total), and
root/client builds pass. These are browser checks; updated native installers
and physical-device verification are separate.

### Desktop move entry checkpoint

The old desktop move action was restricted to a context menu in the conversation
layout. The default Bot layout and the visible chat header menu omitted it.
Both now open the same move picker, including newly created folders and the
atomic **创建并移入** action. The header editor closes when its chat, host or
layout changes. Topics remain with their parent group; archived chats and
offline/older hosts cannot be edited.

The added journey fails against the preceding build at the missing header action.
It verifies both layouts, direct and group chats, new-folder visibility, saved
membership after reload, retained selection/draft, focus return, responsive
cleanup, topic exclusion and offline disabling. The new fixture waits for the
move receipt before stopping its temporary Hub, avoiding an artificial
interrupted-save failure.

Client translation/type checks and production build, and the standalone root
build pass. Across `conversation-folders`, `conversation-context-actions` and
`sidebar-layout`, 16 journeys pass in each of Chromium and WebKit after targeted
reruns (one Chromium trace-stream error and the fixture's early Hub shutdown).
These checks use disposable Hubs; this source checkpoint does not replace an
installed App or claim native connection/packaging acceptance.

### Direct phone rename checkpoint

The added browser regression fails against the preceding production build because
no rename dialog opens. It covers a real Chromium touch sequence and WebKit
pointer events, the release click, tap collapse, movement/release/cancellation,
scroll, the non-editable system section, prefilled names, cross-device sync,
reload, Cancel, navigation during a pending hold and layout changes with an
open editor. This source checkpoint does not replace the installed phone App;
browser evidence is separate from Android physical-device acceptance.

Validation: the new journey and 13 existing folder/phone-action journeys pass
in each of Chromium and WebKit. Client translations, TypeScript and production
build pass. Standalone pre-complete passes with 230 files / 2,935 tests and one
existing skip.

## Verification

- Store regressions: persistence/reopen, delete-with-history-retained, invalid and
  duplicate names, stale and simultaneous writes, per-user isolation, inaccessible
  or archived chats, topics and transaction-time revocation.
- 18 WebKit journeys pass across `conversation-folders`, `sidebar-layout`,
  `mobile-conversation-actions` and `mobile-im`: live desktop/phone sync, create,
  move, duplicate-name rejection, rename, deletion, group/topic aggregation,
  collapsed search/unread, current-chat/draft preservation, reload/offline cache,
  theme widths and identical-ID isolation across hosts.
- Regression harness corrections: an existing removal assertion still expected
  the old recovery wording; the assertion now matches the actual current label.
  Responsive navigation waits for the actual phone Back button instead of sending
  a native event before the lazy-loaded layout has mounted. The new move test
  waits for the HTTP receipt/dialog dismissal before inspecting SQLite. Offline
  acceptance shuts down the disposable Hub rather than relying on WebKit's
  emulated offline flag to terminate an existing socket.
- Root pre-complete hook: 227 files passed, 2914 tests passed, one skipped.
  Root and client production builds pass.
- Native Mac WKWebView: separate `com.tarobot.conversation-folders-preview`
  application and disposable Hub. Created a folder, moved a conversation using
  the native context menu, and checked actual grouping/collapse and layout.
  The preview was closed after verification. No user's installed application,
  pairings or conversations were modified.
- Android release assembly passes. Signed package retains `com.tarocub.client`
  and the existing private-test certificate, version 1.0.48/code 2026101303.
  All 380 native web assets match the package. Signature, version and launcher
  icons were checked. Phone interaction coverage above uses WebKit; this turn
  does not claim Android emulator or physical-phone acceptance.

This feature requires an updated Hub as well as clients. Mac 1.0.48 contains the
new bundled host; a separately deployed Hub must also update. Local installers
are delivered without automatically replacing or restarting the user's App.
The Mac package is ad-hoc signed, not Apple-notarized.

Final installers passed signature/icon/version verification, including the Mac
App mounted from the final copied DMG, its arm64 executable and bundled folder
Hub module. The first Mac bundling attempt lacked a complete app resource seal;
re-bundling with an explicit ad-hoc signing identity fixed it and deep/strict
verification of the final mounted App passed.

- Mac DMG SHA-256: `eba84a93ca57aa3168c35e40033aa2941465632140924e624806fe61b4780396`.
- Android APK SHA-256: `01b16659c809718ef6f4b7b57db86f9f8d3acfea48012e3e7cb53d7f0ad5cc51`.
