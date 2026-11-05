# Mascot source and cutout sheets

`original-1.jpg` through `original-4.jpg` are byte-for-byte copies of the four
owner-supplied sheets. File extensions are retained from the supplied filenames;
image decoders detect the actual format. `cutouts-1.png` through `cutouts-4.png`
are RGBA background-extraction edits made with the built-in imagegen tool and
`transparent_background: true`. The full edit prompt and packaging explanation
are in `client/src/assets/bot-mascots/README.md`.

These source files are for reproducibility and are not imported into the app.
`scripts/crop-bot-mascots.py` produces the 145 runtime WebP images and
`crop-receipt.json` with crop coordinates, output byte counts and SHA-256 hashes.
The source files and generated cutouts were inspected in light/dark rendered UI.

## Additions on 2026-10-18

Three additional owner-supplied PNG sheets are preserved byte-for-byte:

| Source | Original filename |
| --- | --- |
| `original-5.png` | `3d7eed75-423b-4208-ab8b-7cb5c8546b8d.png` |
| `original-6.png` | `fc6d6258-37b6-4c6d-b9f2-8c0eeb352ce1.png` |
| `original-7.png` | `5663d25a-668b-453f-94b7-455c25ae7570.png` |

`cutouts-5.png` through `cutouts-7.png` are built-in imagegen edits using
`transparent_background: true`. The exact prompt is in
`edit-prompt-2026-10-18.txt`. The existing script packages these 27 designs after
the original 36; the old assets and default identity assignment remain unchanged.

## Additions on 2026-10-25

The four supplied `image.png`, `image-2.png`, `image-3.png`, `image-4.png` files
are preserved byte-for-byte as `original-8.png` through `original-11.png`.
`cutouts-8.png` through `cutouts-11.png` are built-in imagegen RGBA background
extraction edits; prompt history is in `edit-prompts-2026-10-25.json`. The first
three contain nine portraits each. The last contains 54 portraits in a 9x6 grid.
The existing catalog's 63 entries/assets remain unchanged; 81 entries are appended.

## Addition on 2026-11-04

`original-12.png` is the GPT Image output for the TaroBird phoenix avatar, on a
flat gray background (prompt: `generation-prompt-2026-11-04.md`).
`cutouts-12.png` is its transparent cutout from
`python3 -I scripts/cutout-flat-background.py original-12.png cutouts-12.png`,
not an imagegen edit. It is packaged as sheet 12, a 1 × 1 layout.
