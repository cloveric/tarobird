# Fast mobile navigation and device motion preference

October 28 update: the App animation switch described in this original record
has been removed. App animations now remain enabled across all platforms,
including when the system reports reduced motion; see
[the current behavior](always-on-animations-2026-10-28.md).

The phone inbox and conversation previously switched with `display:none`, while
some sheets and the iOS keyboard already had transitions. This change makes the
common navigation visible without delaying the action or replaying on new replies.

## Behavior

- Entering a conversation moves its existing container 28 px from the right over
  180 ms; returning brings the existing inbox from the left. Main phone tabs use
  a 120 ms fade. Settings category navigation uses the same directional motion.
- Phone sheets use a 200 ms duration and full-screen settings use a 180 ms sideways
  entrance. No outgoing copy of the message history is retained or measured.
- Pointer/touch down pauses the arriving page at its actual hit position; click
  capture settles it after the browser resolves the click target. Cancelling on
  down moved the Back button before up and lost the first click (reproduced and
  repaired). A released touch retains its hit position across the native click
  synthesis gap; normal clicks are immediate. A 350 ms fallback resumes motion
  only when no click/cancel arrives. Cancellation and long press settle it.
  Keyboard input and editing focus cancel it; a focused field uses a fade to
  avoid separating the native iOS caret from the field. CSS full-page entrances
  share the same cancellation policy. Hidden pages stop motion.
- Settings → General → Appearance → Interface animations is device-local, enabled
  by default, and preserved across restart. System reduced motion always wins.
  The startup appearance mirror prevents a flash before IndexedDB loads.
- The switch covers CSS transitions/animations and backdrops, page WAAPI, existing
  ADHD pane settling, image inertia, Bus smooth scrolling, and iOS status-bar fades.
  Direct dragging and scrolling remain functional. Native keyboard animation itself
  belongs to the operating system.

## Implementation and verification boundaries

`motion.ts` owns policy and bounded, interruptible animation lifetimes;
`use-scene-motion.ts` depends on navigation keys, not message updates. Animation
does not update React state per frame, change message geometry, or force smooth
chat scrolling. `appearance.ts` and both preference readers normalize the switch.

The real Opus 5.5 xhigh review agreed with the short, single-surface approach and
identified the native-caret focus risk and old iOS selector compatibility:
`::backdrop` now has a separate reduced-motion rule, so unsupported browsers do
not discard the common rule. There is no new iOS 15 device acceptance.
Keyboard-specific findings, final verification and exact evidence are recorded under
`/Volumes/gdrive/taro-tmp/mobile-motion-20261023`.

Browser regression checks cover entering/returning, fast repeated navigation,
draft retention, reading history during background conversation updates, persistent
disable, live OS reduced-motion changes, and existing keyboard/Back behavior.
Evidence:

- `client-build-scene-cancel.log`: translation validation, TypeScript and Vite pass.
- `final-client-build.log`: the integrated navigation, motion setting and both
  keyboard repair rounds pass the same client build.
- `first-pointer-before.log`: reproduces the lost first click. The repaired
  mouse and touch-coordinate checks pass on Chromium and WebKit. These tests
  hold the first visible animation frame rather than waiting for it to finish.
- `final-viewport-unit.log`: all 11 viewport unit cases pass.
- `final-webkit.log`: all 10 final motion and phone-panel cases pass, including
  rotation during a keyboard animation, expired reports and disabling motion.
- `final-chromium.log`: all four motion cases pass; Vite then fails to allocate
  an ephemeral port before the panel suite starts. The isolated panel rerun
  (`final-chromium-panels.log`) passes all six cases without source changes.
- The last Opus pointer review identified a possible native release-to-click
  process delay (source reasoning, not a device reproduction). The release
  fallback now preserves the hit target through that gap and resumes smoothly
  only if no click arrives. A browser test explicitly spans two rendering frames
  before completing the click; this does not claim native gesture acceptance.
- `final-touch-webkit.log` and `final-touch-chromium.log`: all five final motion
  cases pass on each engine after that repair. Final settings and chat screenshots
  were visually checked; the new switch fits the existing Appearance section.
- Opus's integrated pre-pointer-fix browser suite passes 19/19 on each engine
  (`opus/logs/e2e-*-r2.log`). Native Android API 36 emulator build and recordings
  cover repeated keyboard opening, streaming, history, form fields, rotation,
  reload, expired events, OS reduce and persistent App settings. This is emulator
  evidence, not a physical Android phone. See [keyboard evidence and limits](keyboard-motion-2026-10-23.md)
  and `opus/report-r2.md` for exact observations and remaining platform boundaries.
- `host-build.log`: standalone Host/CLI compilation passes (431 modules).
- The optional repository-wide `npx tsc --noEmit` is not green: it emits 120
  pre-existing diagnostics. `root-tsc.log` and a clean `27a5331` baseline run
  (`baseline-tsc.log`, identical dependency links) match byte-for-byte after
  normalizing checkout paths. The client-specific type check passes.
- `webkit-focused.log`: 25 passing navigation, keyboard, mobile settings, native
  Back and background-scroll cases. After the CSS entry cancellation change,
  `webkit-scene-cancel.log` reruns both motion cases successfully.
- `chromium-regression.log`: 53 of 58 broad mobile, settings, image-viewer and
  ADHD cases pass in the initial run. Four used outdated network labels/flows;
  their fixtures now use the current UI. One lazy chunk was removed by an
  overlapping build (404 in the trace), so this was a verification-artifact race.
  With stable build output, `chromium-final.log` passes all five reruns plus both
  motion tests, including interrupting the CSS settings entrance on its first frame.

Browser rAF samples are diagnostics, not physical-device frame-rate evidence.
The connected iPhone was detected, but the native UI control service repeatedly
failed to start, including after reset and a later retry after Device Hub use.
No physical-phone smoothness or
new device installation is claimed by browser tests or compilation.

This is presentation and device-preference work. It adds no Host API, network
protocol, permissions or CLI operation; CLI feature changes are not applicable.
