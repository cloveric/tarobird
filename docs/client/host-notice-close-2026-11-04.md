# Host notice close control

The update-waiting notice is fixed over the conversation title bar. Its DOM
stacking order did not exclude it from the underlying Electron window-drag
region, so mouse input over the close control could be consumed as window
interaction. Electron documents this overlap behavior in
[custom window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).

`desktop-window-chrome.css` now excludes only the fixed `.host-error` rectangle
from native dragging. The rest of the title bar remains draggable. While a
modal makes the notice inert, the exclusion is removed so it cannot subtract
from the modal's own window handles. Browser/mobile styling is unchanged.

Closing still dismisses presentation only. Existing local recovery continues;
repeated reports of the same issue stay dismissed, a different issue appears,
and recovery clears the notice. Host lifecycle and headless CLI need no changes.

Verification covers the failing-before/fixed-after renderer region check,
modal and ordinary-content drag boundaries, and actual HostApp dismissal with
Chinese/English copy and repeated recovery polling. Native IPC/network are
fixtures in that HostApp test; saved identities and drafts remain intact.
The two browser suites passed 11 checks in Chromium, the three related
controller suites passed 42 checks, and both Host and client builds passed.

This is a source correction, not a published or installed update. Native mouse
acceptance is pending: the computer-use native pipe could not start. Browser
clicks and computed CSS regions do not establish native OS hit-test acceptance.
