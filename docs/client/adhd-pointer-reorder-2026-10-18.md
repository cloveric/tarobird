# ADHD pane reordering

The numbered pane handle already exposed HTML drag-and-drop and an
Alt+Left/Right keyboard alternative. Browser drag tests passed, but two actual
drags in the installed Mac desktop App left pane order unchanged. Presence of
the handle and a successful browser `dragTo` were insufficient native evidence.

The handle now uses pointer capture on the stable board. It no longer delegates
a custom MIME drag to the native shell. After a six-pixel movement threshold,
the source is dimmed and the destination is outlined; releasing inserts the
source at that destination. The board scrolls when the pointer reaches its
edges, allowing moves between offscreen rows or columns.

Only releasing over another pane commits and saves an order change. A click,
Escape, pointer cancellation, lost capture, window blur/resize, leaving the
board, or releasing outside it cannot accidentally reorder. The existing
Alt+Left/Right shortcut remains available. Pane identity and React keys do not
change, so drafts, live tasks, files and conversation bindings are retained.

This remains an ordered grid, not a free-position canvas. Layout is stored on
this device. Phone UI, engine adapters, Hub state and CLI commands are unchanged;
CLI parity is not applicable to desktop pane positioning.

## Verification

- Added a pointer journey that cancels every HTML `dragstart`, then verifies
  drag/release, cross-row moves, destination highlighting, click/outside/Escape/
  pointercancel cancellation, board-edge scrolling, keyboard movement, drafts
  and saved order after reload.
- Existing header drag and saved-layout tests remain part of the ADHD suite.
- Native validation uses a separate Cocoa/WKWebView window and isolated Hub;
  it does not replace the running production App or alter real messages.
- Actual native mouse drags changed `1,2,3,4` to `2,1,3,4`, then moved window 1
  to the second row (`2,3,4,1`). After entering a draft, dragging it back to the
  first slot restored `1,2,3,4` with the saved draft intact. This is native
  WebView verification, not acceptance of a new installed TaroBot release.
- Chromium: all 31 ADHD checks passed. WebKit: 30 passed in the full run; the
  background-report source-navigation check timed out on its first attempt and
  passed when rerun alone. The pointer test passed in both engines. This
  transient report-navigation failure is retained in the verification record.
- Seven layout/connection unit tests and the client production build passed.
