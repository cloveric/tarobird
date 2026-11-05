# Avatar library additions — 2026-10-25

The four owner-supplied sheets add 81 selectable portraits to the existing
63-entry library, for 144 total. The first three sheets contain nine pastel
animals each; the last contains 54 portraits in a nine-column, six-row grid.
Each character is a separate choice with a stable ID and Chinese/English name.

## Implementation and compatibility

- `client/src/bot-avatar-catalog.ts` appends the entries without reordering the
  existing 63. Automatic Bot identity still hashes into the original 36 entries.
- `client/src/assets/bot-mascots/` contains 81 new transparent 256px lossless
  WebP assets; Vite's existing image import packages them for every client.
  Runtime additions total 2,900,048 bytes; the full library is 5,009,816 bytes.
- Existing saved avatars remain untouched. Selecting a new avatar uses the
  existing revision-checked PNG API, so older clients can display the saved
  image without knowing the new catalog. There is no new Hub/CLI command,
  schema or API: this is a presentation-asset change.
- `assets/bot-mascot-sources/` retains the four original PNGs byte-for-byte,
  edited transparent sheets, crop/hash receipts, and the complete built-in
  imagegen prompt history in `edit-prompts-2026-10-25.json`.
- `scripts/crop-bot-mascots.py` understands both sheet layouts and can package
  selected sheets with `--sheets 8 9 10 11`, leaving existing assets alone.
  Small cells are scaled up proportionally before centering; the prior
  downscale-only packaging made dense-sheet portraits too small and failed
  the existing opaque-pixel coverage check. The assertion was not relaxed.

The picker presents these 81 additions before the existing 63, preserving order
within each set. `AvatarEditorDialog.tsx` keeps this display order separate from
the canonical catalog; keyboard navigation follows the displayed order. The
first new portrait is visible when opening on desktop and phone. No platform
density, modal lifecycle, avatar permission or save logic changes are needed.

## Verification

Evidence directory: `/Volumes/gdrive/taro-tmp/avatar-library-20261025`.

- All 144 asset SHA-256 hashes match their receipts. The original 63 receipts
  and files are unchanged. Packaging decodes every new WebP and verifies
  lossless equality to the normalized RGBA tile.
- All 81 additions were visually inspected on light/dark backgrounds at 92px
  and 32px. Whiskers, ears, antlers, fins, stems and detached parts remain visible.
- Catalog and Hub avatar tests: 6 passed. Client localization, TypeScript and
  production build passed; root `npm run build` passed.
- Chromium: 9 passed; WebKit: 9 passed. The suites cover all 144 decoded
  images and transparent borders, additions from all four sheets, keyboard
  navigation to the last entry, phone widths 320/390, save/sync, revision
  conflicts, uploaded images and restored defaults. Related settings,
  conversation avatars, old-host fallback and cross-host isolation also pass.
- The preceding sidebar/modal repair remains covered: real activity reorders
  the combined list while the picker stays modal, retains its choice and
  geometry, and returns focus correctly after closing.
- Actual UI screenshots: `final-webkit/bot-avatar-library-mascot--3a283-estore-on-desktop-and-phone-webkit/library-{desktop,desktop-dark,phone,phone-dark,phone-320}.png`;
  Chromium equivalents are under `final-chromium/`. Full new-asset inspection
  sheets are `avatars-light.png` and `avatars-dark.png`.

The first diagnostic run found the small dense-sheet sprites described above.
It also inadvertently selected Firefox via `--browser=all`; its nine cases
could not launch because this machine has no Playwright Firefox binary. Final
runs explicitly target Chromium and WebKit, the native-shell browser engines.
Firefox is not counted as verified.

This change does not publish a release or update installed Apps/Host/CLI.
Phone screenshots and touch contexts are browser emulation, not physical
Android/iPhone acceptance.

Display-order follow-up: the 2 catalog tests and all 3 avatar-library browser
cases on both Chromium and WebKit passed after moving the additions first.
Client and root builds passed. Evidence and opening-state desktop/phone
screenshots: `/Volumes/gdrive/taro-tmp/avatar-order-20261025`.
