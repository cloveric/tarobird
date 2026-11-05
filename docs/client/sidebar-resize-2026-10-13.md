# Desktop sidebar resizing

The divider between the Bot/conversation list and the conversation pane is now
draggable. The existing defaults remain 272px, or 288px on windows at least
1500px wide. Dragging changes both panes without remounting the conversation,
discarding its draft, or persisting a new preference.

Width lives in a document-level CSS custom property. All host workspaces in
that window use it; a new launch/document starts at the existing default.
Double-click or Enter resets it immediately. The accessible separator also
supports Left/Right (8px), Shift+Left/Right (32px), Home/End, and Escape to cancel
an active drag. Pointer capture handles releases outside the divider; blur,
resize, lost capture, cancellation and inactive-host cleanup release drag state.

The sidebar is bounded to 200–480px and reserves at least 360px for the main
pane in desktop layout. Narrowing a window clamps the rendered width without
overwriting the preferred width for this launch. Below 761px the phone layout
keeps its existing behavior and the separator is hidden.

## Verification

- Chromium: all 3 new real-Hub splitter journeys passed, including pointer and
  keyboard interaction, bounds, theme changes, drafts, a fresh-document reset,
  two-host switching, interrupted drags and phone/desktop transitions.
- WebKit: 19 focused cases passed (3 splitter, 4 keyboard, 9 mobile navigation,
  and 3 existing stable-stream-width cases).
- Required pre-complete hook passed: standalone build plus 226 test files,
  2910 passed / 1 skipped. Client TypeScript and production build passed.
- Actual macOS WKWebView, isolated `com.tarobot.sidebar-resize-preview` App:
  mouse drag changed the accessibility splitter value from 272 to 392 and
  resized both panes while retaining a saved composer draft. Double-click
  restored 272. After dragging to 352, quitting the process and launching again,
  the native splitter reported 272 and the draft remained intact. The real
  installed App and its hosts were not replaced or modified by this test.

Local logs/screenshots: `/Volumes/gdrive/taro-tmp/sidebar-resize-*`.

Mac installer 1.0.43 (Apple Silicon) also includes the preceding stable reply
width fix. The final DMG was mounted read-only and its App passed deep/strict
signature, icon, version, identity, architecture and bundled-host checks.
It is ad-hoc signed, not Apple-notarized. SHA-256:
`bacafb6dc781d9888813c4a3c1466b6f90e9a141e33b5393c868f1c8c9e6757a`.
The installed App was left running unchanged; updating requires installing the
new package.

## Follow-up: hide the directory scrollbar

The desktop sidebar no longer paints a scrollbar beside the resize divider.
Both the host directory and standalone conversation list keep their scroll
overflow; only the scrollbar is hidden, with a WebKit fallback for macOS.
The resize divider and phone layout are unchanged.

Verified in a separate macOS `com.tarobot.sidebar-scroll-preview` App with 26
conversations: the list scrolled from its first entries to its final entry
without a gray scrollbar; dragging the divider still changed 272px to 352px.
The temporary host and preview were stopped afterward. All 3 WebKit splitter
journeys passed again, as did the client build and required pre-complete hook
(226 test files, 2910 passed / 1 skipped).

Mac installer 1.0.44 (Apple Silicon) includes this follow-up. The mounted final
DMG passed deep/strict signature, icon, version and bundle-identity checks;
its executable is arm64 and the bundled host resources are present. Ad-hoc
signed, not Apple-notarized. SHA-256:
`43c0996ee127a66e9dede6fe9820d938212927b3e6563995591a813ed997c5e4`.
The user's installed App was not replaced; this is a new local installer.

## Thinner drag highlight — 2026-10-28

The hover, keyboard-focus and active-drag highlight now uses the divider's
existing 1px width, replacing the 2px highlight. Its invisible 8px pointer target
and resize behavior are unchanged. The shared rule covers ordinary chat and
ADHD sidebars. This is presentation-only; Host and CLI behavior are unaffected.

Client translation/type/build checks passed. The existing drag/bounds/reset and
keyboard/interruption/mobile-transition journeys passed in Chromium and WebKit
(2 per engine). Compiled-App previews verified the active 1px line and 8px hit
target in both sidebar modes across default, White Sage and Mono palettes in
both browsers (12 combinations). Evidence and screenshots are under
`/Volumes/gdrive/taro-tmp/sidebar-divider-20261028`.

This follow-up is source/browser verified and has not changed the published
1.0.118 installers or the installed App.

## Accent-colored thin splitter — 2026-10-28

The owner still saw a dark separator and requested a normal thin line in the
selected accent. The 1px hover/focus/drag stroke now uses Monochrome's selected
accent mark, instead of its black/white `--accent` token. With no accent selected
it uses the neutral `--border-strong` rule; other palettes retain their own
accent. The ordinary idle border color, invisible 8px pointer target, keyboard
controls and drag behavior are unchanged, for both chat and ADHD sidebars.
Visual inspection also found the highlight 2px inside the conversation's
left border, producing two adjacent rules. Both splitter layers now paint at
the sidebar's outer edge, so the active accent stroke overlays the existing
conversation border instead of adding a parallel line.

This is App presentation only; no Host/headless CLI change is applicable.
Validation evidence is recorded under
`/Volumes/gdrive/taro-tmp/sidebar-accent-20261028`. No release or installed App
update is part of this source change.

Client translation, TypeScript and production build passed. The existing drag,
bounds/reset and keyboard/interruption/mobile-transition journeys passed in
Chromium and WebKit (four engine/case executions). Rendered checks covered
16 combinations of those browsers, chat/ADHD and warm-gray/sage/no accent/White
Violet: every active line was 1px, aligned exactly with the sidebar's outer
edge, and used the expected color while retaining its 8px hit target. Screenshots
were inspected after correcting the parallel-line offset. Native App acceptance
is not claimed.
