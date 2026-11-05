# Desktop video preview dragging

The video preview previously stayed centered because its header had no drag
handler. Sent and unsent draft video previews now attach the existing desktop
`useDialogDrag` behavior to their inner `.file-preview` section through the
shared `AttachmentPreviewHeader` ref. The outer modal/backdrop stays fixed.

Drag the filename or empty header space with the primary mouse/trackpad button.
Save/close buttons and the video/player controls retain their own interaction.
Dragging changes panel translation only, preserving the same media element,
object URL and playback state. The shared helper keeps the panel reachable
inside the viewport, reclamps on resize, and clears movement when switching to
a narrow layout or reopening. Touch gestures do not move the preview; phone
portrait/landscape readers continue to fill their safe viewport.

This is client presentation only. The shared App UI covers Mac and Windows;
no host protocol, permission rule or headless CLI behavior changes. No native
installer or release was produced for this change.

## Validation

- Baseline Chromium reproduction: dragging the header 140 px moved the panel
  0 px, failing the expected displacement assertion.
- Chromium and WebKit each passed 14 cases across `media-preview-drag`,
  `media-playback`, `file-preview-fullscreen` and `creation` (28 executions).
- New journeys use a real disposable Hub and synthetic MP4, check header-only
  movement, retain the exact playing media element, seek, save identical bytes,
  keep controls reachable after extreme moves/resizing, restore focus on close,
  reset placement on reopen, preserve the unsent draft, and exclude touch
  movement in both phone orientations.
- Client translations, TypeScript and production build passed. Root standalone
  build passed (344 modules, no optional transport dependency).
- Evidence and inspected screenshot:
  `/Volumes/gdrive/taro-tmp/tarobot-video-drag-20261016/`.

These browser checks cover the actual rendered UI and decoder, but do not
claim installed macOS/Windows shell acceptance or a native App update.
