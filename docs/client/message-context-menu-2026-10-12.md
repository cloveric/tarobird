# Desktop message context menu — 2026-10-12

Right-clicking an answer previously reached the WebView's default menu, which
could show only Reload. Message rows now own their context menu, including the
card's tables, links, code blocks and attachments. This changes the entry point,
not quoting, forwarding, attachment permissions or session semantics.

## Interaction

- **Reply** places the original message in the composer, preserves any draft and
  focuses the input. The existing quote path supplies message/file context to
  the Bot. Archived conversations retain the existing reply restriction.
- **Forward** opens the existing conversation/group/topic picker. The original
  card, text, attachments and source attribution are retained. Attachments are
  cloned into the destination's access scope; interactive card actions remain
  read-only. Streaming messages cannot yet be forwarded.
- **Copy message** copies the whole readable message; selecting text inside the
  same row adds **Copy selected text**.
- Shift+F10 / the context-menu key also opens the menu. Arrow keys navigate;
  Escape closes and restores row focus. Reply owns composer focus; opening a
  forward dialog preserves a return target.
- Clicking outside (including the source row), scrolling, resizing, switching
  conversation/host or leaving the visible workspace dismisses the menu. Live
  content and status are resolved by message ID; deleting a source closes it.
- Editable question fields retain cut/paste/undo. Phone long-press retains the
  existing action sheet. No extra controls were added to the default chat view.

`useComposerSize` also defers width-driven height writes to an animation frame.
The new desktop-to-phone regression exposed WebKit's ResizeObserver delivery
warning; the fixed scenario passed three consecutive WebKit runs without
suppressing page errors. Normal draft sizing still happens in layout effect.

## Verification

- Chromium: message context menu, native text-edit menus, conversation rename,
  phone hold and cross-device message-action regressions passed; composer IME
  and final message-menu checks passed against the final client build.
- WebKit: the same menu/rename/phone/cross-device paths passed. Composer IME and
  all message-send-continuity scenarios passed (20 checks in the additional
  run). The new context-menu scenario then passed three consecutive runs.
- New menu coverage includes table/code/link/file right-clicks, preserved draft
  and focus, persisted replyTo, real attachment preview after forwarding,
  selected-text copy, keyboard operation, viewport bounds, scroll/chat/layout
  dismissal, live streaming guard and source deletion.
- Root standalone build and all 203 Vitest files passed: 2,736 passed, one
  skipped. The default five-second run first timed out on cloud-ASR routing and
  cold engine discovery. A full rerun with four workers and a 15-second timeout
  passed; no assertions were relaxed or production discovery behavior changed.
- A separate macOS Tauri bundle connected to a disposable Hub. Native right-click
  on a table and code block showed Reply/Forward/Copy instead of Reload. Reply
  traversed App → Hub → Gateway, and the fixture captured the original card,
  filename and user's text. Forwarding preserved the card and attachment; the
  destination attachment opened successfully. Final-build menu behavior was
  checked again after the composer fix.
- The Gateway's engine was a test double, not a real Codex/Claude/DeepSeek call.
  Existing installed App, real Hub/Bot services and legacy Feishu data were not
  modified or restarted.
- Standalone package and extracted npm archive were separately installed outside
  the checkout. Both verified Hub startup and served client assets without a
  Feishu SDK, credentials or CLI.

## Prerelease

`v0.1.389-test.1`: macOS Apple Silicon desktop version `1.0.16`; Android
`0.1.389-test.1`, versionCode `2026101204`. Android retains the existing private
release-test signer. macOS remains ad-hoc signed and not Apple notarized.

Packaging checks include signed APK verification, DMG mount and bundle signature,
embedded host/client versions, bundled client asset equality and SHA256SUMS.
No Android device was attached, so this is not physical Android acceptance.
Broader real-engine/voice/relay acceptance was not rerun for this UI-only change.
