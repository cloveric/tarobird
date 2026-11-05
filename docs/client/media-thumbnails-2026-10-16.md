# Bot image proportions and inline video covers

The reported Bot gallery used fixed 150px/130px heights and `object-fit:cover`,
cropping 3:4, 16:9, 4:3 and 9:16 images into identical cells. Video attachments
only had a file icon and a separate preview button.

## Behavior

- Bot images now retain the complete original composition. Decoded dimensions
  constrain each thumbnail to its column and a 320px maximum height. This applies
  to native captioned gallery cards, consecutive image blocks and single images.
  User upload sizing remains compact. Original preview/export bytes are unchanged.
- Chat video files have a frame cover, centered play affordance and available
  duration, with filename, size and saving below. Clicking the cover opens the
  existing modal reader, including desktop header dragging. File-list rows remain
  compact. There is no inline autoplay or audio playback while preparing a cover.
- Visible videos up to 16 MiB use the existing authenticated attachment downloader
  and original cache. This matches the existing per-file cache limit; opening a
  conversation does not silently fetch larger videos. A larger file gets its cover
  from the bytes of an explicit preview, with no second cover download. Unsupported
  or unavailable files keep the preview/save fallback and do not invent a duration.
- Passive jobs are serialized, abort on unmount/host change/scroll out/action, and
  time out. A per-connection memory cache retains at most 48 covers (max 640px),
  without persisting new files or increasing the original attachment cache budget.
- Frame extraction waits for `requestVideoFrameCallback` where available. The
  initial WebKit test caught a one-color frame even after `seeked`; this matches
  [WebKit's documented canvas timing issue](https://bugs.webkit.org/show_bug.cgi?id=236604).
  The fallback for older engines uses loaded/seeked events; neither path plays
  the video. Decoder elements and object URLs are released after completion/abort.

## Verification

Evidence lives on the owner's external disk at
`/Volumes/gdrive/taro-tmp/tarobot-media-thumbnails-20261016/`.

- Baseline: the 3:4 image rendered at 1.373:1 in the old build; the original-ratio
  browser assertion failed before implementation.
- `media-thumbnails`: 390px/1360px, direct blocks/captioned gallery cards,
  mono/CLI/pixel themes, actual decoded cover pixels and duration, explicit
  playback, unchanged download bytes, large-video no-auto-fetch, and undecodable
  video fallback. The cover assertion checks color variation, not merely an img
  tag or loaded media metadata.
- Regression matrix: `media-playback`, `media-preview-drag`, `message-images`,
  `attachment-message-actions`, plus `media-thumbnails`: **18 passed in Chromium
  and 18 passed in WebKit** (36 executions). Cropped gallery and video-card
  screenshots were visually inspected in WebKit; full phone/desktop layouts
  were also inspected during Chromium validation.
- Client translations, TypeScript and Vite build passed; root standalone build
  passed (344-module standalone graph, no optional transport dependency).

This is client presentation only: no host APIs, permission rules, durable message
schemas, media originals or CLI capabilities change. The headless CLI continues
to deliver the same attachment blocks; no new CLI command is applicable.

These checks use a disposable real Hub and synthetic media. Browser WebKit is
not installed macOS App, Windows App or Android physical-device acceptance.
No App release, local installation or host restart is performed by this change.
