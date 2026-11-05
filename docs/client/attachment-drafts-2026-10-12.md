# Draft attachment preview and phone tray — 2026-10-12

The phone composer reported three attachments but displayed one full-width file
inside a horizontally scrolling list. The thumbnail was not interactive. Two
persistent explanatory paragraphs further reduced the available preview space.

## Behavior

- Three compact image/file tiles fit the phone composer at 320 and 390 CSS px.
  Additional attachments scroll horizontally; previous/next controls appear only
  when the list overflows. The count always includes the full draft.
- A file's thumbnail or name opens a modal preview from the existing local File,
  without uploading or sending it. Images, audio/video, text, Markdown, PDF and
  Word reuse the existing bounded readers. Unsupported files offer the existing
  native save/share or browser-download flow. HTML/code stays escaped text.
- Close, Escape and Android Back dismiss the preview and restore the file button.
  Changing conversation/host visibility unmounts previews; object URLs are
  released by the existing media lifecycle. Inline audio audition is preserved.
- The tray shows only the count and Add, with a short “添加说明…” placeholder.
  Upload progress, cancellation, pending draft saves and save errors remain
  available; the routine limit and persistence paragraphs are removed. Server
  file-size validation is unchanged.
- Existing conversation/identity-scoped draft persistence and send behavior are
  unchanged. Preview does not create a message or consume an attachment.

## Verification

The regression first failed against the previous client because there were zero
preview buttons. New browser cases exercise three visible tiles on 320/390 px,
460 px visual-keyboard signals, offline image preview, native Back/focus return,
scrolling to a fourth file, deletion, reload, combined send, Word/PDF rendering,
escaped text and exact-byte export of an unsupported file.

The final core gate passed 221 files (2,862 tests, one skipped). Chromium covered
43 unique cases and WebKit 19, including repaired fixture expectations and the
explicit WebKit preview focus fix. Android release compilation, unit tests and
lint passed. The standalone archive was installed and checked outside the repo.
WebKit's offline simulator itself rejects new blob URLs, so its preview case
blocks HTTP; the Chromium case uses full offline emulation.

Release receipts and screenshots are in `evidence/attachment-drafts-2026-10-12/`.
Browser viewport simulation and signed-package checks do not replace physical
Android picker/keyboard/preview acceptance on the user's phone.
