# Desktop sidebar layouts

The desktop sidebar has a compact **按 Bot / 按对话** switch below search.
New and existing profiles without an explicit choice keep the original Bot
tree. The selected layout is a device preference, retained after restarting
and shared across that device's host workspaces. It does not alter chat
selection, drafts, Bot configuration or message history.

Conversation layout shows direct chats and top-level groups with an avatar,
title, Bot badge, preview, time and unread indicator. Pins precede recent activity.
Live topics contribute their latest preview and unread messages to their
parent group; they remain accessible inside the group's chat. Archived chats
and children of archived groups are omitted, as in the phone inbox. With
multiple hosts, the default list combines their Bots or conversations. Bot
branches follow their latest conversation activity; conversation rows keep the
shared pin/recency ordering across hosts. The host filter remains available.

A small **按主机分组 / Group by host** checkbox is unchecked by default and
remembers the device's choice. In conversation layout it sits immediately to the
right of **新建分组 / New folder**, without a separate checkbox row. In Bot
layout, which has no folder toolbar, it remains below the layout switch. When checked, each
host gets a heading and the rows omit redundant host badges. In the combined
Bot tree, only the Bot heading carries a source badge; nested chats and topics
inherit it. Independent conversation rows carry one badge. Filtering to a
single host removes redundant headings and badges in either layout.

Custom conversation folders keep their host ownership and saved order. In the
combined layout, folder headings carry the source badge and their children do
not repeat it. The folder toolbar edits the active host; its dialogs name that
host. Selecting a host in the filter also exposes its complete folder tools.
Identical Bot, conversation and folder IDs on different hosts remain separate.

`conversation-inbox.ts` extracts the phone's existing aggregation, ordering
and timestamp functions for shared use. `MobileHome.tsx` keeps its public
exports for compatibility. `ConversationList.tsx` reuses existing context
menus, rename, pin and removal flows for both layouts. The original grouped
rows keep their markup and spacing. `SidebarLayoutSwitch.tsx` and
`sidebar-layout.css` provide the desktop-only control and compact inbox rows.
In conversation layout, the Bot name and configured model mark follow the
conversation title with a small fixed gap, matching the phone's title/identity order.
The name/model gap also has breathing room; neither label is pushed to the row's end.
Short titles no longer stretch and push the identity to the opposite edge;
long titles still ellipsize. Narrow-side-bar identity hiding, model-icon
preferences, timestamps and unread dots keep their existing behavior. This
also applies to the shared ADHD conversation picker. CLI-not-applicable:
this changes only App list typography, with no data or host behavior change.
`CombinedSidebar.tsx` orders host-scoped slices while `ConversationList.tsx`
continues to own their existing menus, permissions and connection handlers.

## Activity ordering repair (2026-10-14)

Both combined and host-grouped Bot trees now share `buildBotRows`: a Bot's
newest non-archived direct conversation determines its position. A newly
created conversation is the fallback when it has no messages. Host identity
remains part of each key; same-ID Bots on different hosts cannot merge.
Pins and manually arranged conversation folders keep their existing behavior.

Streaming and full message updates use the authoritative Hub event time, not
the original reply's creation time. Thus a long-running GG1 reply with fresh
progress moves above an idle AA1. Reading, presence changes, duplicate revisions
and enrichment of an existing user message do not promote the conversation.
Times never move backwards when an older reply continues after a newer prompt.

Offline snapshots carry the selected content event's `contentAt`, including
the original event for immutable user messages. This optional field is sent
only to clients advertising `snapshot.activity.v1`: older strict snapshot
clients retain their original frames. New clients still accept older hosts,
using message creation time when an old host cannot supply snapshot activity.
Cached history from before the fix is corrected by subsequent message events
or a fresh snapshot; the client does not invent activity on launch.

The headless CLI and desktop use the same Hub snapshot implementation, with
no new CLI command, database schema or change to host/network ownership. The
App-side presentation and cache fix applies to all engines; no engine-specific
branch was introduced. This source change does not replace installed Apps.

## Verification

- 2026-10-14 activity ordering: host build and client translation/type/build
  checks passed; 40 focused Hub/link-preview tests passed. The new cache
  regression first reproduced the old timestamp bug, then passed after the
  repair. Chromium passed all 12 activity/sidebar/snapshot/stream journeys;
  WebKit passed all 7 activity/sidebar/snapshot journeys, with the corrected
  fixtures rerun separately. The two-host fixture explicitly allows the first
  host's browser origin; the snapshot fixture now uses its socket proxy alone
  instead of waiting indefinitely for an unrelated service worker. Verified
  the rendered GG1-before-AA1 order, selection, draft, reload and offline catch-up.
  These are isolated browser/Hub checks, not a new native App installation.

- 2026-10-14 toolbar adjustment: client translation/type/build checks passed;
  Chromium sidebar and desktop/phone folder journeys passed (5), as did WebKit
  sidebar journeys (3). Checked the rendered inline placement. Narrow toolbars
  keep the reorder button accessible by its icon, tooltip and accessible name;
  controls wrap if needed rather than overflowing. Only one grouping checkbox
  is shown across host sections. This is presentation-only: CLI commands, host
  ownership, folder metadata and the default preference are unchanged. No new
  installer was produced for this source change.

- Optional host grouping update: Chromium journeys cover the default unchecked
  choice, combined ordering, one source label per branch, host filtering,
  same-ID rename/folder ownership, saved choices and drafts. The affected
  sidebar, source-badge, host-workspace and folder suites passed (20 journeys;
  two folder fixtures were corrected to set the authoritative host name and
  rerun). Seven focused WebKit journeys also passed. Client build and the
  repository pre-complete hook passed (3052 tests, one skip). Screenshots of
  both checkbox states were inspected. This update ships in
  [1.0.65](release-1.0.65-2026-10-13.md); its new grouping control has not been
  revalidated in the installed native App.
- Browser `sidebar-layout` covers the default, chronological and pinned order,
  group/topic preview and unread aggregation, archive exclusion, avatars and
  Bot badges, active topic highlighting, drafts, reload, narrow sidebar
  layouts, phone fallback, multi-host switches and same-ID action isolation.
- Existing `sidebar-resize`, `conversation-context-actions`,
  `bot-context-menu` and `mobile-im` passed with the new journeys: 19 WebKit
  tests. The first combined run overlapped a client asset rebuild and hit a
  mobile timeout; the complete run against stable assets passed. After the
  narrow-sidebar label adjustment, both new journeys passed again. At narrow
  widths the optional Bot badge gives its space to the conversation title.
- Required pre-complete hook: 226 files passed; 2910 tests passed, one skipped.
- Native macOS verification uses a separate
  `com.tarobot.sidebar-layout-preview` profile and a disposable local Hub.
  The original Bot layout, flat list, avatars and both directions of switching
  were checked in the native window. After quitting and relaunching, the flat
  selection and unsent draft were restored from cache. No real Bot/model calls
  or user-host data were used. The preview and temporary Hub were stopped and
  the temporary Hub state was removed after verification.

Local logs and native fixture files use `/Volumes/gdrive/taro-tmp/sidebar-layout-*`.

Mac installer 1.0.46 (Apple Silicon) passed mounted-DMG version, icon, bundle
identity, arm64, bundled-host and deep/strict signature checks. It is ad-hoc
signed, not Apple-notarized. SHA-256:
`d71ca00b6f99ef645ffcbe6ea64615ee0de85af3eb660fd2acc437e9e15ac72c`.
This is a local installer; the user's installed App has not been replaced.
