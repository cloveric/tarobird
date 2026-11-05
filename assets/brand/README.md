# TaroBird phoenix identity

On 2026-11-04 the owner replaced the fox with a chubby sitting **phoenix**, as
the first step of renaming the project to TaroBird (App text, packages and
identifiers are separate changes). The phoenix was generated with GPT Image
in the flat style of the former fox, as a new character rather than a copy;
the owner then asked for the lower tail flame to be light purple, which was a
pixel recolour of that one flame. `brand-identity.json` records the hashes.
`phoenix-art.png` is the approved 1254 × 1254 artwork with its flat warm-gray
background removed by colour distance (no rescale, no redraw).
`phoenix-cutout.svg` only frames its square close-up; the rendered
`tarobot-tray-master.png` is the 1254 × 1254 RGBA scene/banner master. The
retired fox sources remain in git history.

## Reproduce

```sh
npm ci --prefix client
node scripts/generate-app-icons.mjs
python3 scripts/verify-release-icons.py --source
node scripts/render-brand-preview.mjs /absolute/evidence/directory
```

Generation uses the pinned Tauri CLI; verification requires Python and Pillow;
the contact sheet uses the client's Playwright Chromium. Use the external-disk
build environment on the owner's Mac.

## Platform treatment

- On 2026-11-04 the owner switched `launcher-art.png` to the archived
  `alternates/phoenix-lean.png`: the phoenix leaning into a close-up with a
  light-purple lower tail flame. The approved file is copied byte-for-byte and
  pinned separately under `brand-identity.json.launcher`; its surrounding
  warm-gray motion field uses #e3dbd5.
  `app-icon.svg` scales this opaque square to `tarobot-master.png` for iOS,
  favicon and touch icon. iOS supplies the corners.
- `macos.svg` supplies the macOS outer tile and transparent margin. ICNS entries
  are sorted without altering encoded images for deterministic regeneration.
- Windows `windows.svg` supplies rounded corners and a small transparent outer
  margin. `tarobot-windows-master.png` generates ICO and default Tauri PNGs,
  including the Windows taskbar/window and notification-area tray icon.
  ICO contains 16/24/32/48/64/256px frames; verification checks alpha against
  this tile (rejecting the retired cutout) and final RT_GROUP_ICON 32512 bytes.
- Android maps the artwork to its central 72dp viewport within the 108dp
  foreground, with an opaque warm-gray field for launcher motion. Both eyes
  are inside the guaranteed 66dp safe circle. The close-up reaches the image
  edges, so its outermost pixels extend into the motion field to avoid visible
  seams during launcher movement. The central approved composition stays
  unchanged. Round/square legacy and adaptive icons share the new artwork.
  Android 13 monochrome icons and notifications still use the retired fox
  silhouette `fox-monochrome.svg` until a phoenix glyph is drawn.
- `tray-macos.svg` is a separate line-style bird alpha mask: body outline with
  beak and short level tail, an eye dot and one full wing, without feet. It is generated at 36px and
  displayed at 22pt in template mode. AppKit supplies light/dark/selected-state
  colours. Keep its edits scoped to the Mac status item.
- iOS launch uses the phoenix at 2× (256px) and 3× (384px), preserving the existing
  112pt layout; App scenes use the 256px mark. Android's actual launch theme
  uses the adaptive launcher directly. The source verifier checks the activity,
  theme and launcher wiring; unreferenced legacy splash PNGs are retired.
- Main/ADHD/Agent Bus sidebar names are **text only**. Welcome, pairing, loading
  and recovery show the phoenix. CLI-style scenes reuse `fox-monochrome.svg`. Personal
  Bot avatars, theme palettes, identities and platform sizing are unchanged.

`generated-icons.json` records every output and hash. The source checker verifies
coverage, alpha, iOS launch parity, Android launch wiring and themed icons; package modes inspect
final artifacts. Regenerate instead of editing individual output PNGs. If upgrading the pinned
Tauri CLI changes rasterized bytes, visually recheck the selected identity and
platform masks before updating the recorded cutout hash and generated manifest;
do not bypass the identity guard. Fully transparent canvas edges are enforced.
Very low-alpha pixels inside the gutter are invisible at delivery sizes; this
pipeline uses fixed canvases and never derives icon size from an alpha>0 trim.

For an asset-only preview that does not rewrite the GitHub cover, pass
`--icons-only` to `render-brand-preview.mjs`. Preview PNGs are renderings of
generated resources, not evidence of installation or physical-device behavior.
This launcher change is CLI-not-applicable: no Host/CLI behavior, schema,
settings, App theme, avatar selection or notification delivery changes.

## GitHub

Current English/Chinese README covers, UI captures and demos are refreshed
separately. `assets/github-banner.svg` and its PNG are the current social cover;
the earlier watercolor artwork is no longer a dependency. Historical design
and audit screenshots remain historical evidence. Capture provenance is in
`assets/product/README.md`.

On 2026-10-25 the private repository's Settings page has no Social preview
control, and no custom Open Graph image is configured. The new cover is ready;
repository visibility and the personal account avatar are unchanged.
Source changes do not update installed applications.
