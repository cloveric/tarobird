# Movable conversation creation dialogs

Desktop users can drag the header of New conversation, New group and New topic
without losing their title or Bot selection. Other dialogs retain their current
behavior. The native HTML dialog still owns modality, focus and Escape/Back.

`CreationDialog` opts into `useDialogDrag` through `movable`. Pointer capture keeps
the gesture continuous; translation is local to the element, without rerendering
the conversation. Bounds retain a 12 px window margin. Window/content resizing
reclamps the dialog; crossing into the phone layout clears the translation.
Closing and reopening starts centered. Touch pointers never initiate this drag.
The existing entry animation and reduced-motion setting remain in place.

Backdrop dismissal now requires the press and release to both occur outside the
dialog. Selecting text or dragging from inside to outside no longer dismisses it.
Close buttons, inputs and other header controls cannot initiate dragging.

## Verification

Follow-up: the quoted-attachment keyboard failure recorded below was resolved
in the [2026-10-12 product audit](product-audit-2026-10-12.md). The original
results remain here as the evidence for the earlier release.

- Root and client builds passed, including translation and TypeScript checks.
- Chromium and WebKit: each ran 13 creation, keyboard and native-back cases;
  12 passed in each engine. The new geometry/creation case passes, covering
  movement, all edges, viewport shrink, close, reopen, preserved values, successful
  creation, composer focus and transition to the unchanged phone sheet.
- One existing keyboard test fails in both engines: quoted attachments plus a
  simulated visual keyboard place a composer element outside its expected bounds
  (`keyboard.spec.ts:46`). A separate unmodified checkout of `b0863a3` reproduces
  the same Chromium failure. This change does not claim that regression gate is
  green; the existing mobile composer issue remains unresolved.
- macOS native debug App 1.0.14, separate identifier and temporary local Hub:
  dragged the dialog 200 px right / 120 px up; then dragged to the top-right edge.
  Header and close button remained visible, the typed title and checked Bot
  survived, and Create opened the named conversation with composer focus.
  Reopening centered it; the close button worked. No real model was invoked.
- Android release build passed. Physical Android acceptance is not available
  because no device is attached; browser phone dimensions are not native proof.

Release versions: root 0.1.387, macOS 1.0.14, Android 0.1.387-test.1
(versionCode 2026101202). macOS uses an ad-hoc signature, Android the existing
prerelease test key. Installed user Apps and real Hub/Bot state are untouched.
