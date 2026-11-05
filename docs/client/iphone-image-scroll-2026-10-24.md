# iPhone image-history scroll stability

The reported screen was a normal conversation containing a captioned gallery,
not the full-screen image viewer. Scrolling that history while another chat
streams can expose an image-specific gap in the existing reading protection.

## Reproduction and cause

`AttachmentImage.tsx` kept decoded dimensions only in its mounted React state.
Virtual history releases rows and their object URLs. On remount, an already-read
gallery therefore passed through a short loading tile and an undecoded image
before recovering its original height. If a partially visible row changed
height, the following visible content could move. The existing scroll protection
deliberately does not compensate every change in a partially visible row, since
doing so would move the reader when a streaming reply grows below them.

A real App/isolated Hub browser fixture with mixed image ratios and streaming
updates in a separate conversation reproduced an extra visible displacement of
up to 420 CSS pixels during fast upward reading. Slow scrolling alone passed.
Measurements compare continuously visible row/caption anchors in consecutive
frames, excluding expected movement from the reader's scroll offset. Sampling
also runs after the virtualizer's ResizeObserver frame, so a transient jump is
not hidden by a later correction.

## Change

- `image-dimensions.ts` retains only positive decoded width/height, keyed by the
  authenticated `HubConnection` object and attachment ID. Each connection has a
  512-entry LRU bound. No original image, Blob or object URL is retained here.
- `AttachmentImage.tsx` uses retained geometry immediately on remount. An empty
  intrinsic-size SVG reserves the image's existing layout until the authenticated
  URL is ready. It is disabled and is never previewed, copied or exported.
- Already-mounted lazy occurrences subscribe to that attachment's dimensions;
  they may have rendered before a sibling decoded. Publishing the dimensions
  prevents those rows from retaining an empty-sized image until their own load.
- Existing thumbnail CSS still determines size. Explicit CSS auto dimensions
  preserve user portrait proportions under max-size bounds; Bot galleries,
  long-image crops, themes and original-byte exports keep their prior behavior.

`reading-scroll.ts`, the virtualizer's anchor rules, background conversation
subscriptions, keyboard handling and native scrolling are unchanged.

CLI impact: not applicable. This is App presentation metadata; there is no new
host API, message format, attachment authorization, engine or CLI behavior.

## Verification

Regression sources: `tests/client-image-dimensions.test.ts`,
`tests/client-image-gallery.test.ts`, browser `iphone-image-scroll`,
`message-background-scroll`, `message-reading`, `message-following`,
`message-images`, `media-thumbnails`, `image-recovery`, and `image-export`.

The new journey covers several reading speeds, streaming output in another
conversation, every-frame anchor measurements, touch release and delivery of
the other conversation's final output. Final checks:

- 8 unit tests passed; client translation/type/build and standalone host build
  passed.
- Chromium: 16 passed. WebKit: 30 passed, 1 Chromium-only real-touch test skipped.
- All six new browser cases (three speeds in each engine) measured zero extra
  visible-anchor displacement. The WebKit fixture also passed six earlier
  repeated runs; final checks additionally verify touch release and delivery.
- iPhone 15 Pro Max / iOS 27.0.1: the owner-connected device originally ran the
  earlier 1.0.105 development package. A signed 1.0.107 development candidate
  using the unchanged 1.0.107 native binary and the reviewed frontend was
  installed without uninstalling. Its original pairing and the reported
  conversation remained available. Dragging through history, revisiting the
  mixed gallery, opening its original and returning to the same position were
  exercised through Xcode Device Hub. A separate conversation updated while
  the gallery was open; its resting position stayed unchanged.
- Owner follow-up on 2026-10-24: after being asked to repeat fast up/down finger
  scrolling at the reported gallery on the installed candidate, the owner
  confirmed “现在滚动正常” (scrolling is normal now). This is direct user
  acceptance of the reported interaction, separate from the browser measurements
  and Device Hub observations.

Evidence lives under the owner's external-volume task directory
`/Volumes/gdrive/taro-tmp/iphone-image-scroll-20261024`: browser logs/samples,
build logs, signed artifact and installation receipts, `physical-acceptance.json`
and `iphone-native-gallery.png`. The screenshot verifies presentation, not
smoothness. No public release or local Mac update was performed in this change.

## Boundaries

The cache is intentionally ephemeral. A first-seen image, an evicted attachment,
or an App restart still requires its first decode before intrinsic dimensions
are known. This change fixes geometry loss for already-decoded images; it does
not invent dimensions or introduce a persisted attachment-metadata migration.
Browser touch events do not establish physical iOS inertia or a frame-rate
guarantee. A very fast Device Hub fling briefly showed an empty virtual window
before history populated; that observation has not been attributed to the
image-remount bug or measured with a physical frame trace. It remains a separate
performance observation; the owner's subsequent normal-scrolling confirmation
does not establish a frame-rate guarantee or attribute that separate brief
blank. Development device installation is distinct from a public release.
