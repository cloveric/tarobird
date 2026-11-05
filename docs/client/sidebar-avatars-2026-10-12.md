# Sidebar portraits and hierarchy

The desktop sidebar used 28px portraits, and child chat titles began 9px to the
left of their Bot's name. Animal portraits were hard to distinguish at that size.

`ConversationList.tsx` now uses 40px portraits for Bots and top-level conversation
rows, including groups and pinned chats. The existing component-owned rules in
`brand-theme.css` give Bot headings room for the larger portrait, put the guide
under its centre, and align child chat text with the Bot name. Names/previews
still truncate; unread badges and the New Chat button keep their own space.
Topics retain their `#` glyph and hierarchy. Mobile Home retains 48px portraits.
No avatar assignment, custom-picture, session, membership or message logic changed.

## Visual evidence

All pictures use an isolated synthetic Hub with five Bots, multiple chats, a
long Bot name, a long chat name, unread messages, a group and a topic.

| Before | After |
| --- | --- |
| 28px sidebar (historical image omitted from this clean snapshot) | 40px sidebar (historical image omitted from this clean snapshot) |

- Chromium and WebKit: desktop 820×700, 1200×880, 1600×1000; phone 390×844 and
  320×740. No horizontal overflow or page errors. Desktop portrait: 40×40;
  Bot name and child chat title both start at x=69 in the fixture. Phone: 48×48.
  [Recorded measurements](images/sidebar-avatars-2026-10-12/measurements.json).
- 320px phone Bot directory (historical image omitted from this clean snapshot).
- Native Mac window (historical image omitted from this clean snapshot): separate
  App identifier and temporary Hub; visually checked portraits, chat selection,
  Bot right-click menu, and the adjacent New Chat button opening with the correct
  Bot selected. Preview and fixture were stopped afterward. Installed App and
  existing Hub/Bot services were untouched.

## Verification

- `./scripts/pre-complete-hook.sh`: build and 206 test files pass; 2746 tests pass,
  one pre-existing skip.
- Existing focused browser regressions: `bot-avatar-library`, `bot-context-menu`,
  `conversation-context-actions`, `topics`, `mobile-im`; 14 pass in Chromium and
  14 pass in WebKit. Covers custom avatars, menu routing, pin/delete, drafts,
  host isolation, topic navigation and phone layouts. No new test merely
  restates these size constants.
- Client clean install, translations, TypeScript and production build pass.
- Android release build, lint and 20 JVM tests pass. Signed APK verifies with
  the existing testing key; version 0.1.395-test.1 / code 2026101210. All 337
  bundled public assets match the Capacitor copy; no development server URL.
- Standalone directory and npm archive both installed outside the checkout and
  passed package verification. No Feishu SDK or transport dependency added.
- Final macOS DMG mounted read-only: `codesign --verify --deep --strict` passes;
  App 1.0.22 contains host 0.1.395 and Node 24.14.0. All 335 client assets match
  the production build. No bundled Feishu SDK or `dist/src/lark`; mount detached.

## Release and limits

Prerelease target: `v0.1.395-test.1`, macOS App `1.0.22`, Android
`0.1.395-test.1`. macOS is ad-hoc signed, not Apple-notarized. Android has no
attached physical device, so browser/JVM checks do not constitute real-device
acceptance. Engine/provider behavior is unchanged and was not re-accepted with
real CLIs for this layout-only change.
