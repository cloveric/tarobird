# Group context menu and membership settings

Root group rows now have Group settings, Add / remove Bots, Pin / unpin,
Rename group and recoverable Delete group. The avatar, title and expansion
button share the context target; Shift+F10 also works from the expansion button.
Direct chats and topics retain their own conversation actions.

The same settings dialog is available from desktop and phone conversation
details, including when viewing a topic. It edits the parent group's name,
avatar and members. Sidebar edits stay on the clicked host without navigating
away from another chat or discarding its draft. Unsaved edits require an explicit
discard; offline users can inspect settings but cannot save.

The authenticated `PUT /api/groups/:id/settings` endpoint uses a transaction-time
session check, conversation-creator ownership and grant checks for new Bots.
Expected title and member IDs prevent stale cross-device overwrites. Retrying
an already-applied update is harmless. Topic memberships (also archived topics)
change atomically with the group, while topic titles, IDs, bindings, messages,
user membership and notification settings remain intact. All connected clients
receive conversation updates; reconnect loads current state. Pending deliveries,
streaming messages and pending actions block removal of the affected Bot until
its task is settled. Adding a Bot never replays old messages to it.

No production Hub, installed App or legacy service was restarted or changed.
The installed `/Applications/TaroBot.app` was inspected read-only: version 1.0.14,
which predates several prior sidebar menu changes. The new packaged desktop
version is 1.0.21; its matching Hub is 0.1.394.

## Verification

- Standalone build: 281 modules, no legacy transport or Feishu SDK.
- Full repository gate: 206 files, 2,746 passed, 1 skipped.
- Focused Hub authorization, inheritance, pending-work and revocation checks:
  20 passed. Chromium: 10 relevant cases passed (three newly added cases were
  rerun after aligning their pairing wait with the existing test helper).
  WebKit: 16 passed, including Bot/text menus and group/topic navigation.
- Client clean install, translations, TypeScript and production build passed.
- A separately identified `TaroBot Group Check.app` paired with a temporary Hub.
  Native right-click on both the group row and expansion button showed the App
  menu. Adding the writing Bot and renaming to 产品讨论群 persisted; reopening
  showed both members, and a read-only database query confirmed the topic kept
  its title and inherited the same members. The preview and temporary Hub were
  closed afterward.
- Standalone production directory and npm archive were independently installed
  outside the checkout and launched with a fresh home and minimal PATH; neither
  had a Feishu SDK, credentials or CLI dependency.
- Android assembleRelease, lintRelease and 20 JVM tests passed. Signed APK:
  stable test certificate, aligned, version 0.1.394-test.1 / code 2026101209;
  all 337 packaged client assets match the synchronized source, with no dev URL.
- Final macOS DMG mounted read-only: deep/strict App signature verification
  passed; version 1.0.21, bundled Hub 0.1.394 and Node 24.14.0 confirmed; all
  335 bundled client files match the production build, without legacy transport
  or Feishu SDK. The verification mount was detached. Signing is ad hoc,
  not Apple notarization.
- GitHub Actions Source checks and SQLite driver matrix did not start because
  the account payment/spending limit blocked runners; local checks above passed.
- Updating an already-running host requires restarting that TaroBot Hub after
  installing the new desktop package; merely replacing the client does not
  reload the running Node process. This change does not restart a user's Hub.
- Physical Android interactions and real provider CLI turns were not tested in
  this change. Native UI checks used synthetic Bots and the real Hub.

Native group menu (historical image omitted from this clean snapshot)
Saved native settings (historical image omitted from this clean snapshot)
Phone settings (historical image omitted from this clean snapshot)
