# Desktop progressive disclosure (Opus 5.5, 2026-10-11)

Status: **implemented by Opus 5.5 xhigh; built and checked in the browser and
native macOS preview by the parent.** Opus used Read/Edit/Write/Glob/Grep and
completed successfully. The parent performed the builds, navigation-test updates,
rendered checks and native acceptance below. This is a UI iteration, not full
product or release acceptance.

Request (operator): at first glance the desktop App is too busy because every
function is spread across the home screen. Do subtraction without removing
features, with Grok Bot as the reference.

Scope: desktop presentation only (`min-width:761px`). Phones keep the IM layout and
their existing controls. There are no transport, storage identity, CLI prompt/engine,
session, group, topic or workspace semantic changes. No feature was removed. Every
moved control reuses its existing dialog or callback.

## 1. Reference (structure only)

Provided screenshots: the current App
(`/tmp/tarobot-desktop-simplify-20261011/01-before.png`) and Grok Bot
(`/tmp/tarobot-grok-motion-20261011/01..04-*.png`). They were read for structure
only. Their conversation content is not reproduced and they are not committed.

- Grok: the sidebar holds a list of conversations with search and one "+" at the
  top, and an avatar plus one labelled entry at the bottom. The "+" opens one
  list: create a Bot, create a group, or pick a Bot. The header is identity only;
  details are one step away. The composer is one calm pill (plus, field, mic,
  send) whose plus opens a small anchored menu.
- TaroCub before, desktop: the sidebar wrapped the list in chrome rows: logo plus
  new chat, then the host filter, manage and add buttons, then a separate
  New Bot / New group row, then search, then a repeated host heading. The Bot tree
  had model subtitles. Under the list came a current-host label, a Files row and a
  Skills/MCP row. The footer had the avatar, status text, operations and settings.
  The header showed the host, the model and the effort summary, new chat, route
  with latency, and settings. Groups added a topic bar (back, tabs, all topics,
  new topic). The composer always showed the recipient chips and a three-line field.
  Steer, Stop and the newline hint were visible even while idle. A security banner
  sat above every history.

## 2. First glance, after

