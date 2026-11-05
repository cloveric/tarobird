# Rename conversations from the sidebar

Right-click a direct conversation, group or topic in the desktop sidebar and
choose **Rename**. The focused dialog selects the current name, accepts Enter
to save and Escape to cancel, and returns focus to the same row. F2 opens the
dialog directly; Shift+F10 opens the context menu. The existing management entry
remains available.

The operation uses that row's Hub connection even when another host is active.
It does not select the conversation or modify its Bot membership, session,
workspace, memory or binding. Trimmed titles use the existing rename protocol
and synchronize through the Hub. The dialog waits for the durable cache receipt;
a socket write alone is not reported as success. Blank titles and offline saves
are disabled, repeated submissions are guarded, and IME confirmation is not a
submit action. Failed saves retain the entered title.

The shared menu supports a pointer position and portals outside the scrolling
sidebar. It stays within the viewport and closes on outside interaction,
scroll/resize, conversation changes and hidden-workspace transitions. Existing
anchored menus keep their original layout.

## Verification

- Real isolated Hub, Chromium and WebKit: rename without changing the selected
  chat or its draft; second-client synchronization; reload persistence; preserved
  session, binding, membership and parent-topic values; group/topic F2; keyboard
  menu; blank/cancel/focus behavior; IME confirmation event sequences; two hosts
  with identical conversation IDs; viewport edge positioning and resize cleanup.
- Existing conversation settings and creation flows passed on both engines.
  New rename tests initially used the default 5-second pairing expectation;
  the first-run crypto/poll interval exceeded it. The helper now uses the
  existing pairing wait convention. The two rename journeys then passed on both
  engines, including the final IME assertions.
- Real macOS Tauri window with a separate compiled app identifier
  `com.tarobot.rename-preview`, connected to a disposable loopback Hub: right
  click opened Rename instead of the macOS Copy/Speech menu; the title was
  selected automatically; Enter saved the new name; F2 reopened it; Escape
  restored row focus. The other chat and its draft remained intact. A read-only
  SQLite check confirmed the renamed title. Stopping only the disposable Hub
  produced the reconnect hint and disabled Save. The preview and fixture stopped
  after verification; the installed App and legacy services were untouched.
- Root standalone build (278 modules, no Feishu transport/SDK) and client
  translation, type and production build checks passed. This change does not
  require a real engine invocation; no new real-model result is claimed.
- Android APK: existing test-key signature verified; all 111 frontend assets
  match the production build byte for byte. Native macOS asset names match the
  production client build; mounted DMG signature, identifier and version checked.

## Release and limits

Pre-release **0.1.380-test.1**, macOS App **1.0.7**, Android version code
**2026101108**. Apple Silicon DMG and signed Android test APK are included with
SHA-256 checksums. The Android package was not exercised on a physical phone in
this change; native iOS and Windows were not tested. Physical system Pinyin
candidate confirmation was not exercised; the IME checks use browser events.
