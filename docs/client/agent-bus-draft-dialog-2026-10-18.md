# Agent Bus draft confirmations

The leave confirmation previously inherited the 540 px creation form, with
unstyled paragraph and footer children. The copy ran directly into two
left-aligned controls, and the discard action looked like plain text.

`AgentBusDraftDialog` now provides the leave and reload confirmations:

- A 420 px dialog with a compact heading and close control.
- Separate consequence and retained-work sentences, using theme text tokens.
- Equal-height, right-aligned actions: an outlined discard/reload action and
  the theme-primary **Keep editing** action.
- Initial keyboard focus on **Keep editing**. Enter, Escape and Close retain
  the draft. Discard/reload requires an explicit choice.
- An accessible description linking both sentences to the dialog. The shared
  `CreationDialog` only adds an optional `aria-describedby` value; existing
  callers retain their behavior.

Collapsing the Bus dock still retains the editor. Switching Buses or leaving
the board still uses the existing dirty-content guard. Reload replaces local
configuration edits while keeping the unsent task. This is desktop UI only:
no Hub, protocol, queue, execution or headless CLI changes are needed.

## Verification

The three focused `agent-bus-workspace` browser journeys passed in Chromium
and WebKit (six engine/case combinations):

- Collapse/reopen, retained configuration/task drafts, explicit discard and
  switching. Includes light/dark layouts at 1360/1024 px, equal-height aligned
  actions, separate copy/actions, accessible descriptions, safe Enter/Escape/
  Close, and keyboard focus restoration.
- Stale-configuration recovery, safe default Enter and task retention on reload.
- Bus return without outer scrollbars across desktop breakpoints; ordinary
  conversation scrolling and drafts remain usable.

Layout measurements wait for the dialog's entry animation to finish. The
focus-restoration check opens the dialog by keyboard; WebKit pointer clicks do
not necessarily focus their button. Initial test failures from measuring during
animation and assuming pointer focus were corrected in the test, not by changing
browser focus behavior or weakening the geometry assertions.

Client production build, TypeScript and translation-key validation passed.
Screenshots were inspected in both light and dark themes. These are browser
checks of the production client with an isolated Hub and controlled Bus API
responses, not native installed-App or real-agent execution acceptance. No full
host regression rerun is claimed for this presentation-only change. This change
does not publish a release or replace the installed Mac App.
