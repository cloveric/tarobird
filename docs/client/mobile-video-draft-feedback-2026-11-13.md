# Mobile video drafts: keep attachment actions reachable

Adding two large videos can exceed the local offline draft budget while each
video remains eligible for a normal Host upload. The failed save preserves the
in-memory files, but the phone composer used a row-layout `flex-basis: 100%`
rule for its error message after switching to a column. The notice consumed
height and reduced the attachment tray to a nearly invisible strip.

The error's wrapping width no longer becomes a height basis. Under keyboard
pressure, the attachment tray may still scroll, but its minimum visible area
includes the thumbnail tops and remove controls. The message field and sticky
send toolbar retain their priority. The same minimum applies to expanded iOS
windows with a pointer. Keeping the whole attachment tray unshrinkable was
rejected because it covered the field in very short viewports.
At the end of the tray or notice, scrolling can continue into the composer to
reveal Retry. The composer still contains that scroll; it does not pass it to
the message list or page. A real wheel regression covers this handoff because
programmatic `scrollIntoView` alone would bypass the nested-scroll trap.

The capacity notice now explains that the draft is not saved offline and asks
the user to keep the page open, send it, or remove attachments and retry. The
32-file / 64 MiB conversation limit and 128 MiB per-Host local limit remain
available in an expandable explanation. No storage limit, upload admission,
identity check, draft revision, send receipt or persistence behavior changes.

This is a client presentation fix; the headless CLI and Host APIs are unchanged.
Browser test fixtures use a disposable Host and synthetic files. They do not
establish native camera/photo-picker, installed-App or physical-device behavior.

Verification on 2026-11-13:

- The pre-fix built App reproduced the clipped tray with two real 33 MiB video
  files. The preview button had only about 1.7% intersection with its viewport.
- 26 Chromium regressions passed: eight new quota cases plus the existing
  attachment-composer, composer-size and composer-busy suites. Coverage includes
  Chinese and English, phone and tablet sizes, explicit iOS/Android style
  branches, iPad pointer layout, desktop, keyboard visibility, hit testing, preview, removal,
  save/reload recovery and a real upload to the disposable Host.
- Four focused persistent-draft checks passed for capacity recovery, total-Host
  budget, failed initial reads and late send receipts. Three group-composer
  checks passed for quota recovery, temporary writes and conflicting drafts.
- Host/client builds, client type checking and translation validation passed.

The viewport and keyboard signals are simulated in Chromium. WebKit, native
pickers and physical iPhone/Android acceptance remain unverified. This source
fix does not release or update an installed App.
