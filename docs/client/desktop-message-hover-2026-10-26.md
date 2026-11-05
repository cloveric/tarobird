# Desktop message toolbar focus repair

The desktop quote/forward/copy toolbar stayed visible after a mouse click on a
message or a running reply, even after the pointer left. The shared CSS used
`.message:focus-within` as an unconditional visibility trigger. Message articles
and native run sections are focusable, so pointer focus could keep one toolbar
visible while hovering another message showed a second one. This was reproduced
on the unmodified client in WebKit: after clicking the prompt and moving onto
the streaming reply, the prompt toolbar still had opacity 1 instead of 0.

Simply hovering the rotating reply indicators, without clicking first, passed
in both Chromium and WebKit. The reproduced focus path explains a persistent
toolbar; it does not establish that every reported native hover-only occurrence
has the same cause. The installed desktop WebView was not changed or accepted
in this task.

## Change

`styles.css` retains the normal hover trigger, and replaces unconditional
focus-within visibility with focus-visible on the message or a descendant,
gated by the existing focus-intent tracker. Pointer clicks and pointer-return
focus from dialogs therefore do not pin a toolbar. Keyboard navigation still
reveals it. No focus is forcibly blurred, no per-message listeners or streaming
state updates are added, and row measurements remain unchanged.

Phone messages continue to use the existing hold menu. Their toolbar-free
presentation and touch targets are unchanged. Reply status, Stop, process
details, quote/forward availability and message contents are unchanged.

This is App presentation only. Host/CLI APIs, schema, messages, queues and
runtime behavior do not change; no headless command is applicable.

## Verification

- Added `message-actions-hover.spec.ts`, enabled in the WebKit configuration.
  It covers 900/1360 desktop widths, dark monochrome/light purple, animated
  reply indicators, repeated streaming updates, clicks on prompt/run/copy,
  pointer leave without scrolling, keyboard quote and process-dialog return.
  Latest targeted run: Chromium 2/2 and WebKit 2/2 passed.
- Existing compact layout regression now uses keyboard navigation instead of
  treating programmatic pointer-focus restoration as keyboard intent. macOS
  WebKit uses Option+Tab; its sequential cursor can remember the last clicked
  descendant, so the new test starts navigation from the Copy control.
- Related message-actions/context-menu/hold coverage: Chromium 11/11 passed.
  WebKit had 9 existing cases pass and 2 new test-fixture navigation failures;
  the corrected new cases then passed 2/2. This includes phone sheet lifetime,
  cross-device rich quote/forward, archive/streaming restrictions, desktop
  geometry, context menus and Android/iOS/web hold-feedback ownership.
- Client translations, TypeScript and production build passed. Initial probe
  fixture mistakes (waiting for a continuously rotating SVG to become stable,
  and omitting the native run's status element) were corrected before final
  assertions. A Firefox probe could not launch because its browser executable
  is not installed; no Firefox acceptance is claimed.
- The previously documented desktop WebKit offline-banner/forward-click case
  was excluded from this focused run; it is unrelated to focus visibility and
  remains unresolved. See the phone message menu report for its baseline proof.

Screenshots and traces are retained in local test evidence; they are synthetic
browser acceptance, not an installed Mac or physical phone round trip. No
release, installation, Host restart or production-state write was performed.