| Region | Always visible | One step away |
|---|---|---|
| Sidebar top | wordmark, one **+ 新建** | create menu: 新建对话 / 新建 Bot / 新建群组, each with a one-line meaning |
| Sidebar scope | nothing for one host. With 2+ hosts: one host filter, and a heading per host with status and unread | host management and adding a host, in the workspace menu |
| Sidebar list | search, Bot rows (name only), their chats, groups and topics, unread badges | Bot engine/model as a row tooltip and in the chat details |
| Sidebar footer | avatar (profile settings), **工作台** entry (host name and status dot), settings | workspace menu: 文件中心, Skills 与 MCP, 运行状态, 已归档对话 (count), 管理运行主机, 添加主机 |
| Header | avatar (conversation settings); title; reply status; group topic switcher; **思考强度 · level**; connection glyph; **⋯** | More: 对话设置, 新对话, 新建话题 (groups), idle Steer/Stop with notes, details (connection route and latency, host, each member Bot's engine/model), authorization note |
| Group header | "← back to group" (topics only), and the topic switcher ("默认讨论 · N 个话题" or "group · N 个话题", with an unread dot) | topic directory: search, archived filter, 默认讨论, all topics, 新建话题 |
| Composer | attach, voice, collaborate, send. Groups: one **@ recipients** selector | recipient checkboxes; Steer/Stop appear only while a reply is detected |

Multi-host identity stays obvious. With 2+ hosts, the sidebar shows the filter
(with unread counts) and the host headings, and the header shows "运行于 X". With one
host, the header label is visually hidden but kept in the DOM, and the footer entry
names the host.

## 3. Exact feature routes (desktop)

Unchanged direct routes: search, every Bot/chat/group/topic row, the group
collapse toggles, the Bot row "+" on hover/focus (为 X 新建对话), the 个人头像 avatar,
**设置**, the header avatar (opens conversation settings), the effort control,
**打开连接设置** (connection glyph), attach, voice, collaborate, send, slash
commands, @mentions, the jump-to-latest control and message actions.

| Feature | Before | Now |
|---|---|---|
| New chat (current Bot) | brand "+" / header 新对话 | **新建** › 新建对话 (multi-host still asks for the host); **⋯** › 新对话 (current Bot); Bot row "+" |
| New Bot | sidebar row | **新建** › 新建 Bot |
| New group | sidebar row | **新建** › 新建群组 |
| File center | sidebar row | **工作台** › 文件中心 |
| Skills & MCP | sidebar row | **工作台** › Skills 与 MCP |
| Operations | footer icon | **工作台** › 运行状态 |
| Archived chats | sidebar `<details>` (only when any) | **工作台** › 已归档对话 (count) → existing archives dialog → conversation settings |
| Manage hosts | host row icon | **工作台** › 管理运行主机 (also still in Settings › 设备与安全) |
| Add host | host row icon | **工作台** › 添加主机 |
| Host filter | always | only with 2+ hosts (`筛选运行主机`) |
| Conversation settings / avatar | header gear, header avatar | header avatar; **⋯** › 对话设置 |
| Connection settings | route pill | connection glyph (text returns while connecting/offline); route and latency in **⋯** details |
| Engine / model | header subtitle, Bot row subtitle | **⋯** details; Bot row tooltip; effort dialog |
| Thinking effort | header subtitle | header **思考强度 · level** (one click, as before) |
| Runtime host | header subtitle, footer label | header with 2+ hosts; footer **工作台** entry; **⋯** details |
| Group topics | topic bar row | header topic switcher → existing topic directory; sidebar tree unchanged |
| Back to group | topic bar | header ← (`返回群组「X」`), topic directory 默认讨论, sidebar row |
| New topic | topic bar | topic directory 新建话题; **⋯** › 新建话题; empty-group "创建第一个话题" |
| Group recipients | always-visible chips | composer **@** selector (`让谁回复：…`) → checkboxes; @mention menu unchanged; zero recipients still blocks send with the same message |
| Steer / Stop while a reply is detected | composer | composer (unchanged) |
| Steer / Stop when no reply is detected | composer | **⋯** › 引导当前任务 / 停止当前轮次, with the same notes as the phone |
| Authorization note | banner above history | **⋯** footnote (phones keep the banner) |
| Newline hint | always | only while the composer is focused and empty |

## 4. Interaction rules

`client/src/DesktopMenu.tsx` is a disclosure popover. The caller renders the
trigger with `aria-expanded`, and `aria-controls` while the popover is open. The
panel is `role="group"` with a label, and its items are ordinary buttons whose
names are their visible labels.

- Opening focuses the first enabled item. Up/Down/Home/End move between items.
- Escape and Tab close the popover and return focus to the trigger. A pointer
  press outside closes it without moving focus. Native Back is honored.
- Activating an item first focuses the trigger and then closes the popover. A
  dialog opened by the item therefore restores focus to the trigger. Toggle items
  (`data-menu-keep`, the recipient checkboxes) stay open.
- At most one popover is open (`menu` state in `App.tsx`). It closes whenever the
  selected chat, the host workspace visibility, the phone/desktop layout, history
  search or the archived state changes, so it never acts on a stale target.
- Nothing affects file picker activation: attach remains a direct button.
- Motion is a 180ms grow-from-trigger opacity/transform on the panel only. The
  global reduced-motion rule removes it. Nothing animates `.message`, height or
  width.

The composer field uses `field-sizing: content` where supported: one line while
empty, growing to about six lines. Without support, it keeps the existing two-line
height (no jump on focus).

## 5. Files

- `client/src/DesktopMenu.tsx` (new): shared desktop popover.
- `client/src/desktop-simplify.css` (new): `min-width:761px` only, imported last
  in `main.tsx`. It uses existing tokens only, so warm/neutral/sage, light/dark and
  both languages follow automatically.
- `client/src/App.tsx`: sidebar create menu, footer workspace menu, header More,
  back-to-group control, topic switcher, effort summary, compact recipients,
  Steer/Stop visibility, phone-only authorization banner and topic strip.
- `client/src/HostApp.tsx`: `multiHost` and `addHost` on the shell. The host filter
  and headings appear only with 2+ hosts. Manage/add moved to the workspace menu.
- `client/src/GroupTopics.tsx`: `TopicSwitcher`, which reuses `TopicDirectory`.
  The phone `GroupTopics` is unchanged.
- `client/src/ConversationList.tsx`: Bot rows drop the model subtitle (kept as a
  tooltip).
- `client/src/locales/en.json`: 7 new keys (工作台, 工作台：{0}，{1}, 主机,
  选择回复的 Bot, {0} 等 {1} 个 Bot, 让谁回复：{0}, {0} 个话题).

## 6. Browser-test navigation updates (desktop viewport)

The parent updated the following routes through shared
`fixtures/desktop-actions.ts` and `fixtures/mobile.ts` helpers. Existing behavior
assertions remain, and `topics.spec.ts` adds a regression for repeated
private/group/topic switching. Changed test files were syntax-checked. The full
Playwright suite was not executed in this iteration; the browser checks in
section 8 were performed through the computer-use API.

Opus's original migration inventory:

- `fixtures/mobile.ts` `mobileChatAction`: on desktop too, open `更多聊天操作`
  first. The desktop items keep the same names (`对话设置`, `新对话`,
  `引导当前任务`, `停止当前轮次`).
- `fixtures/mobile.ts` `openWorkspacePage`: on desktop, open the footer entry
  (accessible name starts with `工作台：`) before 文件中心 / Skills 与 MCP / 运行状态 /
  管理运行主机. `设置` remains direct.
- Direct desktop clicks on `新建 Bot` / `新建群组` (creation, cross-device,
  host-workspace, live-*) need `新建` first. `新建对话` `.last()` in hub/routes/cards
  still resolves to the welcome action when no chat is selected.
- Direct desktop `对话设置` (avatars, creation, review-recovery, cross-device,
  chat-drafts, message-actions, live-session-model, live-claude-binding) and
  `新对话` (creation:41) need `更多聊天操作` first.
- Direct `运行状态` (operations, avatars:103, diagnostics:55, dashboard:68,
  managed-restart, live-bus, live-crew), `文件中心` (file-center:91), `添加主机`
  (host-workspace:12, host-previews:18, desktop-notifications:282) and
  `管理运行主机` (host-workspace:130/151/165, local-reset:130) clicks need the
  workspace entry first wherever they run at desktop width. The viewport of each
  of these call sites was not individually confirmed.
- topics.spec (desktop): use the `.header-topic` switcher instead of `全部话题`
  (lines 85, 103). `新建话题` at line 96 is now in the topic directory or
  **⋯**. `返回群组「…」` still exists in topics. The phone part is unchanged.
- chat-drafts (desktop): open the `让谁回复：…` selector before the `助手甲`/`助手乙`
  checkboxes. Their roles, names and `aria-checked` are unchanged.
- Still valid: `.connection-pill.online` stays visible (icon-sized) and keeps the
  route text and title. `.runtime-host-label` `.first()` keeps its exact text with
  one host (visually hidden). The `主机：X` regions and the multi-host
  `.host-heading` labels and `筛选运行主机` are unchanged. The steering.spec helper
  already falls back to `更多聊天操作`.

## 7. Self-review notes and open risks

- `aria-controls` is set only while the panel exists. Dialog focus restore was
  checked by reading `CreationDialog` (layout-effect `before`) and
  `PreferencesPanel` (`before` / `data-settings-entry`).
- A steer started from **⋯** while idle has no spinner in the composer, because
  the composer Steer button is hidden while idle. Send stays disabled while it is
  in flight, as before, and the receipt or error appears as before. The phone
  sheet behaves the same way.
- If the tail stops reporting a reply while a composer steer is in flight, the
  Steer button disappears. The request and its error/receipt handling are
  unchanged.
- Native WKWebView showed the compact single-line empty composer. Older engines
  still use the previous fixed-height fallback.
- Topics keep the existing EffortControl input (`current.botIds`, inherited from
  the group by the Hub).
- Narrow desktop widths (761–900px) with several hosts and a group put the host
  label, topic switcher and effort on one ellipsizing line. The parent checked
  a single-host group at 800px; multiple-host layout remains a separate gate.
- The welcome screen (`WelcomeHome`) is unchanged.

## 8. Parent verification and fixes (2026-10-11)

Environment: independent loopback Hub and deterministic demo Gateway, without
real CLI/model calls. Existing production App state was not replaced. The native
preview retains its own paired identity (`com.tarocub.motionpreview`).

Verified in the browser:

- The new Create and Workspace menus reach the existing Bot creation, file
  center, Skills/MCP and conversation settings surfaces. This fixture does not
  configure managed Bot provisioning, so reaching its form is not Bot creation
  acceptance.
- Escape and keyboard selection restore focus to the Create trigger after the
  dialog closes. Group recipient changes persist through conversation switches.
- Created the topic “桌面布局验收” inside the existing group. New-topic navigation,
  return-to-group, sending a group message, and completed demo replies work.
- During a reply, Steer/Stop reappear in the composer and normal Send shows Queue.
  This checks presentation; actual CLI steering capabilities were not retested.
- At 800 × 480 the Create menu is fully inside the viewport (left 13, width 248);
  the More menu fits between y=67 and y=445. Panels now have a bounded scrollable
  height for longer content.
- English/Sage-dark menus, Chinese/light layout, and the 390 × 844 phone group
  layout were checked. The phone still exposes Camera, Add images, and Upload
  attachments through the lower-left plus. No horizontal overflow (390/390).
  No phone camera permission, real photo capture, or native mobile build was tested.

Verified in the native macOS preview:

- Pairing survives rebuilding/relaunching the preview. The Create menu fits its
  sidebar, and the compact composer is supported by WKWebView.
- Switching between two topics and private conversations initially
  exposed a real bug: TopicSwitcher and EffortControl shared the same React key,
  leaving duplicate topic controls in the header. Namespaced keys fix it; repeated
  switching now yields one topic control for groups/topics and none for private
  chats. This also passed the browser regression sequence.
- Sent “原生桌面改版验收：入口简化后继续正常对话。” through the native App and observed
  its persisted message and completed demo response. No real model was invoked.

Additional parent correction: TopicSwitcher is mounted only for the visible,
non-search workspace and is remounted for the selected conversation, so its
native dialog cannot remain attached to a hidden host or stale conversation.
This lifecycle guard was reviewed; cross-host switching was not rerun end to end.

Build and test evidence:

- Root pre-completion hook: 239 suites, 3,832 tests passed, one skipped.
- Root TypeScript/relay build passed. Client translations, TypeScript and Vite
  passed inside the final native build.
- Final debug macOS App bundle built; ad-hoc signature verified with
  `codesign --verify --deep --strict`. This is a development preview, not a
  notarized production release.
- Test navigation helpers and changed specs parsed successfully; automated
  browser and native-mobile suites were not executed this iteration.

Local evidence (ignored by Git):
`docs/client/evidence/desktop-simplification-2026-10-11/` contains build logs,
Opus completion metadata, the original App frame, final native frame,
English-dark menu and phone attachment sheet. Grok conversation screenshots
remain outside the repository and were not committed.

Preview: `~/Downloads/TaroBot-Desktop-Preview-20261011.app`.
