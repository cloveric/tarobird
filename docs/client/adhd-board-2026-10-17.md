# ADHD desktop conversation board

## 2026-10-17 sidebar follow-up

The ADHD sidebar now shares the ordinary desktop splitter and its 272 px default
(288 px on windows at least 1500 px wide). Width is document-local and resets on
a fresh launch; switching modes retains it. The picker remains scrollable without
a visible scrollbar and shows the normal conversation list's Bot name labels.
The regression covers dragging, keyboard bounds, narrow windows, double-click
reset, mode switching, reload, and preservation of panes and drafts. See
[implementation and validation](adhd-sidebar-notification-preview-2026-10-17.md).

The board puts several **live conversations** on one screen. It reuses the
ordinary chat view, including input, attachments, queue controls, approvals,
questions, search and message actions. It does not create Bots or conversations
and does not change how a Bot executes work.

## Product behavior

- Open **ADHD** beside **按 Bot / 按对话** in the desktop sidebar (also available
  from the workspace menu). The first visit starts empty. The original
  by-conversation list gains checkboxes, retaining folders, avatars, previews,
  drafts, unread counts and host grouping. Check a conversation to add it;
  clicking an already selected conversation focuses its panel. Group topics
  can be expanded and selected independently; unchecking a group does not remove
  its topic panels. Search includes conversation, Bot
  and host names. The existing “显示未连接 Bot” preference is shared; selected
  panels remain available while a Bot or host is offline.
- Up to 12 distinct conversations can be open. Auto layout balances rows with
  up to six columns according to available width. The user can request 2–6
  columns; narrower windows retain the requested layout and scroll horizontally
  instead of silently reducing the count. Cards remain at least 300 px wide.
  Additional rows scroll. Each panel has its own message scroll and input.
- The toolbar has separate ADHD-only column and text-size controls. Pane text
  defaults to 12 px, adjustable from 11 to 16 px, including Markdown and the CLI
  palette. Ordinary chat and navigation retain their existing text preference.
  Display choices persist on this device. The toolbar is approximately 48 px
  high; the merged pane header is approximately 42 px at the default size.
- A panel's compact chat header names its host, connection state and position. Unfocused
  panels show unread counts. Actionable question/approval cards have a “待回答”
  or “待批准” button that jumps to the exact request. The chat header retains
  the existing Bot/run status, including context compaction when reported. Group
  topic navigation uses an icon and count, with the full label available to
  assistive technology and on hover, so it cannot squeeze out the pane title.
- Drag the grip or use its Alt+Left/Right shortcut to reorder. React keys retain
  the same pane instance and draft. Header actions stay in fixed positions.
- Expand a panel for focused work. Other panes remain mounted with their
  visibility observers suspended; restoring the overview preserves reading
  positions. Escape restores the overview after inner search/menus/dialogs have
  had first refusal. Cmd/Ctrl+F searches only the focused conversation.
- Remove a panel without deleting its conversation or stopping its Bot. Return
  to ordinary chat using **按 Bot**, **按对话** or “返回聊天”; “在单对话中打开” opens that
  particular panel as the ordinary chat. Text and rich drafts use their normal
  persistent stores. Active uploads and microphone capture disable removal/exit.
  Draft writes keep controls clickable: a requested transition waits for saving
  to settle, with a visible, cancellable status. While that transition is pending,
  other closing actions are disabled so they cannot replace the original intent. A failed draft save offers a styled confirmation:
  continue editing or explicitly discard unsaved changes. Entering the board
  checks background uploads/recordings/drafts on every mounted host first,
  including failed rich drafts in a previously selected conversation. Removing a
  panel returns keyboard focus to its checkbox; closing search returns focus to
  the input. Deleting a topic replaces its card with its parent group (or reuses
  the existing parent card), without consuming another slot. Focus restoration
  is consumed once, so later expand/restore actions cannot steal input focus.
- The board owns one microphone lease. Other panels cannot start capture until
  that lease is released, including permission denial/cancellation.
- Notifications route to the owning host/panel and exact message, without
  aborting other panels' uploads. At the panel limit, a visible limit message
  asks the user to remove a panel. No arbitrary existing panel is replaced.
- If a desktop window becomes too narrow, keep the board mounted and show a
  widen-window/return-to-chat screen. Uploads keep running. Restoring width
  restores the board. Native Android/iOS never expose the entry, including on
  wide tablets. Desktop browser windows and Mac/Windows clients share this UI.
