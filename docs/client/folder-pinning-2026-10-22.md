# Pinned conversation folders — 2026-10-22

Desktop folder headings (right-click / Shift+F10), phone headings (long press),
and each folder's More action in Manage folders now offer **Pin folder / Unpin**.
A small pin beside the heading identifies pinned folders. Unfiled can also be
pinned. This is list ordering, not a sticky header when scrolling.

Newly pinned folders go first. As of the 2026-10-23 repair, unpin restores the
folder's ordinary position instead of leaving it at the front of that section.
Move up/down, Home/End and pointer dragging stay within the
pinned or ordinary section; multiple pinned folders can be reordered. Existing
Move to top remains available within that section. A repeated explicit pin value
does not unexpectedly move an already pinned folder back to first.

Pin changes save immediately, like rename/create. Pending manager order remains
local until Save; successful local edits preserve it, partitioned pinned-first.
Unpin inserts the returning row at its restored ordinary rank while keeping
other rows' pending relative order.
Concurrent device revisions require loading the latest state. A lost HTTP receipt
refreshes state and displays the uncertain result; it does not replay the change.
Offline changes and older hosts without the new capability are disabled with an
explanation. No conversation selection, draft, assignment or Bot session changes.

`pinnedFolderIds` is additive, optional, user-and-Hub-scoped metadata in the
existing transactional store; `null` means Unfiled. Pins follow existing signed
HTTP authentication, queued device validation, revision checks, socket updates
and cache recovery. Delete removes the pin. Old clients see the persisted
pinned-first order; old reorder requests cannot move ordinary folders above pins.
There is no schema migration, new dependency, timer, polling or model prompt.
Multiple hosts retain their own folder order; this does not pin a whole host
above another host's section.

The Host now retains a private `unpinnedOrder` in the same transactional JSON
while any pins exist. Ordinary reorder edits replace only ordinary slots;
pinned slots retain their restoration positions. Pin order is independent.
Creation/deletion keep that saved order complete; it is removed after the last
pin clears. It is not exposed on the public API. Legacy pins lacking a valid
saved order return to the end of the ordinary section when unpinned. Already
unpinned folders are not moved on upgrade: their former position was not saved.
See [the regression and repair](folder-unpin-order-2026-10-23.md).

Headless parity: `folders list` returns the same state, revision and display
order; `folders pin ID --enabled on|off --revision N` uses the same PATCH API.
Use `--unfiled` instead of ID for the system folder. Stale writes fail rather
than automatically rebasing; after a lost receipt use `folders list` to inspect
the current state. The local controller edits its authenticated user's folders.

Validation at initial introduction (2026-10-22):

- 66 tests passed across Hub folders, real authenticated CLI entry, CLI guards
  and Hub server regressions. Coverage includes persistence, user isolation,
  unknown IDs, revoked devices, stale/concurrent edits, legacy reorder and pin
  cleanup without changing assignments.
- Chromium: all 45 distinct journeys in conversation-folders, sidebar-layout,
  mobile-conversation-actions and mobile-im passed across the full run plus a
  focused rerun. The initial new fixture shut the isolated Hub down after the
  phone socket update, before the desktop save receipt closed its dialog. The
  fixture now waits for the dialog to close; the corrected journey passed.
- WebKit: all 20 conversation-folder journeys passed. New coverage exercises
  desktop right-click / keyboard, phone hold, multiple pins, keyboard/pointer
  sorting boundaries, pending manager order, cross-device sync, reload, drafts,
  offline/old-host gating and lost receipts without duplicate mutations.
- Client translation/type/production build and standalone host build passed;
  the compiled CLI help contains both custom-folder and Unfiled commands.
  Staged secret scanning and diff whitespace checks passed. Light desktop and
  dark phone screenshots were inspected and delivered in the App conversation.
- Evidence: `/Volumes/gdrive/taro-tmp/folder-pin-20261022/` (final pin journey in
  `chromium-pin-final`, broad browser runs in `chromium` / `webkit`).

The installed App and published CLI are not replaced by this source change.
No native desktop or physical phone installation was performed. There is no
model behavior change to validate with a paid model run.
