# Locate a queued message — 2026-10-24

Desktop pending-message rows now offer **定位到对话气泡** in their context menu.
The action closes the queue drawer and uses the existing conversation message
locator to reveal and highlight the exact original message. This works in the
ordinary chat and ADHD panes, including rows outside the current virtual window.

The menu also retains copy-message and copy-selected-text actions. Keyboard
users can focus a queue row and use Shift+F10 or the Context Menu key; Escape
closes the menu and returns focus to the row without closing the queue drawer.
Phone queue interaction and touch dragging retain their existing behavior.

The queue snapshot already contains the canonical conversation/message IDs.
Navigation uses those IDs, never row numbers or preview text. The live snapshot
invalidates a menu whose message has left the pending queue, and a reorder
cannot silently retarget an open menu. The menu is portaled into the native
dialog, so the dialog's modal top layer does not hide or disable it.

Location does not send, reorder, edit, cancel or dispatch a prompt. Both the main
composer draft and an unsaved queue edit survive closing/reopening the drawer.
The existing locator retains deleted/unavailable-source handling and the
reading anchor behavior after subsequent replies.

This is client navigation only. The queue protocol, execution semantics, Host
state and headless CLI commands are unchanged; no new CLI entry is applicable.

## Validation

Isolated Hub fixtures exercise two identical prompts in a 70-item history,
ordinary chat and ADHD, right-click and keyboard location, retained drafts,
unchanged queue revision, reorder with an open menu and removal of its target.
Related coverage checks existing queue editing, dragging, cancellation and
reading anchors. Receipts and screenshots are under
`/Volumes/gdrive/taro-tmp/queue-locate-message-20261024`.

- Chromium: all 30 queue, drag and message-location checks passed.
- WebKit: all 7 location, keyboard-editing and reading-anchor checks passed.
- Client translations, TypeScript and production build passed.

Browser acceptance and source publication do not update the installed App.
No installed App or Host was restarted, replaced or released for this change.
