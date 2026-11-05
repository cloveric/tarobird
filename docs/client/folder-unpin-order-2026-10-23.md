# Folder unpin order — 2026-10-23

Unpin cleared the pin flag but explicitly placed the folder first in the ordinary
section. With no other pins, the row therefore stayed at the top of the list.
The Host had overwritten its former position, so reload could not restore it.
The manager had a second problem: with pending reorder edits, an unpinned row
remained at the front of the draft and Save persisted that position again.

The Host now records ordinary order while pins exist, in private metadata in the
same transactional store. Unpin restores that position. Ordinary reorder changes
replace the ordinary slots while pinned folders retain their restoration slots;
pin-section ordering is independent. Create/delete maintain the complete order,
and removing the last pin discards the private metadata after persisting normal
order. Database reopen, Unfiled, multiple pins and different unpin sequences use
the same path. API payloads, capabilities and schema version remain unchanged.

The manager restores the unpinned row's canonical ordinary rank and preserves
the relative order of other pending rows. Existing revision checks continue to
require reloading after a concurrent device change. Folder assignments, selected
chats, drafts and Bot sessions are unaffected.

Compatibility: old pins with no valid restoration metadata return to the end
of the ordinary section. Already-unpinned folders are not moved on upgrade;
their former position was never recorded. Users can arrange those once in
Manage folders. The repair does not infer or rewrite live user ordering.

CLI parity: `folders pin ID --enabled off --revision N` and its `--unfiled`
variant use the repaired shared Host API. `folders list` reports the same
canonical order as the App. Help and the CLI guide describe restoration and
the legacy fallback; no separate command or public metadata is needed.

Validation evidence is stored in
`/Volumes/gdrive/taro-tmp/folder-unpin-order-20261023/`.
Both regressions were first observed failing: the Host returned the formerly
pinned row at index zero, and the browser manager retained it before pending
peer moves. The corrected Host checks and new desktop/phone browser journeys
pass. Final validation:

- 85 checks passed across Hub folders, authenticated CLI, CLI entry, Hub server
  and handshake metadata. Coverage includes persistence, multiple pins, legacy
  and malformed restoration state, ordinary reorder and removal order.
- WebKit: all 22 conversation-folder journeys passed, including the two new
  desktop/phone unpin journeys. Their restored-list screenshots were inspected.
- Chromium: all 47 journeys passed across conversation-folders, sidebar-layout,
  mobile-conversation-actions and mobile-im. This includes cross-host targeting,
  socket/cache recovery, concurrent updates, drafts and saved layout choices.
- Client translation/type/production build and standalone Host build passed.
  The compiled CLI help includes restoration and the legacy fallback. Staged
  secret scanning and whitespace checks passed.

This is a source change. No installed App, published CLI, or live Host was
replaced or restarted. Browser phone layouts do not establish physical-device
acceptance. There is no model behavior change or paid model run.
