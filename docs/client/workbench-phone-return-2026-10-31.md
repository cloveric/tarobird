# Workbench alignment after returning to a phone conversation

Opening a whiteboard, returning to the conversation list with the chat header's
Back button, then entering the same conversation left a persistent gap on the
left. The production browser reproduction measured the workbench's left and
right edges 28 CSS pixels past the message area's edges, after navigation motion
had finished. The shifted content also extended beyond the right edge.

`useSceneMotion` translates the arriving conversation by 28 pixels. Workbench's
expanded/phone positioning read `getBoundingClientRect()` during that animation
and saved the transformed coordinates. Ending a transform does not change the
layout size, so its ResizeObserver never corrected the saved position.

The overlay now uses the message area's layout offsets through the positioned
ancestor chain, including intermediate borders, and its layout width/height.
Navigation motion remains enabled. Size changes still update the overlay via
the existing observer; desktop expansion and compact ADHD cards use the same
positioning code. No timer or continuous animation-frame polling was added.

The new production-UI regression uses a real isolated Hub and browser storage.
It opens a saved board, leaves/re-enters twice, waits for the actual navigation
animation, and verifies all four edges plus the original board ID and unsent
composer draft. It failed against the unmodified source with left/right offsets
of 28 pixels. Evidence is in the local `workbench-phone-gap-20261031` task.

Validation after correction: Chromium **13/13** and WebKit **13/13** passed
across `workbench.spec.ts` and `workbench-adhd.spec.ts`, including phone return,
desktop split/expanded geometry, narrow layouts, board persistence, drafts and
ADHD lifecycle. Client TypeScript, translation checks and the full Vite build
passed. The phone preview was checked visually with no remaining left offset
or clipped right-side controls.

CLI impact: App layout only; no changes to Host commands, workbench operations,
storage formats, board content or permissions. Browser evidence is distinct
from physical Android/iPhone acceptance. This correction does not publish a new
version or replace an installed App.
