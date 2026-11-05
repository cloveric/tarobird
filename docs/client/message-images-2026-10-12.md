# Compact sent images — 2026-10-12

Long receipt screenshots previously fitted their entire height into a 400 px
preview. On a phone this made a thin strip inside a nearly screen-height bubble.

## Behavior

- Images taller than twice their width show a 180 px top crop, with a quiet
  “长图 · 点击查看” label. Ordinary single images stay within 220 px height.
- Consecutive image blocks appear in a two-column gallery. This groups only
  presentation: text/file order, stored blocks and delivery bytes do not change.
  The shared component also covers nested card images and existing history.
- Filenames use one compact, ellipsized line below each thumbnail. Attachment
  quote/forward controls and their existing message scope remain available.
- Opening a long image displays the full source at readable viewport width in a
  scrollable modal. Reading/tapping the image no longer dismisses it. The close
  button stays visible; Escape and Android Back restore focus to the thumbnail.
  Keyboard focus cycles between Close and the scrollable reader.
- Only the thumbnail is cropped. Existing encrypted attachment download, cache,
  access control and original bytes are unchanged. No migration is needed.

## Verification

The new regression first reproduced the previous 400 px thumbnail. A synthetic
720 × 7,200 receipt then exercised actual upload/send, compact bubble geometry,
full-width reading to the bottom, original dimensions, Back/focus restoration,
and sending/opening all three gallery images at 320, 390 and 1,360 CSS px.

Final Chromium coverage: 22 cases across message images, attachment composer,
attachment actions, card layout and safe areas. WebKit coverage: eight cases
across message images, attachment actions and safe areas. Both engines cover
nested card images, modal close/reopen, original attachment actions and no page
overflow. Rendered screenshots are in `evidence/message-images-2026-10-12/`.

The first full core run had a `hub_control_closed` failure in the unchanged LAN
host fixture. Its isolated six-case rerun passed. Running the suite during native builds
also produced seven timeout/contention failures. The final full suite, limited
to four workers without changing test timeouts, passed all 221 files: 2,862
tests passed, one skipped. Android release/unit/lint and standalone archive
checks also passed; native package verification is recorded in the receipt.

Browser viewport tests and signed-package verification do not constitute
physical Android device acceptance. No engine behavior or external relay service
is changed by this client presentation fix.
