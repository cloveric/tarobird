# Conversation details: scope and navigation

The old phone directory mixed conversation, shared Bot configuration and host tools, with a large identity header and duplicate destinations. Version 0.1.405-test.1 (native client 1.0.32) uses a compact identity and three distinct groups.

- Current conversation: name/notifications/context settings; files defaulting to this conversation; group settings only for a group or its topic, with the parent group named.
- Bot: a single shared settings page for persona, effort and permissions, all Bot conversations, and an independent new chat. A group retains its selected Bot. Engine/model are shown inside Bot settings; `/model` and other slash commands remain available in chat.
- Host tools: collapsed by default, retaining a visible connection summary. The expanded group contains workspace files, Skills/MCP, the selected Bot's activity/usage dashboard and connection settings.

Bot avatar/config/board/goal shortcuts no longer clutter conversation management. Context recovery remains in its existing advanced section; message history and Bot persona are unchanged.

Child directories suspend the full-screen details view so native dialogs do not occlude custom workspace/operations panels. Returning restores the entry, scroll position and selected Bot. Details and conversation management have distinct React keys, avoiding an unintended details remount. Nested native cancel events stop propagating so closing one dialog does not close its parents. Details are exempt from bottom-sheet height limits, with safe inset padding still applied.

## Verification

- Standalone build/test gate: 221 files, 2,862 passed, 1 skipped.
- Chromium: 39 distinct scenarios across focused runs; repaired navigation, nested Back, group settings and safe-area scenarios were rerun successfully.
- WebKit: 29 passed, covering details, settings lifecycle, cross-device effort/permissions, persona drafts, conversation management, groups and native Back event bridge.
- Actual browser screenshots: porcelain, monochrome light/dark and 320 px narrow layout. Reduced motion is used only for stable screenshot capture.
- Actual Claude Opus 5.5 read-only review compared before/after images and source. Follow-up accessibility, icon and missing-parent-label suggestions were incorporated.
- Android release build, unit tests and lint passed; the signed APK retains the prior signing certificate and all 372 packaged public assets match the build.
- macOS bundle signature, final DMG contents, release icon checks, public asset hashes and local runtime update are recorded separately in release verification evidence.

Browser/native-event simulations do not establish physical-phone acceptance. This change does not enable background push. The requested notification experience is TaroBot alone, without requiring a separate ntfy receiver; lock-screen delivery remains a separate, unverified integration.
