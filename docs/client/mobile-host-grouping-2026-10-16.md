# Optional host grouping on the phone

Android App 1.0.81 (2026101611); host/CLI 0.1.430, protocol 1, schema 16.

The phone used to force a host section whenever any host had a custom folder,
then repeat the same host name on each conversation inside it. The message list
now shares the desktop's device-local `sidebarGroupByHost` preference, default
false. Existing explicit choices are retained; switching hosts and reopening
the App preserve the choice. This presentation preference is not synced between
separate devices.

- With grouping disabled, custom folders retain their host, order and members.
  Each folder identifies its source once; its child conversations omit the
  repeated source badge. Hosts without folders share a list ordered by activity.
- With grouping enabled, each host has one heading and its own folder manager.
  Descendant rows and folders omit redundant host badges. Empty host sections
  are hidden during filtering; collapsed folders keep their state when toggled.
- A single paired host needs neither a grouping switch nor source labels.
  Bot-scoped browsing already identifies its host and does not repeat labels.
- Search, unread/request filters, long-press actions, drafts and conversation
  selection keep their existing host scope. Grouping never moves conversations
  or merges folders belonging to different hosts.

`App.tsx` passes the shared preference to `MobileHome.tsx`. The mobile checkbox
uses the existing `HostGroupingSwitch`, with a 44px touch target. No host API,
authorization, storage schema, engine adapter or command changes are required.
CLI applicability: presentation only; standalone CLI 0.1.430 remains current.
This release distributes the Android update; desktop 1.0.80 remains current.

Verification covers two real isolated Hubs with identical conversation IDs,
host-scoped rename and draft retention, single-host defaults, custom folders,
flat activity ordering, unread filtering, 320px layout, reload persistence and
switching between desktop and phone layouts. Browser and emulator evidence do
not imply physical-phone acceptance.

The independent read-only Opus follow-up found no remaining concrete blockers.
All 35 scoped browser journeys pass in Chromium and all 35 pass in WebKit,
including folder-collapse retention and filtered empty-host visibility.
The final standalone pre-complete gate passes: 304 files, 4006 tests, one
intentional skip. A run concurrent with native packaging and both browser
suites hit two existing Gateway tests' 5-second limits; their 74-test focused
rerun and the subsequent full gate passed without changing code or timeouts.
The final APK matches all 390 production web files and the existing signing
certificate. Android verification: 30 unit tests, lint with zero errors (22
existing warnings), and emulator upgrade from 1.0.80 to 1.0.81 retaining the
original installation timestamp, followed by a successful cold start with an
empty crash buffer. The emulator and temporary verification data use the
external drive.

## Mixed folder hierarchy correction (source, not yet released)

When only some hosts have custom folders, the previous combined view labeled
those hosts on folder headings but labeled folder-free hosts on individual
conversations. The same inconsistency was reproduced in the desktop conversation
layout. For example, `example-mac` appeared on `工作`, while `示例电脑` appeared on its
conversation row.

Both layouts now use `conversation-inbox.ts:folderSectionHosts`. Once custom
folders are present, every populated host uses folder sections. A host without
custom folders shows its existing system `未分组` section, carrying the source
label once; its child rows omit that label. This is a presentation of the implicit
Unfiled section, not a new persisted folder. Empty hosts without folders do not
create empty sections. When no host has custom folders, the existing flat list
and cross-host activity ordering remain intact. Explicit host grouping, the Bot
tree, folder ownership/order, filters and host-scoped actions remain unchanged.

CLI applicability: presentation only; no host API, storage schema, CLI command
or engine adapter changes. Regression: `sidebar-layout` reproduces the mixed
case at phone and desktop widths, checks both source labels at the same level,
and retains the correct host and draft through grouping switches. Existing
`host-source-badges` and `conversation-folders` cover layout and folder actions.

Validation: both mixed-host regressions first failed on the old rendering.
The client translation/type/build checks passed. Chromium covers 27 scoped
journeys and WebKit covers 9; all passed, including a focused rerun after fixing
the new desktop width assertion to measure the list instead of the sidebar's
deliberately protruding resize handle. Phone and desktop screenshots were
inspected. This is browser/source verification; no new native installer has
been built or installed for this correction. Logs and previews are under
`/Volumes/gdrive/taro-tmp/tarobot-mobile-host-labels-20261016`.

## 2026-10-26: phone list options in the filter row

The phone Messages page places a single `⋯` (List options) button alongside
All, Unread, Needs attention and Groups. Group by host and Show disconnected
Bots move into its sheet, removing the separate checkbox/toolbar row. The
button retains a 44px touch target; the filter strip scrolls independently for
long translations rather than pushing the button onto another row.

The existing device preferences, defaults and visibility filtering are reused.
Single-host and Bot-scoped lists still omit unnecessary host grouping. Folder
management is available in the same sheet, with explicit host names when more
than one host is paired. It opens the existing FolderManager using that host's
connection, capability checks and revision guards. Desktop controls and the
phone Bot directory keep their existing entries.

Back and close return focus to the options trigger. Leaving the phone inbox,
changing Bot scope or crossing the phone layout breakpoint removes the modal;
re-entering does not reopen it. Bulk selection disables the options entry.
The CLI is not applicable: this changes the phone presentation of existing
preferences and folder APIs, not Host capabilities, data or commands.

Validation uses isolated Hubs and browser layouts, not production state or a
physical device. Chromium coverage includes the 24 existing mobile inbox,
visibility/recovery and sidebar journeys, plus seven folder creation/management
and modal lifecycle journeys. The moved-control assertions and fixture helpers
now open the options sheet explicitly. The expanded host-grouping journey also
checks native Back, focus return, host-scoped creation/deletion, preference
persistence, Android/iOS platform CSS branches and light/dark screenshots.
English at 320px keeps the options button visible while filters scroll.
The existing Duo fold/rotate/split journey also passes, preserving its draft,
attachment and send choice. In total, 32 Chromium and 10 WebKit cases pass
(counting each browser case once after focused reruns). WebKit repeats the key
inbox, folder, scope, modal and narrow-layout checks. Client translation checks,
TypeScript and production build pass. Initial test
failures were stale direct-checkbox assertions and a test trying to open the
inbox menu while still in a chat; both were corrected to follow visible UI and
rerun. This source change does not publish or install a new App.
