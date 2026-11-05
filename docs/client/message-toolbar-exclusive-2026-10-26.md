# Exclusive desktop message toolbars

Follow-up to [the first focus repair](desktop-message-hover-2026-10-26.md).
The installed 1.0.114 CSS already contains that repair; this report is not
explained by an unshipped version of the first change.

## Reproduction and scope

The previous tests clicked with the mouse, or used the keyboard, separately.
They did not switch from a keyboard-focused Quote button directly to hovering
another message. On the unchanged client this leaves both toolbars visible:
`focus-intent` only changed back to pointer input on pointerdown, not movement.
The added WebKit regression fails with the earlier toolbar's opacity still 1.
The screenshot alone does not establish every preceding native input event or
whether a native WebKit paint/hover artifact also contributed.

## Repair

- Mouse/pen movement restores pointer intent without blurring focused controls.
  Repeated movement in the same input mode does not rewrite the root attribute.
- `message-action-hover.ts` owns one hovered message across the document. Its
  delegated capture listeners switch the owner when the pointer crosses rows,
  including images and disabled controls. CSS no longer independently reveals
  each desktop toolbar from `:hover`. There are no per-row timers, React state
  updates, streaming subscriptions, mutation observers or layout reads.
- Leaving the window, opening a dialog, scrolling, blur or keyboard navigation
  clears the pointer owner. Keyboard-visible focus still exposes accessible
  actions; phone hold menus and existing non-hover touch layouts are unchanged.
- A previous toolbar disappears immediately when ownership changes. Only the
  new one uses the existing short opacity transition. Header/row geometry,
  message target IDs, quote/forward permissions and action handlers are retained.
- An intermediate attempt to disable hit testing on invisible controls caused
  direct-action automation to stall. It was removed; existing pointer targeting
  and keyboard navigation are preserved in the final change.

App presentation only: no Host/CLI, protocol, storage, queue, reply, or model
changes. No corresponding headless command is applicable.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp/message-hover-exclusive-20261026`.
The expanded hover suite covers 900/1360 widths, light/dark themes, keyboard to
mouse switching, animated reply indicators, streaming, three image messages,
image-preview return, disabled Forward, moving outside the viewport, and
simulated blur/scroll cleanup. Local test databases are independent and removed
by fixture teardown. Browser evidence is not acceptance in the installed Mac
WebView or on a physical phone. No release, install or Host restart is part of
this task.

- Final distinct cases: Chromium 13 passed; WebKit 12 passed and 1 existing
  offline-forwarding failure. This includes the separately rerun compact-layout
  case after updating its input-order assertion: move the mouse away **before**
  using Tab, rather than asserting keyboard ownership after renewed mouse use.
- The WebKit offline case times out clicking Forward after the offline banner
  appears. A fresh, untouched `6839c8bd` checkout reproduces the same failure at
  `message-actions.spec.ts:219` (`offline-baseline.log`); it is not resolved by
  this toolbar patch and is not counted as passing. Chromium passes that case.
- Client translation checks, TypeScript, production build and the Host build
  passed. The existing Capacitor Keyboard chunk warning remains nonfatal.
- Light/dark screenshots of three image messages verify that only the message
  under the pointer displays the action strip. The input-mode regression fails
  on the pre-fix build and passes in Chromium and WebKit after the repair.
