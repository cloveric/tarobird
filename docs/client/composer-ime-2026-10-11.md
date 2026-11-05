# IME confirmation must not send a chat message

The desktop composer only checked `KeyboardEvent.isComposing`. macOS WebKit
can dispatch `compositionend` before the Enter that commits a Pinyin candidate
or Latin word, so this check can already be false. The resulting Enter was
incorrectly handled as Send. See the [WebKit event-ordering report](https://bugs.webkit.org/show_bug.cgi?id=165004)
and [MDN keydown guidance](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event).

`client/src/App.tsx` now also recognizes the IME's `keyCode === 229` and ignores
held-key repeats for sending. The event remains available to the input method;
there is no timeout, debounce, draft rewrite or change to message/session state.
A subsequent ordinary Enter sends immediately; Shift+Enter still inserts a line
break and coarse-pointer phone input keeps its existing behavior.

## Verification

- The new `composer-ime` browser journey reproduced the original failure before
  the fix: WebKit-ordered confirmation was intercepted as Send.
- English `hello` and Chinese `你好` regression journeys passed in Chromium and
  WebKit, covering composition, confirmation with `isComposing: false`, held
  Enter, retained draft, Shift+Enter, then exactly one Hub-persisted message.
  These replay DOM event sequences; they do not drive a physical OS IME.
- A separately identified Tauri preview (`com.tarobot.ime-preview`) connected to
  a disposable loopback Hub. Native ordinary Return sent one message; native
  Shift+Return retained a two-line draft, and Return then persisted exactly
  `line one\nline two`. No live Bot, production host or installed App was changed.
  The preview and temporary Hub were stopped after verification.
- The system Pinyin candidate window could not be driven through the automation
  interface; actual Pinyin confirmation on a user desktop remains to verify.
  No physical Android/iOS keyboard acceptance is claimed.
- Of the four existing mobile viewport journeys, three passed on each engine.
  The quoted-attachment case fails its composer vertical-bounds assertion on
  both engines. A separate baseline build with the old Enter handler reproduced
  that same failure in Chromium; it is not introduced by this shortcut fix and
  remains open. The regression was not weakened or marked passing.

## Delivery

Pre-release `0.1.378-test.1`: macOS App 1.0.5 and Android version code 2026101106.
This fix lives in the client UI. Install the updated client and reopen its
window; the background Hub and Bot processes do not require a restart.

## Alt/Option+Enter addition — 2026-10-16

The desktop composer now accepts Alt+Enter on Windows and Option+Return on
macOS to insert a newline, including replacing selected text. Ordinary Enter
still sends, and Shift+Enter still inserts a newline. IME composition and its
confirming key retain priority over both sending and the new shortcut.

The shortcut explicitly inserts text because Chromium and WebKit do not insert
a newline for Alt+Enter by default. Native `insertLineBreak` preserves the browser
undo stack and uses the normal input/draft-save path. A controlled-draft fallback
handles WebViews that reject this command, with the caret placed after the
newline. The composer hint includes Alt+Enter in Chinese and English.

This is a client keyboard interaction. There is no new host capability or
headless CLI command, and no engine-specific behavior.

Verification artifacts are on the mounted disk at
`/Volumes/gdrive/taro-tmp/tarobot-alt-enter-20261016`. The new browser journey
reproduced the old failure: Alt+Enter sent the draft and cleared the input.
Client translation checks, TypeScript and the production bundle build passed.
All six `composer-ime` / `composer-size` journeys passed on each of Chromium
and WebKit, including selected-text replacement, undo from a restored draft,
continued typing, reload persistence, the native-command fallback, IME
confirmation, Shift+Enter, ordinary Enter sending exactly once, and sizing.
WebKit may group consecutive typing with a newline in its native undo stack;
the undo check starts from a restored draft to isolate the shortcut edit.
These are browser-engine checks on macOS, not Windows WebView2 or installed
macOS App acceptance. This change does not itself install or publish a native
release.

## Mac shortcut correction — 2026-10-16

The requested Mac shortcut is **Command+Return**, not Option+Return. The
composer now handles Command+Return as a newline and shows `Shift / ⌘ + Enter`
in its Mac hint. Ordinary Return still sends. Shift+Return and the previous
Option+Return alias continue to work; Windows keeps Alt+Enter. IME confirmation
and held-key protection run before shortcut handling.

Client translation checks, TypeScript and bundle build passed. Seven browser
journeys passed on each of Chromium and WebKit: Command/Alt newline insertion,
selection replacement, undo, reload persistence, fallback insertion, IME
confirmation, ordinary Enter sending once, and composer sizing/scroll stability.
Evidence: `/Volumes/gdrive/taro-tmp/tarobot-cmd-enter-{chromium,webkit}` and the
adjacent logs. Platform-specific tests set the reported browser platform; these
are browser-engine checks, not acceptance in an updated installed native App.
This client-only shortcut adds no host capability or standalone CLI command.
No installer was published or installed as part of this correction.
