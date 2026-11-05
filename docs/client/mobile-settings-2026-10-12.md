# Mobile chat names and Bot settings

Mobile users can now open **重命名对话** or **Bot 设置** directly from the
chat header's `…` menu. The Bot tab and Bot search results also expose a settings
gear, including for a Bot with no conversations. On narrow phones the adjacent
new-chat action uses its existing plus icon and accessible name to leave room
for the Bot name and 44px settings target.

Renaming reuses `RenameConversation`: the input selects the existing name,
ignores IME-confirmation Enter, trims input and waits for a durable Hub receipt.
The online conversation owner may rename it; the action changes only metadata,
leaving the draft, message history, binding and session intact.

Bot settings show the avatar, engine and model, plus the existing effort and
permission controls. A group explicitly selects the Bot to edit. Choices come
from each engine/model's settings API, with owner checks, revision conflicts
and deferred-application semantics unchanged. These settings apply to that
Bot's conversations, not just the currently open conversation. They do not
invoke an engine or reset a session.

Bot-row actions include a host ID. `HostApp` routes cross-host settings to that
host's workspace, displays its name, and restores focus to that host's Bot row.
Closing nested settings uses the existing native-back/dialog stack. Hidden
workspaces close their dialogs.

Regression journeys: `mobile-settings`, `mobile-im`, `effort`, `permissions`,
`bot-context-menu`, `conversation-rename` and `conversation-settings`.
Browser, build and physical-device results must be reported separately; this
change does not publish a release or update an installed phone App.

Validation on 2026-10-12:

- Client TypeScript, translation checks and Vite production build passed.
- Chromium: all 29 related browser journeys passed, plus all three new mobile
  journeys rerun after making the offline fixture browser-independent.
- WebKit: 29 distinct journeys verified. The initial run passed 28; the offline
  test assumed browser network emulation closes an existing WebSocket. It now
  stops the isolated Hub instead, and all three new mobile journeys passed.
- Screenshots reviewed at 390px and 320px: chat menu, group Bot selector and Bot
  list settings entry. Android native-back events were simulated in browsers.
- Capacitor sync and Android `assembleDebug` passed; `testDebugUnitTest` was
  up-to-date. No physical phone, installed App upgrade or real model invocation
  was performed for this UI change.
- Standalone pre-complete gate passed: build plus 214 test files, 2,828 tests
  passed and one existing skipped test.
