# Transparent mascot avatars

The historical v2 catalog contains 144 owner-selected mascot designs: the original 36
from 2026-10-12, 27 additions from 2026-10-18, and 81 additions from four sheets
provided on 2026-10-25. Each shipped file is a 256 × 256 RGBA, lossless WebP.
On 2026-10-26, 21 circled choices were retired, leaving 123 in the active library.
Their assets remain packaged for existing Bot defaults and old clients.
On 2026-11-04 the TaroBird phoenix (`pastel-phoenix`) was appended as entry 145,
so 124 are active. The full library totals 5,042,010 bytes. Vite fingerprints the files
and packages them for browser, offline, desktop, Android and iOS clients.

Built-in `imagegen` performed background extraction for each sheet with
`transparent_background: true`; this is an image edit, not an assertion that the
cutout pixels are identical to the original JPEG artwork. The unmodified
inputs and edited RGBA sheets are in `assets/bot-mascot-sources/`. No API keys,
external credentials or remote image dependencies are used.

The user-authorized script workflow splits the first ten sheets into nine portraits each,
and the final sheet into 54 portraits (nine columns, six rows),
finds the visible bounds, and centers them with a 12px minimum transparent inset.
It preserves all edited RGBA pixels apart from one aspect-preserving resize.
It does not flatten backgrounds or recolor the mascots. The alpha threshold is
used only to find crop bounds and gutters. Lossless output is decoded and checked
byte-for-byte. A crop/hash receipt is saved alongside the source sheets.

```sh
python3 scripts/crop-bot-mascots.py
```

`bot-avatar-catalog.ts` fixes the reading order (sheet 1 to 11, row by row). The
original v2 replacement changed automatic v1 animal defaults to mascots; the
2026-10-18 additions do not change that mapping. Bot IDs still select from the
first 36 entries for legacy Bots without persisted defaults. The first Bot on a
fresh Host gets `pastel-fox`; later Bots sample the active pool. Explicit
selection and shuffle use that same active set. `RETIRED_BOT_AVATAR_IDS` in the
shared catalog lists the excluded choices; neither catalog order nor WebP files
are removed. See [assignment and retirement](../../../../docs/client/bot-avatar-defaults-2026-10-25.md).
Existing saved PNG overrides,
including uploaded photos and explicitly saved older library choices, are not
rewritten. Selecting a mascot saves a transparent PNG through the same revision-
checked Hub API; older clients can display that image without a Hub migration.

The 27 additions contribute 933,088 bytes to the runtime library. The first 36
WebP files are unchanged byte-for-byte. New original PNGs, edited sheets and the
slightly extended extraction prompt are retained in `assets/bot-mascot-sources/`.
These are presentation assets: no new CLI command, protocol or host migration is
needed. Desktop and mobile use the same picker and existing avatar API.

## 2026-10-18 verification

- Original 36 crop receipts and asset hashes are unchanged. All 63 WebP files
  pass the script's lossless RGBA round-trip verification.
- Inspected all 27 additions on white and dark backgrounds at 94px, 32px and
  24px, plus the actual desktop picker and 320px/390px phone layouts.
- Catalog/Hub/avatar/backup tests: 66 passed. Client translations, TypeScript
  and production build passed.
- Chromium and WebKit each passed 18 related browser checks, including all 63
  decoded transparent images, selecting additions from all three sheets,
  keyboard navigation, saved PNG sync, revision conflicts, restored defaults,
  conversation avatars, Bot creation and offline recovery.
- The existing first-view JavaScript budget check fails on both engines:
  911,135 bytes versus its 700,000-byte limit. An isolated build of the unchanged
  parent commit also fails at 907,483 bytes. This addition contributes 3,652
  bytes of names/URLs/translations; it does not introduce the existing overrun.
  The limit was not relaxed and the startup optimization remains outstanding.
- This change was not released or installed on physical devices; browser
  phone-size checks are not Android/iOS device acceptance.

## Built-in image edit prompt (one invocation for each original sheet)

> Use case: background-extraction. Edit target: the supplied 3 by 3 sheet of nine distinct pastel TaroBot mascot avatars. Remove ALL nine rounded-square pastel background tiles, the outer white/black background, and the flat oval ground shadows. Keep ONLY the nine mascot silhouettes with their eyes, head ornaments, original colours, subtle highlight/shading, proportions and exact identities. Do not invent or redesign any character. Preserve every disconnected character part such as the orbiting small moon. Deliver one square RGBA transparent PNG sprite sheet with exactly 3 columns and 3 rows, keeping the same original reading order. Each mascot must be entirely inside its own equal square cell with a generous transparent margin on every side; center it within that cell, never overlap cell boundaries. Actual alpha transparency everywhere outside the mascots, including the holes between ears and planetary rings. No tile, badge, frame, backdrop, checkerboard pixels, text or outline. Keep the pale cream mascots fully opaque and visible, do not mistake their bodies for background. These cutouts will be cropped into nine separate avatars and used on both white and black app backgrounds.

## 2026-10-25 additions

Four owner-supplied PNGs add 81 individually selectable designs: 27 pastel
animal portraits and 54 mini animal, sea-life, bird, nature, fruit and food
portraits. IDs and Chinese/English labels follow source reading order; the dense
sheet is nine columns by six rows, read left to right across each full row.

Runtime additions total 2,900,048 bytes. The original 63 WebP files and crop
receipts remain unchanged, as does the first-36 default identity mapping.
The built-in imagegen tool extracted transparent backgrounds; its prompt set
is retained in `assets/bot-mascot-sources/edit-prompts-2026-10-25.json`.
The packaging script only crops, resizes and centers the edited RGBA artwork.

```sh
python3 scripts/crop-bot-mascots.py --sheets 8 9 10 11
```

Selecting an addition uses the existing revision-checked PNG save/sync path.
There are no Host/CLI commands, API changes, migrations or new online image
dependencies. Native installation/release is outside this asset update.
Verification details are recorded in `docs/client/avatar-additions-2026-10-25.md`.

## 2026-11-04: `pastel-phoenix` (小凤凰 / Little Phoenix)

The owner asked for the TaroBird phoenix as a system avatar in the library
style. It was generated with GPT Image through the Codex CLI, from a style sheet
of four existing avatars (`pastel-chick`, `amber-flame`, `mini-bluebird`,
`pastel-fox`) and the brand phoenix as the character reference. The owner chose
the simplest of three candidates: orange round body, cream belly, one red-gold
flame crest, a yellow beak and one thin tail tipped with a light-purple flame.

- `assets/bot-mascot-sources/original-12.png` is the unmodified generated image
  on flat gray. `generation-prompt-2026-11-04.md` is the exact prompt.
- `cutouts-12.png` was made by `scripts/cutout-flat-background.py`, a
  colour-distance background removal, not by imagegen. It reproduces
  byte-for-byte from the original.
- Sheet 12 is a 1 × 1 layout, packaged with the same crop script
  (`python3 scripts/crop-bot-mascots.py --sheets 12`, 32,194 bytes). Existing WebP
  files and receipts are unchanged.
- The entry is appended after the historical 144. The first-36 legacy mapping
  and the pinned hash of the 144 ordered IDs are unchanged. The picker lists
  entries after 144 first, so the phoenix is the first tile. It joins the active
  pool used for Host assignment and shuffle; the first Bot on a fresh Host still
  gets `pastel-fox`.
- Its eyes are detected for animated avatar states. The browser test
  `avatar-agent-state` asserts this for both the fox and the phoenix.