- The board's selected conversations, order and layout are device-local.
  Entering the mode is deliberate each session; starting the App opens its
  ordinary chat view. There are no edges, conversation relationships or
  automated cross-Bot actions in this feature.

## Ownership and isolation

`HostApp` remains the sole owner of the host connection pool and global
notifications, preference application, badges and native listeners.
`AdhdBoard` obtains existing `HubConnection` objects from that pool: no iframes,
extra Hub process, WebSocket or copied identity is created per panel.

`Workspace` has a `pane` presentation mode with a fixed conversation ID. The
ordinary workspaces are unmounted while the board is active so the same draft
never has both a hidden ordinary view and a panel writing it. Panels don't
start/close connections, persist the selected single-chat conversation, mount
ShareInbox, or own global native/update listeners. Keyboard/search/read-mark
handling is scoped to the focused visible panel; reading history does not
mark a pane's new messages read.

A pane key is **(canonical host ID, local pairing registration ID, conversation
ID)**. Same Bot/conversation IDs on different hosts stay isolated. Re-pairing
cannot reuse a previous pane's identity. Missing, removed or revoked
targets show an unavailable placeholder; archived chats retain their ordinary
read-only view and draft owner; asynchronous directory loading never
silently erases a saved layout. The user may remove such a placeholder. Notification focus requests are consumed
once; removing and re-adding a panel does not restore an old message highlight.

`HubConnection.subscribeCommands()` supplies independent subscriptions instead
of one replaceable completion callback. Matching still checks Bot/query.
`conversationRevision()` marks event-touched conversation histories, while
`cacheRevision` remains the global ACK/history watermark. A replay batch or
interrupted replay publishes every touched conversation. Snapshot, reconnect,
explicit cache refresh and local queue reconciliation still invalidate globally.
Only pane history/outbox readers opt into scoped invalidation; existing normal
chat readers retain their previous behavior. Pane directory/activity/pin metadata
comes from HostApp's shared directory observer, so a group sees new activity in
its child topics without rereading unrelated message bodies.

## Storage and failure handling

`HostRegistry` stores `meta["adhd-board-v1"]` and `meta["adhd-view-v1"]` in its
existing IndexedDB database. Runtime validation is in `adhd-board-state.ts`.
The original layout record stays readable by App 1.0.86:

```json
{
  "version": 1,
  "columns": 0,
  "panes": [
    { "hostId": "hub_…", "registrationId": "…", "conversationId": "…" }
  ]
}
```

The separate display record is `{ "version": 1, "columns": 0, "fontSize": 12 }`.
It allows columns 0/2/3/4/5/6; the legacy record maps 5/6 to 0 (automatic).
Both records are read together and written in one transaction. A corrupt display
record falls back to the legacy column choice and default text size, without
hiding a valid layout or rewriting the bad record during loading. Column edits
made in the older App are recognized on returning to the newer App. A synchronous
write exception explicitly aborts the transaction, so failure cannot commit
only one record. Older layouts without a display record load at 12 px.

The schema bounds IDs and panel count, rejects duplicates/unknown fields, and
validates both read and write. Layout writes are serialized within the board
and stored atomically. Layout is a last-saved device preference,
not a cross-window collaborative document. A read error preserves the stored
value, disables edits and offers retry/exit. A failed write keeps the current
layout visible and offers retry. Chat history, credentials, attachment bytes,
queue entries and drafts are not copied into this record.

## CLI and engine compatibility

CLI impact: **not applicable**. This is a desktop presentation feature. Existing
CLI/App conversation, upload, send, question/approval and queue APIs remain the
same. No provider-specific request path is introduced; Codex, Claude,
Antigravity, Kimi and DeepSeek continue through their existing adapters.
Concurrent presentation does not promise concurrency within one Bot: its
existing queue/session rules remain authoritative.

## Review and verification

Claude Opus 5.5 xhigh reviewed the design and the implementation through the
owner-authorized CC1 collaboration conversation. Design findings drove scoped
history invalidation, independent completion subscriptions, draft ownership,
notification routing, upload protection and the single microphone lease.

