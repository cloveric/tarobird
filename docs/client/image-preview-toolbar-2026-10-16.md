# Phone image preview toolbar — 2026-10-16

The reported phone preview put three large text buttons above the picture,
while its translucent backdrop let the underlying chat header show through.

The viewer now has an opaque charcoal surface. A single 52px toolbar places
close on the left, an ellipsized picture name in the middle, and save/share on
the right. Phone and touch layouts show small icons with 44px touch targets;
desktop keeps the save/share labels. Screen readers retain the original action
names, and keyboard tab order follows the visual order. Long names cannot wrap
the controls to another row. Safe insets are reserved once around the viewer.

The picture area extends to the safe left/right edges. Original proportions,
long-image scrolling, native Back/Escape, thumbnail focus restoration, save
receipts and original-byte sharing retain their existing behavior. Long export
feedback scrolls within a bounded area rather than taking over the reader.

CLI impact: not applicable; this changes the client preview layout only. Host
APIs, attachment bytes/storage and headless commands do not change.

Release boundary: source/UI change, not an installed APK update. Browser native
export fixtures simulate Android/iOS plugin receipts; they are not physical
device validation. Evidence is stored under
`/Volumes/gdrive/taro-tmp/tarobot-image-preview-20261016`.

Validation completed: client translation/type/Vite build passed. Chromium and
WebKit each passed 17 browser scenarios across `image-export`, `message-images`,
`attachment-message-actions`, `host-previews` and `safe-area`. The newly included
WebKit export fixtures first exposed their macOS keyboard-navigation assumption;
using Option+Tab, consistent with the existing settings fixtures, passed both
cases on recheck. Production keyboard handling did not change.

A 390px preview with a representative screenshot was rendered and visually
reviewed. Its toolbar measures 52px, the controls retain 44px touch targets,
and the viewer background is fully opaque. Narrow 320px, landscape, original
download bytes, save/share receipts, cancellation, errors and Back/focus paths
are covered by the browser scenarios. No new host/CLI code or protocol changes.
