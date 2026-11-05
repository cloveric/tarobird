# ADHD header dragging and motion

Desktop ADHD panes can be moved by either their numbered handle or the blank
space and non-interactive labels in the same header. Conversation details,
menus, approval controls, open/expand/remove buttons and inputs retain their
normal actions. The search header still offers its numbered handle.

## Interaction

- Movement starts after 6 CSS pixels. A click or small wobble does not reorder.
- The live pane follows the pointer without scaling its text. A stronger shadow
  and accent border distinguish it; neighbours slide into their proposed slots
  and a lightly tinted outline marks the destination.
- Target detection uses the original grid slots, corrected for board scrolling.
  Animated panes never become moving hit targets. Crossing a gutter retains the
  current preview; returning to the source slot restores the original order.
- Releasing inside the board commits the displayed insertion position once.
  Releasing outside, Escape, pointer cancellation/lost capture, blur, a context
  menu or a changed layout cancels. Resize is checked again at pointerup to cover
  a resize event arriving late. A pointermove without the primary button clears
  an abandoned gesture only after that gesture has reported a pressed button:
  some native WKWebView input paths report zero on both down and move. Explicit
  release, cancellation and lost capture always apply. Modified clicks,
  including macOS Control-click, do not start a drag.
- Neighbour and landing motion lasts 200 ms with an ease-out curve, without
  bounce. Picking up a pane during landing pauses that animation and preserves
  the pointer's offset; keyboard reordering also continues from the current
  visual position. Board edge scrolling uses elapsed time rather than frame
  counts, so high-refresh screens do not scroll twice as fast.
- Reduced-motion preference removes all tween animations, while retaining
  direct pointer positioning and destination feedback. Preference changes cancel
  already running animations. No permanent transform or animation is retained.

## State and bug fixes

The existing ordered grid, React pane keys and device-local persistence remain
the source of truth. A drag updates styles rather than React state on every
pointer event. It does not clone a conversation, remount an editor, change a
subscription, or send a message.

Independent Opus review highlighted a real browser issue: keyed DOM reordering
can reset nested scrolling even though React component state survives. The new
application regression reproduced a reading position changing from 150 to 0.
All panes' message, editor and code-block scroll offsets, plus the board's own
position, are now captured immediately before any reorder and restored in the
layout effect before painting. This includes neighbours physically moved by
React and Alt+Left/Right reordering. Draft/editor identity is checked separately.

Other reviewed cases include crossing gutters, blank-header click focus,
re-grabbing during landing, late resize delivery and last-frame pointer release.
Buttons are excluded before pointer capture; clicking another pane's blank
header no longer leaves typing focus in the previous pane's editor.
WebKit's prefixed `-webkit-user-select: none` is applied both to drag headers and
the active board to prevent native selection gestures taking over a blank-header
drag. While dragging, selection is also suppressed outside the board: otherwise
crossing into the sidebar in native WebKit can select its text before cancelling.
The regression drags across long histories and into the sidebar, and asserts an
empty selection. Ordinary text selection is unaffected after the gesture ends.

CLI impact: not applicable. This changes desktop presentation and device-local
layout only; host APIs, Bot engines, mobile UI and the headless CLI are unchanged.

## Verification

Verification uses the real App client against temporary local Hubs, with all
test state and screenshots on the external disk. Focused tests cover blank
header and handle dragging, button exclusions, gap stability, repeated pickup,
cancel/resize cleanup, reduced motion, editor identity, independent reading
positions, keyboard movement and persisted ordering.

- ADHD board, ordinary conversation entry, desktop/phone drafts and queue
  journeys: **53 Chromium + 53 WebKit checks passed**.
- After the native input and selection refinements, rebuilt and reran all three
  focused drag/reading cases in both engines: **6 checks passed**.
- Board state and connection isolation unit checks: **7 passed**.
- Client translation/type/build checks and a redacted Gitleaks scan of the
  intended patch passed. No new dependency was added.
- Claude Opus 5.5 reviewed the design, implementation and final interaction
  fixes, using isolated Chromium/WebKit fixtures against the real hook. A fourth
  focused review checked native button-state handling. The blocking scroll reset
  and subsequent interaction/selection findings were reproduced and fixed.
- A separate Cocoa/WKWebView window loaded the built client against an isolated
  Hub on macOS. Blank-header horizontal and cross-row reordering retained the
  draft; dropping outside the board cancelled. Its recorded native zero-button
  events revealed and verified the compatibility fix. This is native WebView
  acceptance, not a replacement or verification of the installed production App.

Physical mouse/trackpad variations, including three-finger dragging, have not
been separately exercised. Windows native interaction was not exercised here.

This source change does not by itself replace the installed Mac App.
