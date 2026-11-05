# iOS Workbench layout

The phone Workbench mode class also appears on the chat shell. Panel safe-area
padding was therefore applied to the whole shell, even though the conversation
header and composer already reserve those edges. Excalidraw then reserved the
screen's top/bottom insets again inside the embedded canvas. Its single-row
mobile toolbar also scaled with the chat reading font and could overlap the
utility buttons or extend past the canvas.

The correction is explicitly scoped to `data-platform=ios`:

- Let the chat header/composer own the vertical screen insets, and the Workbench
  panel own the horizontal cutouts it touches. Clear the embedded editor's
  duplicate inset variables.
- Wrap the drawing tools at normal editor heights, place utility tools below
  them, and keep icon hit areas at 44 CSS pixels regardless of reading size.
  Workbench tab/actions and whiteboard document actions also retain touch targets.
- Let the editor shrink within its allocated area. At short editor heights,
  use one horizontally scrollable tool row and compact the bottom action padding
  so controls do not cover the composer or one another.

No storage, model, routing, drawing-coordinate or host protocol changes are
included. The CLI is not affected: these are embedded App layout rules.
Android and desktop selectors retain their existing appearance.

## Verification boundary

`client/e2e/workbench-ios-layout.spec.ts` uses the real built App, Hub pairing,
Excalidraw and IndexedDB. Only native safe-area inputs and the platform hint are
supplied by the browser fixture; no editor geometry or drawing APIs are mocked.
The regression first reproduced a 77-pixel top gap and overlapping utility tools.

Coverage includes 430/375/320-pixel portrait layouts, Chinese/English, 18/20-pixel
chat reading size, visible and reachable drawing controls, asymmetric landscape
insets, drawing, undo/redo and reopening the saved board. Rotation waits for the
App's actual responsive layout change before measuring the new bounds.
Run in WebKit and Chromium. Existing Workbench conversation/split/composer checks
and the web/Android/iOS density cases guard shared layout behavior.

Local verification passed: four targeted cases in each of WebKit and Chromium,
seven existing Workbench/density cases in Chromium, and the client/host builds.

Browser results do not certify a physical iPhone, an installed native build,
system keyboard gestures or App Store distribution. This fix does not publish
or install a release. Keep screenshots and raw test evidence outside Git.
