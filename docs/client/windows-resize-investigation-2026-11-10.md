# Windows edge-resize investigation

Issue #21 remains unresolved. The reported Windows window sometimes refuses
edge resizing and recovers after another edge is dragged. The reporter confirmed
that no side conversation, workbench, screen-control panel or embedded browser
was open, and later recalled that the top edge might have been the working one.

The review used the current Electron 45.2.3 desktop implementation. Windows
retains its native frame; the App's draggable HTML regions are installed only
for the Mac window. Panel minimum-width protection is owned by the side-window
lease and cleared on document retirement. Those paths do not establish an
explanation for the reported no-panel failure.

Independent review passed the existing 36 side-window controller checks and
10 desktop service checks. An isolated synthetic scheduling probe found no
minimum-width residue in 1,500 trials without injected failures. Injecting
repeated failures of the minimum-clear call can leave simulated residue, but
the real main process also restores that minimum when retiring a document.
This is not evidence that such a failure occurred on the reporter's machine.

There is no Windows reproduction or installed-App acceptance in this audit.
The missing observation is the native hit-test result at an unresponsive edge,
together with window geometry, snapping/DPI, minimum size, and whether another
window covers the edge. A Mac/browser test cannot provide that evidence. No
timer, forced resize, or resizable-toggle workaround was added, and the issue
must remain open. This is an investigation record only; no Host or CLI behavior,
version, installer or release changes are included.
