# Workbench name in the empty state — 2026-10-31

The large name at the upper-left of the workbench competed with its small tabs.
Move “工作台 / Workbench” below the central icon in the empty state, above the
existing description and create buttons. Use the side-chat introduction's
17px/600 heading scale. Once content is open, show its tabs without repeating
the workbench name in the top bar.

Tabs and actions now share one row. The docked row still follows the adjacent
conversation header's actual height, including narrow and ADHD layouts. Keep
the previous small docked tabs, 13px phone tabs, active-tab scrolling and menu
controls. The complementary region retains its accessible Workbench name.

This is shared desktop/mobile presentation only. Storage, per-conversation
ownership, Bot workbench commands, browser lifecycle and headless CLI behavior
are unchanged; no new CLI command is applicable.

The existing chart-tabs, phone single-page, phone return and narrow ADHD browser
scenarios passed in Chromium and WebKit: **8 cases**. Client translations,
TypeScript and production build also passed (existing chunk-size and mixed
Capacitor Keyboard import warnings remain).
Screenshots are from the test interface. No release or installed App update is
part of this change.
