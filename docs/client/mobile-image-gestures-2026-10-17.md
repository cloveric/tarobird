# Mobile image browsing and zoom — 2026-10-17

The reported behavior was reproducible: each attachment opened its own isolated
preview, with neither a list of sibling images nor touch gesture handling.
Swiping did not change the picture, and double tapping left its size unchanged.

## Behavior

- A preview browses authenticated image attachments from the same persisted
  message, in display order. This includes native image blocks and captioned
  card galleries. It does not include quoted messages, adjacent messages, file
  blocks or external Markdown image URLs. Repeated attachment IDs appear once.
- At fit size, horizontal swipes select the previous/next image. A compact
  counter and arrow buttons expose the position and boundaries. The first and
  last images do not wrap into another message.
- Double tap toggles fit size and 3× zoom around the tapped point. Pinch zoom
  supports 1–6×. At zoomed size, dragging pans the current image instead of
  switching pictures. A reset/zoom button offers the same action without a
  gesture; desktop pointer double clicks also use this path.
- Long images retain vertical reading at fit size. Vertical movement,
  cancelled pointers and multi-touch do not advance the gallery. Selecting
  another image resets zoom and scroll position.
- The existing dark toolbar, safe insets, Back/Escape, keyboard focus trap and
  return to the clicked thumbnail remain. Desktop left/right arrows navigate
  at fit size and pan when zoomed. Focusing the reader on pointer input also
  restores keyboard navigation after a save temporarily disables its button.
  The dialog owns each Tab step because Safari can skip buttons with plain
  Tab; boundary-only trapping allowed focus to escape past the reader once
  footer controls were added. The existing attachment-action tests caught
  this regression on WebKit at both phone and desktop widths.
- Save/share exports the selected picture's authenticated original bytes and
  filename. The opener's Blob is reused instead of downloading it again.
  Pending export locks survive closing/reopening the preview, and receipts
  remain tied to the exported image when browsing continues.

`Content.tsx` supplies the message-scoped `ImageGalleryContext` from
`image-gallery.ts`. `AttachmentImage.tsx` owns the thumbnail, selected image and
export operation; `ImagePreview.tsx` owns the modal and gesture state.
`use-attachment.ts` can disable its secondary fetch when the opener already
owns the original. The image itself remains an `<img>`; zoom does not create
an encoded or resized export copy.

## Verification and limits

The new browser tests first failed against the previous client build for both
reported behaviors. After the fix, Chromium and WebKit pass the gallery and
zoom scenarios, including the selected image's original download bytes,
message boundaries, long-image scroll, pointer cancellation, pinch/pan,
reset, keyboard navigation and focus restoration.

- Root unit suite: 321 files, 4,201 passing tests, one pre-existing skip.
- Client translation check, TypeScript and production Vite build: passed.
- Browser regression: 54 distinct scenarios across `image-gallery`, `image-export`,
  `message-images`, `media-thumbnails`, `file-preview-fullscreen` and
  `media-preview-drag`, plus `attachment-message-actions`, `host-previews` and
  `safe-area`, on Chromium and WebKit. After fixing the Tab regression, all 22
  scenarios in `image-gallery`, `image-export` and `attachment-message-actions`
  passed again against the final client build.
- Rendered phone gallery and narrow native-export toolbar screenshots were
  reviewed; existing regressions also cover 320px, 390px, desktop and rotation.

Chromium swipe/pinch tests use trusted browser touch input; WebKit uses
dispatched pointer sequences for these gestures. Double taps use Playwright's
touchscreen input on both engines. Android/iOS export tests stub native plugin
receipts. These are browser checks, not physical Android or iOS validation.
No Android device was connected during this task, and no APK was installed.
Evidence: `/Volumes/gdrive/taro-tmp/tarobot-image-gestures-20261017`.

CLI impact: not applicable. This changes client image interaction only, with
no new host capability, permission, protocol, attachment storage or CLI command.
This source change is not itself an App release or an update of an installed
phone App.
