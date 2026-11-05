# TaroBot animal portraits

63 portraits cropped by script from seven JPEG sheets supplied by the project
owner on 2026-10-12 (the two crocodiles are separate styles). No generative editing
or redrawing is used. No additional license/authorship claim is inferred from
the filenames; these are not third-party app branding.

Legacy assets retained for reproducibility. `assets/bot-avatar-sources/catalog-v1.json`
freezes this original order. The active default library now uses transparent
mascots in `client/src/assets/bot-mascots/`; these animal assets are no longer bundled. The crop
rectangles match the previous sheet view, followed by one Lanczos resize.
Vite fingerprints the portraits and includes them in the offline shell, desktop
and Android builds. The 63 portraits total 3,716,936 bytes (3.54 MiB), down 71.6%
from the original 13,076,733 bytes (12.47 MiB). Original JPEGs are preserved
byte-for-byte in `assets/bot-avatar-sources/`, outside the runtime asset tree.

Regenerate from the repository root with Python 3 and Pillow (WebP enabled):

```sh
python3 scripts/crop-bot-avatars.py
```

The script validates all source dimensions and round-trip pixels after lossless
encoding. Optional `--preview /absolute/path/contact-sheet.png` produces a visual
inventory outside the runtime bundle. Generated with Pillow 12.2.0; encoding bytes
may vary across Pillow/libwebp versions. The original source sheets remain the
source of truth, and generated assets are committed so builds need no Python.

When a user selects a portrait, the existing avatar editor produces a 256 × 256
PNG and saves it using the Hub's authenticated, revision-checked avatar API.
Restoring the default removes only that override, not any Bot or chat data.

Source sheets in order:
1. Gemini_Generated_Image_yv1cmoyv1cmoyv1c.jpeg
2. Gemini_Generated_Image_l7cac9l7cac9l7ca.jpeg
3. Gemini_Generated_Image_1tkqyi1tkqyi1tkq.jpeg
4. Gemini_Generated_Image_o0zu4uo0zu4uo0zu.jpeg
5. Gemini_Generated_Image_9xl97w9xl97w9xl9.jpeg
6. Gemini_Generated_Image_beer92beer92beer.jpeg
7. Gemini_Generated_Image_rclot8rclot8rclo.jpeg
