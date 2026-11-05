# Compact document delivery cards

The desktop saved-file card scattered its filename, preview/download controls,
save receipt and open/reveal controls across two rows and opposite edges. The
owner's PPT screenshot requested a more cohesive layout, rather than a color or
font-size change.

Desktop document cards now group the icon, filename and size together, with the
receipt beside the size. A single compact area below contains file operations.
Preview/download stay together, as do open/reveal; they wrap as groups when a
pane is narrow. In the narrowest cards, this area uses the full content width
instead of reserving the icon gutter. The caption retains its original text but
joins the file information without an extra horizontal divider. Multiple files
still have separators between them.

The document card has a definite preferred width, bounded by its available
space. This preserves intrinsic sizing for an attachment-only user bubble;
inline-size containment without that width would collapse the shrink-to-fit
bubble. Success/error metadata text inherits the status color instead of the
generic small-text gray.

Phone cards, conversation-file lists and video-thumbnail cards keep their
existing main layout. Their shared saved-copy controls remain grouped. Existing
accessible labels, busy guards, keyboard focus, errors/retry, cancellation,
native receipts, saved-copy opening and reveal operations are preserved.
Desktop preview/download controls remain mounted while a reader is open so its
opener can receive focus when the reader closes.

The layout fixture uses the production renderer and current Porcelain styles.
It includes the screenshot's PPT filename/caption with synthetic bytes; no real
document or production conversation is opened for the tests. Browser/native IPC
doubles do not establish acceptance of the installed Mac App or a real phone.

CLI-not-applicable: this is client presentation only. No Host API, permissions,
file transfer, file persistence, CLI capability or installed App is changed.

## Verification

Evidence, preview images and the independent Opus 5.5 review are stored under
`/Volumes/gdrive/taro-tmp/file-card-layout-20261028/`.

- Client translation checks, TypeScript and production build passed
  (`client-build-final-width.log`). The existing Capacitor Keyboard mixed
  static/dynamic-import warning is unchanged.
- Chromium: 16 attachment regressions passed (`reviewed-chromium.log`), including
  native-IPC doubles for Android saved-copy recovery/isolation. WebKit: the 11
  applicable file-operation and grouped-delivery regressions passed
  (`reviewed-webkit.log`).
- After the final status-color and intrinsic-width corrections, both engines
  passed the layout matrix and new own-file regression (`width-fix-*.log`):
  13 desktop/narrow/phone, light/dark, English and palette scenarios, and user
  attachments with/without a caption at 700/240px. This gives 29 distinct
  engine/case combinations overall. Open/reveal callbacks, saved/error colors,
  stationary preview placement and overflow checks passed.
- An earlier WebKit attempt timed out during pairing, before reaching the file
  UI. A later Chromium layout-only attempt hit its 90-second aggregate timeout
  while concurrent suites ran. The failing logs are retained; the final focused
  reruns passed without extending timeouts (Chromium 49.6s + 15.1s; WebKit
  40.5s + 12.7s).
- Opus 5.5 independently compared two layouts and recommended the adopted
  information-block/action-row design. It independently reproduced the bare
  user-file sizing issue, addressed by the width constraint and new regression.
- The supplied PPT sample is 155px high before and 140px after at 440px width.
  Its new idle and saved states have equal height. The delivered two-image
  preview uses synthetic bytes and is confirmed by `gallery-receipt.json`.

These results cover source/browser behavior, not installed Mac or physical
phone acceptance. No App release or installation was performed.
