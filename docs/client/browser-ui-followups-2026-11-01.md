# Browser and workbench UI follow-ups (2026-11-01)

## Presentation fixes

- CLI sidebar portraits were compact only under `.bot-identity`. Conversation rows,
  including the ADHD chooser, now share the 26px portrait footprint while retaining
  the row hit area, online dot and activity badge. Composite group portraits use
  proportional columns inside that footprint. Other themes and chat portraits retain
  their existing sizing.
- The ADHD personal browser header used a fixed 44px height. A scoped ResizeObserver
  now follows the adjacent board toolbar, including theme/density/window changes;
  native browser bounds are rescheduled only when the measured height changes.
- Phone workbench-library filters inherited a 16px form field floor intended to
  prevent focus zoom. Their selected labels now use a 13px presentation layer over
  the original native select. The native focus floor, accessible name, platform
  picker, keyboard interaction and 44px target remain; desktop selects are unchanged.
- Attachment thumbnails no longer reserve a row for Add to whiteboard. On desktop,
  the command lives in the image context menu, also reachable with Shift+F10.
  Capture-phase handling keeps the delegated message menu from stealing the event.
  Mobile thumbnails expose no whiteboard shortcut; preview/save/share remain.
  The action uses the authenticated original Blob and its exact attachment ID,
  retains the existing conversation-bound workbench route, and serializes repeated
  clicks with existing export activity. Late feedback cannot attach to another image.

These are App presentation changes. Headless CLI, Host capabilities and Bot authority
are unchanged. Browser extensions/login are recorded in their separate feature guide.

## Validation

12 targeted Chromium checks passed: desktop image preview/menu and exact image-to-whiteboard action; iPhone/Android action omission; ADHD header geometry and registration retry; CLI conversation/ADHD portraits; library filters, scope navigation and Chinese/English layouts. Phone cases use touch browser emulation, not physical devices.

Client translations, TypeScript and Vite build passed against the final production changes. Existing large-chunk and Capacitor import warnings remain. Native browser surfaces are substituted in the ADHD fixture; this does not establish Electron extension or Google-account acceptance.

Receipts: `root-ui-final.log` (12/12) and `root-build2.log`, with screenshots under
`/Volumes/gdrive/taro-tmp.noindex/browser-ui-followups-20261101/`.
All data is isolated test data; owner images/files/history were not changed.
No release or installed App replacement is part of this task.
