# Compact thumbnails for sent pictures

Client 1.0.55 displays user-uploaded pictures as small chat thumbnails on phone
and desktop. Ordinary single pictures preserve their aspect ratio within
180 × 200 CSS pixels. Very long pictures use a 160 × 180 top crop with the
existing long-image indicator. Multiple pictures use a two-column, at-most-280px
gallery with 112px-high tiles. Text stays with its pictures.

Uploaded filenames no longer take a separate visible line; the image's accessible
name and hover title retain the filename. Bot-authored image captions retain
their existing presentation. Clicking a thumbnail still opens the full original,
including the scrollable full-width reader for long pictures. Existing history
uses the same layout immediately without rewriting messages or attachments.

## Validation

- Before the change, the new width check reproduced a 295px thumbnail at a
  390px viewport. The new layout stays within the explicit thumbnail bounds.
- Chromium and WebKit each passed three expanded image workflows at 320, 390
  and 1360px, plus four existing attachment action/media workflows. They cover
  actual upload/send, long/portrait/square/landscape images, captioned and
  image-only sends, galleries, mono/CLI/pixel styles, original-image viewing,
  Escape/Back, focus restoration, quoting and forwarding. The expanded fixture
  waits for the named sent image instead of accidentally reading the previous
  message while the upload is completing.
- Bot-authorized downloads are byte-identical to the original ordinary-image
  uploads. No downsampling is introduced in the send or storage path.
- Rendered phone screenshots were inspected. Root/client builds and Android
  release compilation, unit tests and lint passed.
- The signed Android 1.0.55 APK uses version code 2026101310, the same application
  ID and certificate as 1.0.48. All 378 frontend files match the tested build
  (with the established native CSP adjustment); all 380 packaged public assets
  match the native copy. Launcher resources and package identity were checked.

Android and Apple Silicon Mac installers are built locally. This verification
does not claim a physical-phone interaction test or replace an installed App.
