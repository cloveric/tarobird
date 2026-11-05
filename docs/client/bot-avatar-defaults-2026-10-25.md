# Default Bot avatars and active library

The first Bot created on a fresh Host receives **橙尾狐 / `pastel-fox`**.
Subsequent Bots receive a random default from the shared active library
(currently 123 selectable portraits, including the fox; 144 historical IDs).
Previously only the original 36
portraits could be assigned automatically, although the manual picker and
shuffle already used the full library.

## Assignment and persistence

After inserting a new Bot, the Host checks for any other row in `bots`, including
soft-deleted rows. No other row means the first Bot gets the fox; otherwise it
uses `randomInt(SELECTABLE_BOT_AVATARS.length)`. The chosen stable avatar ID is stored under
`bot-avatar-default:v1:<botId>` in the existing SQLite `meta` table. This
happens in the same transaction as Bot creation. Retries return the original
choice. Renaming, restarting, backup/restore and future catalog additions do not
reroll it. Different Bots may receive the same portrait; uniqueness is not
promised.

The first-Bot rule was added on 2026-10-26. It is scoped to the Host's existing
database, not a browser or phone. Upgrading or reinstalling while retaining Host
data does not reset it. An explicit fresh-install reset that replaces the Host
data directory creates a new database and therefore a new first Bot. Deleting
all visible Bots does not reset it; tombstones remain. Creation rollback does
not consume it.
Concurrent creation is serialized by the same database transaction. A separate
new Host gets its own first fox. Existing Bots, including unassigned legacy Bots,
are never migrated. Manual image overrides continue to take precedence.
No schema, protocol or extra first-install flag is needed.

The shared catalog lives in `src/client-protocol/bot-avatar-catalog.ts`; the
frontend module re-exports it and keeps the legacy fallback and shuffle helpers.
The image crop script reads the historical catalog. All 144 IDs retain their order
and packaged assets. The picker and both random paths exclude retired IDs; other
choices retain their display order. Avatar size, theme and pixels are unchanged.

## Retired choices (2026-10-26)

The owner's circled 21 choices are removed from the picker, its “换一个” shuffle,
and new Bot assignment. `RETIRED_BOT_AVATAR_IDS` defines the exclusion list;
`SELECTABLE_BOT_AVATARS` is the shared random pool and `BOT_AVATAR_LIBRARY` is the
same set in newest-first display order. Display reordering happens **before**
filtering, preserving the original source-sheet split.

| Original overview number | Stable ID |
| --- | --- |
| 073 | mini-sprout |
| 084 | pink-bunny |
| 085 | blue-cloud |
| 087 | jade-drop |
| 092 | mint-sprout |
| 094 | lilac-horns |
| 098 | cream-mochi |
| 099 | violet-moon |
| 100 | pink-mushroom |
| 102 | lavender-planet |
| 110 | clover-leaf |
| 114 | peach-crown |
| 121 | violet-imp |
| 123 | mint-curl |
| 124 | rose-butterfly |
| 125 | ivory-puff |
| 126 | blue-curl |
| 133 | lilac-shell |
| 137 | violet-peak |
| 140 | lilac-planet |
| 141 | coral-flame |

These are display numbers from the original 144-item overview, not canonical
catalog indexes. Historical `BOT_AVATARS`, `botAvatarById`, WebP assets, translated
names and crop receipts remain intact. Persisted retired defaults and unassigned
legacy Bots keep their existing portraits. The editor shows a retired current
portrait in its preview with no selected grid tile; keyboard entry starts at the
first available choice. Removing a custom image still restores that Bot's stored
default, including a retired one. No existing Bot is rerolled or migrated.

## App, CLI and compatibility

App creation and `tarobot bots create` use the same BotManager assignment. The
offline maintenance registration path assigns through the same helper. The
authenticated Bot directory and CLI expose optional `defaultAvatar`; the App
stores it in the existing Bot directory cache and uses it for lists, messages,
settings and restoration after removing a custom image.

