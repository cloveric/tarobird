# Keyboard-bounded composer suggestions

The phone slash-command popup had an upward absolute anchor but no height cap
or internal scrolling. A Pinyin keyboard/candidate strip reduced the chat height
while all nine suggestion rows still rendered, putting the top rows behind the
system status bar. Group `@Bot` suggestions used the same unbounded markup.
A separate `slice(0, 9)` in the client also omitted the rest of the slash-command
catalog, making those commands unreachable even after scrolling was enabled.

`ComposerSuggestions` now measures the space between the composer and the top
of the message region, leaving the header, topic strip and notices accessible.
Both menus scroll within at most 288 CSS pixels and the actual remaining space.
Slash suggestions now render the complete engine-filtered Gateway catalog, with
prefix filtering preserved. A thin scrollbar indicates the scrollable area;
closing the keyboard keeps the full list available inside the same bounded menu.
ResizeObserver updates the limit before paint; visual-viewport resize/pan and
window resize are coalesced. Observers/listeners are removed on unmount. If there
is not enough room for one 44px touch row plus padding, the popup hides until
space returns. The draft remains editable.

Choosing a command or recipient preserves composer focus; compatibility mouse
events do not dismiss the keyboard. Native touch scrolling is not cancelled.
Existing IME Enter guards remain in place.

## Validation

- The slash-menu geometry assertion failed against the original client; the
  complete-catalog assertion independently reproduced the nine-row truncation.
- Client TypeScript, translation checks and production build passed.
- Chromium: all 10 journeys in `composer-suggestions`, `composer-ime`, `keyboard`,
  `safe-area` and `command-parity` passed, including a trusted browser touch swipe
  that scrolls the menu without selecting a command or moving the chat history.
- WebKit: the same 10 journeys passed on the final implementation.
- Coverage includes 48px safe top inset, 280–500px simulated keyboard viewports,
  visual panning, closing/reopening the keyboard, native-sized window resize,
  landscape, synthetic Pinyin confirmation, scrolling to the last option,
  restored focus, a 14-Bot group and a quote/file draft. Small-space hiding and
  subsequent restoration preserve the draft and attachments; selecting a
  suggestion does not send a message.
- The test Bot's entire 34-command catalog is present with the keyboard open or
  closed; its last command can be scrolled to and selected. `/cr` still filters
  to `/cron`. Gateway engine filtering remains authoritative. WebKit verifies
  scrolling/selection but does not inject a trusted Chromium touch gesture.
- Android Capacitor sync and `:app:assembleDebug :app:testDebugUnitTest` passed;
  the unchanged native unit-test task was up to date.
- The repository pre-completion gate passed: root build and 213 test files,
  2,823 passing tests with one existing skip.

These are browser viewport/IME simulations and a native build, not acceptance on
the user's phone or physical Pinyin keyboard. No release was published and no
installed App or unrelated service was replaced/restarted by this change.
