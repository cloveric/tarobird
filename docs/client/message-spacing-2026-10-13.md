# Compact desktop message spacing

Desktop messages no longer reserve a hidden action row below every bubble.
Copy, reply, forward, export and retry share the author/time row, appearing on
hover or focus without changing the measured message height. User timestamps
stay on the right; CLI timestamps stay on the left. Row padding totals 10px.
Text size, bubble padding and phone touch targets remain unchanged. Export
results/errors can wrap without pushing controls outside a narrow window.

## Verification

- Client build and repository pre-complete gate: 227 suites, 2,914 passed,
  one existing skipped test.
- Compact layout regression: Chromium and WebKit; 1360px and 800px; default,
  CLI and pixel. Checks 8–16px between content and the following metadata row,
  real button hit testing, focus visibility, unchanged row positions on hover
  and focus, and quoting the correct user message.
- WebKit: attachment quote/forward/preview, phone message sheets, offline
  forwarding, desktop/phone reading anchors and streamed card widths passed.
  An attachment test initially lost its trace during simultaneous output-folder
  cleanup; its isolated rerun passed.
- The iPhone-UA simulated-touch reading fixture fails before its acceptance
  assertions because no delayed Markdown row remains above the chosen anchor.
  The same failure was reproduced with the unchanged HEAD versions of App.tsx,
  brand-theme.css and expressive-themes.css supplied to Vite. This existing
  fixture limitation is not an iPhone-device acceptance result.
- A separately identified native Mac preview paired with a disposable local
  Hub. Three user/Bot exchanges rendered compactly; the relocated reply button
  selected the intended message and focused the composer. No real host or
  installed application was replaced.

Mac installer: 1.0.49. This desktop spacing change does not require a phone
update. Android version defaults advance with the shared client version, but
no new Android installer is delivered for this change.