Existing Bots without a stored assignment retain their previous ID-based
36-portrait fallback. Saved/uploaded PNG avatars remain authoritative. No Bot
identity, routing ID, saved picture, database schema or creation request format
is migrated. Old Hosts omit the field; old clients ignore it and keep their old
fallback. Seeing the new assignment consistently therefore requires updated
Host and client versions. Unknown future IDs also fall back without breaking
rendering.

Older Apps still offer their original library; older Hosts still assign from
their original pool. Mixed versions remain compatible because IDs and images
are retained and explicit image selections are saved as PNG overrides. Both
Host and client must be updated to apply the exclusion list to every new choice.

Phone and desktop avatar providers receive their owning Host's cached Bot
directory. Regression testing caught and corrected a phone-only cold-offline
path that initially reverted to the legacy portrait.

## Verification

### Retired choices follow-up (2026-10-26)

- 71 focused tests pass across catalog, assignment, managed creation, avatar
  storage, backup/restore and CLI management. The 14 catalog/assignment tests
  also pass after adding the ordered historical-ID hash assertion.
- Tests exercise all 123 Host random indexes, every shuffle index with active
  and retired current choices, all 21 persisted retired defaults, first-Bot fox,
  concurrency, rollback and deletion/restart behavior.
- Chromium 5/5 and WebKit 5/5 pass. Both verify the exact active grid, a retired
  default's preview and keyboard entry, transparent PNG save, cross-device CAS,
  restoration, offline reload and nested modal stability. Screenshots cover
  desktop, 390px and 320px phone layouts, including light and dark modes.
- Host and frontend builds pass. This is source/browser verification; no
  production database changes, device installation or release was performed.
- Opus 5.5 xhigh independently matched the 21 circled cells to their assets,
  reviewed the final diff with no blocking findings, reran the 14 core tests
  and type-checked those tests and their dependencies. Its independent catalog
  comparison also confirmed that all 144 historical entries are byte-for-byte
  unchanged. Browser results above were run by the implementing agent.

### First-Bot fox follow-up (2026-10-26)

- 68 focused tests pass, including first creation without a random draw, every
  later catalog index (including the fox), transaction concurrency and rollback,
  deletion/restart, independent Hosts, legacy identity, live CLI, offline CLI,
  managed creation/retries and backup/restore.
- Chromium 8/8 and WebKit 8/8 pass. Real App creation flows check the fox on
  desktop and 390px phone layouts; existing custom-image synchronization,
  restoration and offline-directory tests remain green.
- Host and frontend builds pass. No production data, installation or release
  action was performed. These UI checks use browsers and fixture workers, not
  physical phones or live model inference.
- Independent Opus 5.5 xhigh review found no blocking issue and separately
  reran the 8 assignment tests successfully. Its documentation clarification
  about explicit fresh-install resets is incorporated above.

### Full-catalog assignment (2026-10-25)

- 117 distinct focused tests passed across catalog, assignment, Bot creation, avatars,
  CLI management, backup/restore, Hub and protocol suites. Each of the 144
  possible random indices is exercised deterministically; tests also cover
  retry/restart persistence, creation rollback and untouched legacy identities.
- Host build and client translation/type/build checks passed.
- Chromium 5/5 and WebKit 5/5 browser flows passed, covering desktop and 390px
  phone layouts, cold offline reload, current and legacy defaults, custom image
  synchronization/restoration, modal stability and an unavailable editor chunk.
  These are browser checks, not a new native-device acceptance run.
- An additional root `tsc --noEmit` including all tests reports 117 existing
  diagnostics. The frozen 1.0.112 baseline reports the same 117 after normalizing
  worktree paths and line numbers; this optional command is not claimed green.

Evidence: `/Volumes/gdrive/taro-tmp/avatar-all-defaults-20261025/`.
This change has not been packaged or installed on the owner's devices.
