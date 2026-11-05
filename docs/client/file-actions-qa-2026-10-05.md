# Attachment action flow review

Scope: the existing TaroCub file card and preview, from receiving a file to
opening or exporting it. Goal: make the current operation, cancellation and
outcome understandable on desktop and phone, using the existing Atelier style.
This is a bounded interaction audit, not a full accessibility certification.

The parent captured the current local isolated Hub in Chrome through the
computer-use browser interface. The in-app browser was unavailable. The sample
file contains only fixture text, and no live Bot was called. Tauri/Capacitor
external stages are held by narrow SDK bridge doubles where specified; those
screens are not screenshots of native operating-system dialogs.

## 1. Attachment entry

Attachment before changes（本地材料：`screenshots/file-actions-20261005/01-card-before.png`）

The file name, open action and save icon are easy to find and visually consistent
with the conversation. A 229-byte file is incorrectly presented as `0.00 MB`.
The file can be opened; the display needs to use the existing byte formatter.

## 2. Saving and cancellation

Write held in the real UI with a simulated platform bridge（本地材料：`screenshots/file-actions-20261005/02-save-before.png`）

After the network download finishes and the platform writer is pending, the
card still says `下载中 100%`. The visible `取消下载` control remains enabled but
cannot stop that write. Clicking it was observed to leave both status and
operation unchanged. The UI needs separate download/export phases and must not
offer a cancellation action that cannot affect the current operation.

## 3. Phone preview and feedback

Phone preview before changes（本地材料：`screenshots/file-actions-20261005/03-preview-before.png`）

The preview is readable and offers both save and close. Source inspection and
the failing regression confirm that an export error is rendered on the covered
file card, not in this dialog. Native Back is blocked while busy, whereas Close
and Escape close the same surface. These paths need one consistent rule and
feedback inside the active preview. The initial accessibility snapshot also
leaves focus on the underlying Open control; focus behavior requires explicit
verification beyond these screenshots.

## Regression baseline

Before implementation, three desktop/preview/browser-result cases failed;
two additional phone SDK cases at 390px Chinese/light and 320px English/dark
also failed with `下载中 100%` / `Downloading 100%` during share preparation.
These use a real isolated Hub, real renderer and installed SDK modules, with
controlled native-call boundaries. They do not establish physical-device,
native dialog, Keychain or mobile share-sheet acceptance.

The Mac app access attempt reported the machine locked. That gate remains open.

## 4. Accepted card and preview

Phone saving phase after fixes（本地材料：`screenshots/file-actions-20261005/05-phone-saving.png`）

Actual Opus 5.5 xhigh implemented explicit download, preview, location selection,
write, share preparation, system handoff, neutral cancellation and retry states.
A 229-byte file now reads `229 B`. Download cancellation is offered only while
it can cancel the network operation. Closing a preview does not cancel a native
write already in progress; feedback returns to its file card.

Error and retry inside the active preview（本地材料：`screenshots/file-actions-20261005/06-preview-error.png`）

The screenshot uses a controlled Tauri SDK rejection, not a real disk-full
error. The parent measured Retry at 50×44px; the native HTML dialog is modal and
contains focus. Retrying through a successful controlled write returns `已保存`.
Only a completed native write and close receive that label. Browser downloads
and phone share sheets have neutral handoff wording.

Parent rendering checks caught and corrected four remaining candidate defects:

1. Preview focus stayed in the covered chat: replaced the custom overlay with
   modal HTML `dialog`. A later close check found focus fell to body after
   unmount; close now dismisses the dialog first and explicitly restores Open
   with `preventScroll`. All three close paths pass focus assertions in both engines.
2. A full-width status row plus a 48px margin overflowed the card: changed the
   margin to padding. Current phone card right edge is 351px, status edge 338px,
   and status scroll/client widths both 247px.
3. Preview Retry was 33.39px high: all preview buttons now meet the 44px phone
   and coarse-pointer target, with a focused regression assertion.
4. Two 44px actions squeezed a short file name into a vertical column at 320px:
   phones ≤480px now put the filename and controls on separate rows.

320px English dark share state after layout correction（本地材料：`screenshots/file-actions-20261005/10-narrow-share-after.png`）

The rejected candidate is retained in `09-narrow-candidate-before.png`.
The first width regression used computed `line-height`, which is `normal` here;
that assertion was corrected to measure the fixture label's width and height
against its actual font size. Both engines then passed. This was a test
measurement correction; the unreadable candidate remains recorded.

The existing visual tokens and typography are preserved. The local-work spinner
was measured at `spin / 1.2s` normally and `none / 0s` with reduced motion. Waiting
for a system choice does not spin. There is no new decorative animation loop.

## 5. Verification and remaining gates

- Chromium attachment/save/safety/download/composer suite: 30 passed.
- WebKit file-action/download/composer suite: 8 passed.
- After the final phone layout, touch and opener-focus corrections: all five file-action cases
  passed again in Chromium and all five in WebKit, including 390px Chinese/light
  and 320px English/dark. Both SDK paths and browser handoff are exercised.
- Earlier in this same change, the root completion hook passed: 234 test files,
  3,781 passed, one skipped; root and client builds passed. Later changes were
  the scoped CSS, opener restoration, layout/focus assertions and explanatory
  comments described above.
- The real isolated Hub's two-client 120 MiB recovery cases verified final hashes.
  Controlled SDK calls do not establish real macOS dialogs, iOS/Android share
  sheets, physical-device timing, notifications or permissions.

The Mac app remained locked when native access was attempted. No native runtime
acceptance, deployment, production restart or full-plan completion is claimed.
Phone export caches older than 24 hours are swept on the **next export**; this
is neither a timed deletion service nor a strict retention deadline. Canceled
shares retain their local cache copy because an Android target may already have
received its URI. This concerns local device cache, not VPS relay storage.

All browser SDK injections were cleared with a reload and the temporary viewport
was reset. The retained preview uses synthetic local conversation data and has
no real Bot attached. Machine receipt（本地材料：`evidence/file-actions-2026-10-05.json`）
and [actual Opus implementation report](file-actions-opus55-2026-10-05.md).

The initial r13 package predates the final opener-focus correction; the deliverable
package is r14. Both are development artifacts, not native runtime acceptance.

## 6. Final Opus review

Actual Opus 5.5 xhigh read the parent corrections after runtime fixes (16 turns,
92,548ms). It reported no blocking defect in close/focus, the action lock,
small-screen layout or stage/caching semantics. This is a static review, not an
independent test run. Its two edge-case follow-ups remain unverified: selecting
text and releasing outside the preview could close it; Escape while focused in
a PDF iframe lacks coverage. Neither is counted as a reproduced failure or a
passed behavior. Exact review and disposition（本地材料：`evidence/file-actions-opus55-final-2026-10-05.json`）.


The r14 universal development bundle（本地材料：`evidence/macos-r14-2026-10-05.json`）
passed both architecture checks, strict ad-hoc seal verification, DMG integrity,
read-only mounted file comparison and delivered-copy hash equality. Its 99
frontend resources match the browser-accepted build and both mobile shell
resource copies. The bundle is uninstalled and unpublished; Hub is separate.
