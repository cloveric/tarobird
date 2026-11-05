# ADHD selection when returning to ordinary chat

The board tracked its focused pane separately from the ordinary host/chat
selection. Leaving through “按对话”, “按 Bot” or “返回聊天” only restored that
old ordinary selection. A user could visibly select one pane and then land in
another conversation, including on the wrong host.

`AdhdBoard.leave` now captures the focused pane's host, registration and
conversation before the existing draft and Agent Bus guards run. `HostApp`
validates that identity and conversation against current state, then uses the
ordinary select command to open it and focus its composer. A selected group
topic stays that topic. Changing focus while a draft save delays the transition
does not change the captured destination.

When no pane is selected, or its host registration/conversation is no longer
available, the previous ordinary-chat fallback remains. Saved board membership,
independent drafts, upload/recording guards and conversation content are not
changed. Offline cached conversations on an existing ready registration remain
eligible; a connection need not currently be online to read its cached chat.

CLI impact: not applicable. This is an App presentation/navigation change using
existing conversation selection and local draft storage. No Host API, protocol,
model adapter or CLI behavior changes.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp/adhd-return-selection-20261023/`.

- `baseline.log`: both added browser journeys fail on the preceding client.
  The single-host case expects the focused chat but receives the pre-board chat;
  the two-Hub case fails to open host A's history after focusing its pane.
- Browser coverage includes pointer, keyboard and sidebar selection; direct
  chats and group topics; all three exit controls; two local Hubs with identical
  conversation IDs; empty/reopened boards; independent drafts; delayed writes
  with a subsequent focus change; failed-save/discard; sidebar and density
  preference preservation.
- `webkit.log`: all 7 selected browser journeys pass.
- `chromium.log`: 6 journeys pass; the new repeated-entry journey initially
  clicked a checkbox while the saved board was still loading. The test now waits
  for the board's existing ready control. `chromium-final.log` passes both new
  journeys three times each (6 executions); all 7 selected journeys are covered
  successfully across the two Chromium runs. Production code was unchanged
  between those runs.
- `unit.log`: 7 board-state and scoped-connection tests pass.
- `client-build.log`: translation check, TypeScript and client production build
  pass. The existing Capacitor keyboard import warning remains nonfatal.
- `host-build.log`: standalone build passes with no retired transport imports.

The browser fixtures use isolated local Hubs and stub model replies. No real
user conversation was mutated, no installed App/Host was updated, and no native
macOS/Windows installation or release is claimed.