The review reproduced and drove fixes for stale message focus after reopening,
failed-microphone lease release, failed-draft exit lock, hidden-host upload
cancellation, offline-group filtering, pointer clicks lost during scrolling,
search focus restoration, group-topic unread activity, autosave navigation, and
in-place navigation after topic deletion. The final independent Chromium closure run passed 11 probes, including
search/replacement focus, background uploads, topic unread state, delayed writes
and cancellation, failed drafts in a previous chat, and normal-page entry. Its remaining P3 finding (a second pending action replacing
a queued exit) was fixed by retaining the first transition and disabling other
closing actions until completion/cancellation; the controlled slow-save browser
regression covers this in both engines.
The reviewer also measured 12-pane streaming with zero history reads in other
panes and no recorded long tasks; this is an isolated-browser measurement, not
a performance guarantee on every machine.

Automated acceptance:

- `npm test -- --maxWorkers 4`: 320 test files passed; 4,198 tests passed,
  one pre-existing skip.
- `client/e2e/adhd-board.spec.ts`: 13 journeys in Chromium and 13 in WebKit.
  Covers independent drafts/files across two real local Hubs with identical
  conversation/Bot IDs, queue and question-card isolation, disconnect/reconnect,
  streaming invalidation, reading positions, command completion, microphone
  denial, upload lifecycle, corrupt layout, failure/discard, offline groups,
  topic unread/deletion, keyboard focus and delayed draft-save receipts/cancel.
- WebKit ADHD plus `chat-drafts`, `persistent-drafts` and
  `voice-draft-lifecycle`: 40 passed (includes the 13 board journeys).
- Normal Chromium conversation, IME, following/send continuity, outbox,
  persistent drafts, multi-host and question-card regression: 73 passed.
- The final topic-replacement focus and delayed-write/cancel/continued-typing
  changes were additionally rerun in both browser engines.
- Client translation check, TypeScript and production build passed. Host build
  passed. The existing Vite native-module import warning is unchanged.

Known regression-suite issue: the ordinary mobile
`composer-suggestions.spec.ts:123` case intermittently expects a visible menu
in a 520 px simulated keyboard viewport when the available menu area is only
39 px (the UI intentionally hides menus below 54 px). A clean checkout of the
pre-feature commit `1fa744149634851faa28e48b03e9dc93c1ad9bee` reproduces the
same failure: nine passed/one failed in five repetitions of both cases, as did
the feature build. A single rerun passed both. This is recorded as an existing
mobile layout/test issue, not counted as a green regression gate and not changed
by this desktop feature.

Evidence is stored on the owner's external disk under
`/Volumes/gdrive/taro-tmp/tarobot-adhd-20261017/`: final browser logs/screenshots,
full-test/build logs, `topic-before.log` (red before the unread fix), the clean
`baseline/` and independent `opus-review/` reproductions. This directory contains
only disposable test environments and review evidence for this task.

Browser tests use real local Hub/Gateway services with stub model replies; they
do not assert physical two-computer or native Mac/Windows release acceptance.
No production user conversation is used as a test. This source change does not
itself install or publish an App update. The board adds no conversation edges
or cross-Bot automation.

## Second independent audit and refinements

A second owner-requested review used the real CC1 Bot configured with Claude
Opus 5.5 xhigh. Its baseline was `7300b13`, with a frozen client build and
isolated Hub fixtures. The implementation pass separately reproduced the
failures before changing them. This is an audit of the board and its shared
conversation paths, not a claim that every TaroBot subsystem has been audited.

Confirmed fixes:

- A focused card scrolled outside the board viewport used to acknowledge unseen
  replies. Message reading now also requires the latest-message edge to be
  visible through both scroll containers and the latest cached revision to have
  loaded. Logical visibility stays separate, preserving streams and transfers.
- Text sends and steering now keep the draft owner mounted until their async
  operation settles. Upload and recording guards alone did not cover a delayed
  durable text-queue receipt.
- Large group-recipient menus escaped the available space and were clipped by
  the card. Pane menus now use the shared portal with viewport-bounded placement,
  scrolling, keyboard navigation and focus return. Ordinary menus keep their
  existing presentation.
- Composer, conversation title, timestamp, Bot label and hint text respond to
  the user's reading-size preference instead of forcing 9–12 px text, including
  CLI palette overrides. Header height grows when a long title/status wraps,
  so the second line no longer overlaps the first message.
