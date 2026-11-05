# Bot conversation folding

Desktop “按 Bot” previously rendered every direct conversation permanently,
which made a busy Bot obscure the remaining list. Each Bot with unpinned chats
now has a small, permanent chevron before its avatar. The existing right-hand
plus still creates a conversation. Existing avatar and text sizing is unchanged.

## Behavior

- Default expanded. Click the disclosure, Enter/Space, or Left/Right to fold or
  unfold. Empty Bots and Bots whose chats are all pinned keep an aligned spacer.
- Folding affects the sidebar subtree only: the selected chat, composer draft,
  execution, pinned section and data remain intact. A folded Bot containing the
  selected chat retains the selected background and an accessible description.
- Folded headers aggregate unread and pending attention from hidden, unpinned
  chats. With no unread messages they show the hidden conversation count.
- Clicking the Bot identity explicitly opens its current/recent chat and unfolds
  it. Both Bot-specific create entries (plus and context menu) unfold before
  opening creation. Incoming activity, reordering, offline visibility and passive
  selection do not unfold it.
- Local storage `tarobot-collapsed-bots-v1` is scoped by paired Hub public key and
  device public key, matching the draft-owner boundary. Reloads and sidebar
  remounts retain it; a new pairing has its own choice. Missing/invalid storage
  starts expanded; unavailable writes retain the choice for the App session.
  This is local presentation, not a cross-device or cross-window sync setting.
- Collapsed children unmount, leaving an `aria-controls` target. Unpinning into
  a collapsed Bot restores focus to that Bot's disclosure, including split host
  sidebar slices. The disclosure and Bot action menu have separate ARIA state.
- Only the chevron rotates (140 ms). Child-list height is not animated. System
  reduced motion and the App's interface-animation setting both disable it.

## Boundaries and implementation

`ConversationList.tsx` owns rendering and explicit action handlers;
`bot-conversation-folds.ts` owns the shared local store;
`bot-conversation-folds.css` owns the disclosure geometry and motion.

No Hub protocol, conversation data, execution queue or CLI command changes are
needed: CLI has no sidebar folding surface. Phone inbox/catalog layout is separate
and retains its current behavior. Group topic/folder collapsing is unchanged.

## Review and verification

Opus 5.5 reviewed the design and implementation independently through a dedicated
CC1 conversation. Runtime `bots model` confirmed `claude-opus-5-5[1m]` with
`effort=xhigh`; review artifacts and receipts are in the task evidence directory. Its review
identified hover overriding the selected Bot marker, the focus-ring offset,
unpinning from a merged sidebar slice, and overly compressed host labels.
These were corrected and tested. Bot names and host badges now share available
width by intrinsic size; the host badge yields first when space is tight, while
short-name expanded Bots retain readable host labels.
The parent marker intentionally stays subtler than the selected conversation
row in terminal themes; leading disclosures distinguish the Bot hierarchy
without shifting pinned conversations or groups.

Browser coverage: `bot-conversation-folds.spec.ts`, `bot-context-menu.spec.ts`
and `host-source-badges.spec.ts`, Chromium and WebKit: 20 cases passed. The
current-chat hover test was rerun after fixing its sampling of an unfinished CSS
transition; evidence is in `chromium-current.log` / `webkit-current.log`, with
the other nine cases per engine in `chromium-final.log` / `webkit.log`.
The pin/unpin paths were subsequently extended to ensure group focus stays
independent of a folded member Bot; both pin cases passed again per engine
(`chromium-pins.log` / `webkit-pins.log`). Final width allocation and host-label
regressions also passed again in both engines (`chromium-width.log` /
`webkit-width.log`). Covers retained selection/draft, reload/remount, keyboard,
both create entries, unread/attention updates, pin/unpin, offline visibility,
same Bot IDs across hosts, new paired identity, storage denial/corruption,
empty/pinned-only trees, long names with host badges, five palettes in light/dark,
unchanged typography, disclosure hit area and reduced motion. Client translation /
TypeScript / Vite build and standalone build passed.

Evidence: `/Volumes/gdrive/taro-tmp/bot-conversation-fold-20261023`.
Browser validation does not claim installed-App or physical-device acceptance.
This change is a source checkpoint; no App installation or release was performed.
