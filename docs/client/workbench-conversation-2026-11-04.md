# Workbench follows the selected conversation

## Behavior

Opening Workbench in A used to leave the shared `rightMode` set to `workbench`.
Selecting B therefore opened B's Workbench too, even if the user had never opened
it there. Saved content was already conversation-scoped; the panel choice was not.

`Workspace` now keeps that choice by Host public key, user ID and conversation ID.
An unvisited conversation starts with its ordinary chat interface. Returning to A
restores A's open Workbench; explicitly closing B's Workbench keeps B closed on
the next visit. Each conversation retains its own tabs, saved expansion and drafts.
This choice is window memory, not a new persistent setting. Existing document
storage and reload behavior remain unchanged.

`useWorkbench` also checks controller ownership during render, before effects
restore a cached controller. Expansion comes from the same owner through a boolean
external-store snapshot. A late initialization for A cannot expose its surface or
context while B is selected. Hidden Workbench windows continue to unregister as
before. The remote-screen viewer remains Host-owned; explicitly closing it clears
any conversation panel choices that referenced that closed viewer.

## Verification

`client/e2e/workbench.spec.ts` covers desktop and phone navigation through A open,
B unopened, B independently opened/closed, A restored, B restored, and A closed
while B remains open. It checks tabs, drafts, A's expanded layout, and hidden Host
targets. Both new cases failed against the previous client build because B's
Workbench button remained `aria-expanded="true"`.

`client/e2e/workbench-adhd.spec.ts` delays A's native initialization, switches to B,
then releases A and returns to it. It uses the real App and isolated Hub with the
native IPC boundary simulated. Browser checks do not establish installed Mac,
Electron WebContentsView, or physical-phone acceptance.

The client translation/type/production build and standalone Host build passed.
The selected Chromium run finished with 15 passed and one initial failure in the
existing ADHD browser case (`markdown.create` returned `workbench_app_unavailable`).
That unchanged case passed three subsequent isolated runs; the original trace is
retained, and the first failure's cause remains unconfirmed. WebKit passed all
four selected cases (desktop/phone isolation, delayed initialization, phone return
alignment). No production change was made to mask the unconfirmed failure.
Evidence: `/Volumes/gdrive/taro-tmp.noindex/workbench-conversation-20261104/`.

## CLI and release boundary

CLI-not-applicable: this changes App navigation/presentation ownership. Workbench
commands, authentication, target selection and document formats are unchanged.
There is no version bump, release, global skill update or installed-App update.
