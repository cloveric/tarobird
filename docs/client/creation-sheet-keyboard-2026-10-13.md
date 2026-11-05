# Phone creation-sheet spacing — Android 1.0.62

## Follow-up: host caption overlap (2026-10-14, source fix)

The 1.0.67 phone screenshot exposed a remaining overlap below the fixed host
caption. The form's `margin: -4px` let its scrollport paint four pixels into the
caption when the keyboard scrolled the name label upward. The original test
only compared the label against the heading, leaving this boundary unchecked.

Keep the negative margin horizontal, and reserve 12 px below the host caption.
Focus rings retain their horizontal room; the form still scrolls independently
of the fixed title, close action and host caption.

The new scrollport assertion fails on both original conversation/group cases
with a measured gap of -4 px. After the fix, Chromium and WebKit each pass all
16 keyboard, creation and safe-area cases. Four strengthened cases also pass
in each engine after scrolling the label directly to the form edge. They cover
compact Android-style window resizing and standard visual-viewport resizing,
retained names, the last Bot choice and successful submission. The client
translation/type/production build passes. These are isolated browser checks;
no physical Android keyboard test or new installer is included in this fix.

Bot deletion was also checked at the user's request: neither phone nor desktop
1.0.67 exposes a Bot deletion operation. Removing a Bot from a group and
archiving/deleting a conversation are separate operations, not Bot deletion.

## Original 1.0.62 repair

When the keyboard focused the name field, the complete creation dialog could
scroll: its title and close button disappeared, and the name label touched or
passed the rounded top edge. This affected new conversations and groups.

`NewConversation.tsx` now opts into `conversation-creation.css`. On phone widths,
the sheet is a bounded column: its title and host context stay outside the
scrolling form. The top inset is 16 px; the form reserves focus-ring space and
scroll padding, and the input has enough scroll margin to retain its label.
Desktop dragging and the shared creation/retry logic are unchanged.

## Verification

- Both new focus-scroll cases fail against the previous layout, then pass in
  Chromium and WebKit. They verify visible title/close controls, label spacing,
  preserved name text, scrolling to the last Bot and successful creation.
- The existing six creation journeys pass in both engines, including desktop
  dragging, retry and topic creation. The six keyboard cases also pass across
  the final focused runs. The Chromium historical-position fixture initially
  failed on both the old release frontend and the fix: its synthetic wheel and
  scrollTop write did not produce the browser's native scroll sequence. It now
  uses real wheel input in Chromium and an explicit historical position for
  mobile WebKit, where Playwright wheel input is unsupported. A precondition
  checks that the reader is away from the tail before resizing the viewport.
- Standalone build: 230 test files, 2,935 passing tests, one skip. Client
  translation/type/production build passes. Android release compilation, cached
  27-test JVM task and lint pass (zero errors, 22 existing warnings).
- The signed APK is non-debuggable, retains the previous certificate, and has
  valid v2/v3 signatures and 16 KB ZIP alignment. All 378 web files match the
  native copy with its intended CSP transformation; all 380 public assets match
  the APK. The creation-sheet CSS is present. All 15 launcher PNG variants and
  both adaptive launchers pass inspection.

## Download

[Android 1.0.62](https://github.com/cloveric/tarobot/releases/tag/v0.1.415-test.4),
package `com.tarocub.client`, versionCode `2026101317`.

`TaroBot-1.0.62-android.apk` SHA-256:
`74b4f443d935d8158ecac896d51a0034eea82a38b6bc9f32be230fbae91273cc`.

This is an Android-only test update. The previous Mac/Windows 1.0.61 installers
remain available. Browser keyboard simulation is not physical Android keyboard
acceptance; no Android device was connected for this run. No live host or Bot
service was restarted. Remote GitHub CI remains subject to the account billing
block recorded in the preceding release.
