# Save inline images from their preview

The phone could display an image sent by a Bot, but its full-screen image
viewer exposed only Close. Unlike the document viewer, it provided no native
save or share action. This was a missing entry point, not a failed transfer.

The image viewer now exposes Save to device and Share on Android/iOS, and
Save as on desktop/browser. Both use the existing attachment exporter and its
native receipts. Only a confirmed native write is labelled saved; cancellation,
failure, browser handoff and system share remain distinct. Repeat taps are
blocked during export, including after closing and reopening the same preview.

The exporter receives the exact authenticated Blob used by the preview, without
resizing, screenshotting or re-encoding. Captions are sanitized into filenames
with an extension matching the MIME type. Cached image state is bound to both
connection and attachment ID so a change cannot export the previous image.

The toolbar stays outside the image scrollport and respects shared safe-area
and visible-viewport tokens. Close, Escape, native Back and focus restoration
remain available while saving.

CLI impact: presentation only. Attachment retrieval, authentication, protocol,
engine adapters and host state are unchanged; no new CLI command is required.

Validation covers original-byte browser downloads, native export bridge
receipts, cancellation/failure/retry, share independence, duplicate prevention,
portrait/landscape insets, image scrolling and host-preview isolation.
Native export bridge tests use controlled platform doubles, not a physical
phone. This source change does not install an updated APK or desktop package.

Local results: client translation/type/production build passed; the root
pre-complete build/test gate passed (273 files, 3,588 tests, one skipped);
22 focused Chromium checks passed. The two Android/iOS bridge cases also passed
an additional narrow-English and rotated-layout check after toolbar refinement.
