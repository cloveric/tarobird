# Workbench responsiveness and stability

This change removes measured waits and repeated work in the App. It preserves
the editor sandbox, save-before-close, revision checks and conversation scope.
The comparison baseline is `39b49aca7c63d789e31aabe30f7123739829e807`.

## Changes

- Canvas sends `__frame_reveal_ready` and waits for the host to acknowledge its
  display. The App previously omitted the acknowledgement, so every new frame
  waited for the upstream fallback. `design-frame.ts` now acknowledges the
  current opaque-origin frame once it has visible bounds and is neither covered
  nor locked. Backgrounding, hidden panes, foreign senders and retired frames
  cannot trigger it. Reload starts a new handshake. Upstream bytes and fallback
  deadlines are unchanged; PPT keeps its existing entry flow.
- Concurrent requests for the same whiteboard share one pending storage read.
  Failed reads remain retryable. Deletion invalidates the pending read, and a
  late result cannot replace newer or unsaved local content. Initial reads for
  the at-most-four visible whiteboards start together, then publish in layout
  order after checking the owning scope.
- Workbench registration coalesces changes within a bounded 80 ms window.
  Continuous chat updates no longer restart the window indefinitely. Disconnect
  cancels pending publication; a new authenticated session registers immediately.
- Native webpage layout retains overlay candidates instead of searching the
  whole conversation DOM every frame. Visibility and geometry remain live;
  membership changes invalidate the candidates. Dynamic `role` and
  `data-workbench-overlay` changes now schedule layout too. Non-modal dialogs
  with explicit overlay markers retain their previous meaning. With no visible
  native page, overlay-only changes no longer send redundant layouts.
- Native resize-mode readback now handles exceptions in its success callback as
  well as rejected requests. An empty bridge reply previously left `resizing`
  set and retried synchronously forever. The error path releases the temporary
  layout hold without persisting an unverified width. This was reproduced by
  the existing narrow-window fixture's unimplemented window-read command, then
  covered explicitly with null/undefined replies and a bounded negative probe.

## Observations

These are local fixture observations, not device-wide latency promises. The
editor timing runs use the actual bundled canvas/PPT, a disposable Host,
synthetic Chinese/English content and Chromium automation. The intrinsic
`design:revealed` mark confirms that the real editor received the acknowledgement.

| Interaction | Baseline | Updated |
| --- | --- | --- |
| First canvas open, one run per language | 6.6–7.1 s | 1.6–2.1 s |
| Return to canvas after another tab | about 6.1 s | about 1.1 s |
| PPT entry | about 0.8 s | about 0.9 s |
| Overlapping whiteboard read requests in a controlled gate | 21 reads | 1 read |

An independent review measured the final native layout change with 1,500
synthetic chat messages and three seconds of streaming. Scripting time fell
from about 66 ms to 13 ms; this measures layout overhead, not website loading speed.
Opening side panels in an isolated Electron fixture took about 15–18 ms. A
candidate that removed two native reads had no stable latency benefit and was
not included. No editor is kept alive solely to claim faster reopening.

## Regression coverage and boundaries

Focused failing regressions preceded the fixes. Coverage includes pending-read
failure/deletion/disposal, retained newer edits, registration during sustained
notifications and reconnect, invalid native readback without retry loops,
reveal behind menus/locks/backgrounding, stale
senders and reload, overlay mutation/removal/modality, and idle hidden pages.
The new DOM/message cases run in Chromium and WebKit. Actual editor journeys
exercise offline editing, close/reopen, export, backup and bilingual entrypoints.
Existing split-pane, browser-tool and ADHD cases cover the surrounding App flow.
The bundled canvas also passes standalone open/reload with the actual reveal
mark in both engines. The full WebKit App journey stalled while pairing, before
entering Workbench; it is not recorded as an editor or end-to-end pass.

These changes affect client storage scheduling and presentation only. No Host
capability, command schema, authorization or CLI command changes. Source tests,
browser fixtures and isolated Electron measurements do not establish installed
macOS, Windows or physical iPhone acceptance. This checkpoint does not publish a
release or update an installed App.
