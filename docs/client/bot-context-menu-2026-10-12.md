# Desktop Bot context menu — 2026-10-12

The sidebar's Bot row previously had no context-menu handler, so right-click
could open the WebView's Reload menu. It now owns a menu with **Bot settings**,
**New chat**, **Skills & MCP**, and **Runtime status**. Existing message and
conversation menus retain their separate meanings.

## Scope and interaction

- Right-click the Bot's avatar or name; Shift+F10 / the context-menu key also
  works. The existing shared menu handles focus, arrows, Escape, outside click,
  scrolling, viewport changes and edge positioning.
- Bot settings use the clicked Bot and its own Hub connection, even when a
  different host is active and both hosts have the same Bot ID. Opening settings
  does not switch chats, lose the draft, create a conversation, invoke an engine
  or write a session. Closing restores focus to the Bot row.
- The independent settings dialog reuses the existing avatar editor and effort
  control, including owner checks, offline restrictions and revision conflicts.
  Engine/model are displayed; model editing is not added by this change. Effort
  still belongs to the Bot and applies to all of its chats/groups/topics.
- Skills/MCP and runtime status open the existing panels for the clicked Bot on
  the correct host. Runtime status opens its dashboard, while the existing
  collaboration entry continues to open collaboration.
- New chat uses the existing creation flow with that Bot selected. Workspace,
  persona, memory, permissions and session semantics are unchanged. Settings
  also work before the Bot has its first conversation.
- No controls were added to the normal chat view. Phone navigation and message
  long-press remain unchanged.

## Verification

- Chromium: six focused checks passed (Bot context menu and host isolation,
  conversation rename, message reply/forward and effort synchronization).
- WebKit: the same six checks plus operations and collaboration passed.
- New coverage verifies first-chat independence, saved effort and untouched
  session data, preserved draft/focus, keyboard menu operation, correct tool
  requests and actual new-chat binding. A two-Hub test uses duplicate Bot IDs
  and proves only the clicked host's configuration changes.
- Root standalone build and 203 Vitest files passed: 2,736 passed, one skipped,
  using four workers and a 15-second timeout for existing cold-start cases.
  Client TypeScript/Vite build passed.
- A separate macOS Tauri preview connected to a disposable Hub/Gateway. Actual
  native right-click showed all four actions, opened Bot settings, saved high
  to low and returned to the unchanged draft. The runtime dashboard displayed
  the clicked Bot, low effort and zero bound sessions. Its saved configuration
  and unchanged empty session file were independently read back.
- This native fixture used a non-invoked engine double. Installed TaroBot, real
  Hub/Bot processes and the legacy Feishu service were not changed or restarted.
- The standalone package and extracted npm archive were separately installed
  outside the checkout. Both started the Hub and served client assets without
  the Feishu SDK, credentials or CLI.

## Prerelease

`v0.1.390-test.1`: macOS Apple Silicon `1.0.17`; Android `0.1.390-test.1`,
versionCode `2026101205`. Packaging checks cover APK signature/version and
bundled client asset equality, DMG mount/bundle signature, embedded host/client
versions and asset equality, and SHA256SUMS.

Android retains the private test signer. macOS is ad-hoc signed, not Apple
notarized. No Android device was attached: APK build/inspection is not physical
Android acceptance. Real engine, voice and relay acceptance were not rerun for
this menu-entry change.