- A signed device revocation previously left both ordinary and board composers
  editable and allowed new entries into a queue that could never deliver.
  `HubConnection` now retains the verified revocation state, rejects new sends
  before enqueueing, and exposes a read-only state to the composer/delegation UI.
  Cached history and saved drafts remain readable. Forged notices or denials do
  not set this flag; the existing signed-handshake verification is unchanged.
- Each pane's offline count now describes its own pending messages, not every
  pending action on the host.
- New-conversation navigation focuses the new input after it is available. A
  successful creation at the 12-pane limit explicitly says it was created and
  can be selected after freeing a slot. It does not automatically replace an
  existing pane. A just-created conversation displays a loading state while the
  shared directory catches up, rather than claiming it was removed.
- Operational notices can be dismissed; only layout I/O failures offer retry.
  Failed navigation at the pane limit no longer stores an invisible focus request.

Product refinements from the review include pending-question/approval markers
in the picker (including unselected conversations), named busy-pane exit tips
and a locate action that focuses the upload/recording control or input, a
keyboard skip control after picker search (including default macOS WebKit Tab
navigation), focus return when leaving the board, and accessible unread-count
names.

The reviewer also checked all 13 palettes in both themes (sampled small-text
contrast minimum 4.67:1), English layout, 12 panes at 2560×1440, 300-conversation
picker/streaming/typing, and two uploads to the same Hub. Serial user clicks
start independent concurrent uploads correctly; `Promise.all` on two Playwright
mouse clicks was a test-input error, not a lost-send defect.

CLI impact remains presentation-only: there is no new host operation, protocol,
engine adapter or CLI command. The client revocation fix matches existing Hub
and CLI authorization rejection rather than introducing a separate permission
policy.

Second-round evidence is under
`/Volumes/gdrive/taro-tmp/tarobot-adhd-audit2-20261017/`:

- Full unit suite: 320 files, 4,198 passed and one existing skip
  (`full-tests-final.log`).
- Final board suite: 19 journeys in each engine, **38 passed** across Chromium
  and WebKit (`verified-board.log`). This includes partial/offscreen unread
  receipts, durable send receipt ownership, large menus, per-host revocation,
  per-pane offline counts, pending questions, busy focus, and creation at capacity.
- Related ordinary-chat regressions: 56 passed in Chromium, covering desktop
  and phone drafts, IME, outbox recovery, screenshots, details, navigation,
  steering drafts and message context menus (`ordinary-regression.log`).
- Revocation/offline/handshake checks: 18 passed across Chromium and WebKit,
  including forged notices, invalid denial signatures and revoked reload
  (`revoked-fixed.log`).
- Three palettes at reading size 20 in approximately 370 px cards: both browser
  engines passed computed child-size and overflow assertions. Default, CLI and
  pixel screenshots were also visually inspected (`font-final/`).
- Translation keys/placeholders, TypeScript, client production build and host
  standalone build passed (`build-final-verified.log`, `build-host-final.log`).
  The existing Vite native-module import warning is unchanged.
- Independent Opus closure reports and isolated tests are in
  `opus-review/round3/` and `round4/`. The final header-height and CLI-size
  refinements were subsequently checked in `font-final/`.

The partial-visibility regression explicitly checks its geometry before sending:
its newest-message edge is below the outer viewport. The older 50% viewport
check fails this case (`partial-baseline-confirm/run3.log`). The stream/reading
regression waits for wheel/virtual-row measurement to settle before capturing
its position; measuring the initial empty virtual range produced a false
scroll-jump failure. Neither fix changes the required reading-position result.

The documented last-saved-wins behavior for multiple windows editing the layout
remains. This preference is not a collaborative board document. Native
macOS/Windows packaging, OS file drops/zoom and screen-reader speech are still
separate acceptance work; browser checks do not substitute for them. The earlier
mobile suggestion-menu issue above remains recorded and was not changed here.

## Shared inbox and density revision

The third desktop sidebar option now enters ADHD directly. Selection uses the
ordinary inbox components and folder data, adding sibling checkboxes rather
than nesting controls inside a conversation button. The normal Bot/conversation
preference is retained until the user explicitly chooses another mode. Mode
switches use the existing draft, upload and recording guards. The board only
uses directories belonging to the current host registration; its row clicks
focus/add panels without dispatching ordinary-workspace navigation commands.

