# Focused desktop context menus

The desktop WKWebView previously exposed macOS's default web menu, including
Look Up, Translate, Search with Baidu, Share, Speech and Services. These were
system-provided items, not TaroBot capabilities.

`client/src/native-context-menu.ts` owns the default text context menu only in
the Tauri shell. Selected message text offers Copy. Editable fields offer native
Cut, Copy, Paste and Select All; macOS also offers Undo/Redo. Readonly controls
retain Copy/Select All and password controls never expose Cut/Copy. Empty page
areas have no unrelated menu. Labels follow the App language.

The document listener runs after React handlers, so existing sidebar rename and
other App-owned menus retain priority. Browser and Capacitor selection/long-press
behavior is unchanged. Native predefined responders preserve selection, undo and
IME handling rather than replacing text through JavaScript. Pending asynchronous
menus are invalidated by another click, keyboard action, blur or disposal, and
native resources are closed after use.

## Verification

- Focused Chromium and WebKit runs each passed all 7 cases across
  `native-context-menu`, `conversation-rename` and `message-hold`. Native menu
  transport is mocked in browser tests; this is not native action evidence.
- An independently identified macOS preview (App 1.0.10) was paired to a disposable
  local Hub. Selecting `Chrome` in an actual chat card showed only Copy. Native
  Copy followed by Paste inserted `Chrome` in the composer; context-menu Undo
  removed it and Redo restored it. Right-click Paste was also exercised directly.
- Root/client builds, standalone Hub preparation, optimized macOS build and
  Android release build passed. The root standalone graph contains 278 modules
  without the legacy Feishu SDK/transport.
- Physical Android/iOS and Windows/Linux native context menus were not tested.
  No installed user App, real conversation or legacy fleet was modified.

Published as pre-release `0.1.383-test.1`: macOS App 1.0.10 and Android version
code 2026101111. The APK retains the existing test signing key; the Mac bundle is
ad-hoc signed and is not Apple-notarized.
