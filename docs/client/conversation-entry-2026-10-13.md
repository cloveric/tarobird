# Stable conversation entry — 2026-10-13

The reported symptom was message content moving vertically when opening a chat,
while the composer and chat viewport stayed in place. An isolated real-Hub
browser reproduction showed earlier rows before the latest message, followed by
additional movement when estimated heights and Markdown layout settled.

## Repair

`client/src/App.tsx` now keys virtual measurements by message ID. Conversations
with the same number of differently sized rows cannot inherit each other's
measurements by row number. Hidden chats disconnect their scroll observers;
reopening no longer clears all measurements and rebuilds from estimates.

While following the latest message, the virtual range mounts that destination
immediately, and a layout effect requests the virtualizer's end position before
paint. Search/reference targets and explicit history reading retain their own
position. A queue with no history still follows its actual DOM content.

The latest row's callback ref tracks its actual mounted element. A separate
ResizeObserver follows its visible bottom when asynchronous Markdown changes
its height, without waiting for the virtual spacer's next-frame measurement.
This observer changes only the scroll offset. Virtualized React measurement
updates remain deferred to avoid WebKit ResizeObserver loops. Pending rows and
keyboard/composer viewport resizing use the same follow-versus-history guard.

## Regression contract

`client/e2e/conversation-entry.spec.ts` uses real temporary Hubs, IndexedDB,
WebSockets and the application's Markdown worker. It alternates equally sized
histories containing short or tall rows, with either a user message or a long
Bot reply at the tail, on desktop and phone layouts. It also reopens the same
phone chat from the inbox.

Frame samples assert that the latest message is visible on the first displayed
frame and its bottom does not drift by more than two pixels while layout settles.
The sampler records observed row heights: if a worker changes the DOM after
paint but before the sampling timer, that not-yet-displayed layout waits for its
ResizeObserver delivery. Missing or offscreen tail rows are never excluded.
The viewport and composer must stay fixed, and page errors—including observer
loop errors—fail the test. The new suite is included in the WebKit configuration.

Running this same final regression against the previous `App.tsx` failed in
WebKit, with earlier rows flashing and up to 279 pixels of tail movement.

The repaired source passed **64 Chromium and 64 WebKit tests**, covering entry,
history reading and touch compensation, history refresh, pending-send continuity,
outbox reconciliation, keyboard resizing, multi-host isolation, search and
streaming cards across themes. Both the standalone host build and the client
translation/TypeScript/production build passed; `git diff --check` was clean.

The original video was unavailable at its supplied path. These are independent
source reproductions and browser regressions; they do not establish acceptance
of an installed macOS or Android build. This change does not publish a release,
replace an installed App, or restart live services.