This revision merges the two panel header bars, reduces empty chrome and adds
independent 11–16 px text and automatic/2–6 column controls. Automatic layout
balances incomplete rows; manual column counts remain explicit, with horizontal
scrolling on narrower windows. Horizontally hidden panes cannot acknowledge
unseen replies. At the 12-panel limit, unchecked rows explain why another pane
cannot be added. Existing panes and drafts are never displaced.

The legacy layout and new display records are validated separately and saved
atomically. Fault injection reproduced a partial write when the second
IndexedDB call threw synchronously. Explicit transaction abort fixes the split;
settling every issued request also prevents an unhandled abort rejection.
Failure keeps both saved records intact, preserves normal preferences, and
offers a retry. The browser regression verifies all three properties.

Validation for this revision is stored under
`/Volumes/gdrive/taro-tmp/tarobot-adhd-density-20261017/`:

- Shared-inbox, font-isolation, 4–6-column, atomic-write failure/retry,
  narrow group/topic header and display-recovery journeys supplement the
  original 19 ADHD journeys. The failure test also asserts no unhandled browser
  error. The recovery test preserves valid panes when display data is damaged
  and honors column edits made by the older App. Final complete runs: **23 passed
  in Chromium and 23 in WebKit** (`verified-chromium.log`,
  `verified-webkit-final.log`). After the final model-icon preference refinement,
  the narrow-header journey passed again in both engines, including CLI text
  size with model icons hidden (`cli-size-*.log`).
- Focused closure reruns for pane capacity/creation, shared inbox, independent
  fonts and atomic settings passed in both engines (`closure-*.log`).
- Ordinary desktop/phone sidebar layouts, resizing, folders, chat drafts,
  persistent drafts and multiple-host regression: **62 passed** in Chromium
  (`shared-regression.log`). Ordinary topic navigation and model-brand checks
  add **3 passed** (`topic-regression-final.log`). Their cached-Bot fixtures now
  explicitly enable “显示未连接 Bot”; without that opt-in, the existing default
  offline filter correctly hides the sample Bots.
- Board-state, conversation-folder and scoped-connection unit checks: **13 passed**
  (`unit-final.log`).
- Translation checks, client TypeScript/production build and standalone host
  build passed. The existing Vite native-module import warning is unchanged.

The text-size journey starts ordinary chat at 18 px, verifies ADHD at 12 and
16 px including the CLI palette, reloads the saved display choices, and checks
that ordinary chat remains 18 px. It also validates legacy-record readability,
six columns, horizontal scrolling and offscreen unread receipts. These are
isolated-browser and real local Hub checks with stub model responses. This
revision does not claim a native App installation or a published release.
CLI impact is presentation-only; no host API or CLI behavior changes.

The real CC1 reviewer, configured with Claude Opus 5.5 xhigh, independently
reproduced invisible unread numbers, oversized/crowded headers, fixed small
metadata and the synchronous partial-write path. These were corrected. Further
review drove compact topic navigation, intact-layout fallback for damaged
display settings and recognition of legacy column edits. Font isolation was
independently measured across 166 in-card text nodes: changing the ordinary
font preference changed none of them. Same-named hosts and same-ID conversations
were verified to retain their own histories; an early apparent blank panel was
a fixture timing error, not a product failure. See `opus-audit/` for the frozen
builds, findings, independent probes and closure evidence.

Search retains its dedicated context header; closing search restores the compact
pane controls. The sidebar checkbox and row focus remain available during
search. This deliberate presentation behavior is not a separate navigation mode.

The independent final closure (`opus-audit/closure.md`, `fixed/run-1.log`)
reported no remaining blockers. At 300/370 px card widths and 12/16 px text,
group/topic titles remained identifiable and the reviewer measured no header
controls overlapping or overflowing. Header height was 42–43 px at 12 px,
45–48 px at 16 px. The main pass additionally checked that hiding model icons
keeps Bot names visible, including the CLI palette. Very narrow streaming-status
text may ellipsize; its full label is available on hover and to assistive
technology.

One intermediate WebKit run reported a Markdown worker access-control error
during the font journey's rapid reload, while its UI assertions passed. The
final complete WebKit rerun passed all 23 journeys without that error; the
strict page-error assertion remains. This isolated transient is recorded in
`verified-webkit.log`, not counted as a passing run or claimed as a fixed worker
bug. No Markdown worker implementation was changed in this revision.
