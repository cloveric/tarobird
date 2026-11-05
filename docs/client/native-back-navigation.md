# Native Back navigation

Android's Capacitor App listener is installed outside the pairing and mobile
lock gates. Without it, WebView history does not represent React dialogs,
settings categories or the selected conversation. The listener dispatches one
cancelable `tarocub-native-back` event and calls `minimizeApp` only if no UI
surface consumes it. It never navigates arbitrary browser history or exits the
process. Cleanup also handles native registration resolving after unmount.

Visible, connected scopes participate. Hidden/inert content and all app scopes
while locked do not. Native dialog top layers outrank CSS overlays, nested
children outrank parents, and attachment portals outrank ordinary panels. Busy
surfaces consume Back without closing, preventing accidental backgrounding.

Navigation rules:

- Creation and effort dialogs close first, unless a request is busy.
- On phones, settings opened from its category list return up one level; a
  category opened directly from chat returns to chat. Back, Escape and the
  header share these rules. Only exiting uses the dirty-route discard guard.
  Nested scanner/confirmation dialogs close independently of their parent.
  Guard updates commit with edits, and rotation preserves navigation focus.
  See [settings navigation QA](settings-nav-qa-2026-10-04.md).
- File details return to the list; unsaved labels require confirmation and
  pending file operations block dismissal, including the close button.
- Operation details return to the overview, respecting collaboration edit and
  busy guards. Conversation settings protect an unsaved name on Back and close.
- Image/file previews close without moving the chat. A pending file export keeps
  its preview open on Back.
- The share inbox hides without unmounting drafts: edited text, recipient and
  active transfer survive close/reopen. Hidden inbox handlers cannot intercept
  other navigation. This does not add disk persistence for pre-send edits.
- Chat Back completes an active recording into an unsent audio draft, or cancels
  a pending microphone request. Search closes independently. At phone widths,
  chat returns to the conversation list; the next Back backgrounds the app.
  Opening the list manually still allows Back to close it. Neither action
  changes the selected conversation or discards its draft/uploads.

Chromium and WebKit each pass 18 focused cases covering the bridge lifecycle,
settings hierarchy, busy effort saving, same-Bot synchronization, unsaved names,
chat draft retention, previews, file labels, operation details, share drafts and
voice encoding/playback. The event is the same production dispatch path; the
browser tests do not synthesize a physical Android key or certify OS gestures,
IME interception, biometric behavior, native suspension or Capacitor container
execution. APK compilation/device checks remain pending the Android SDK setup.

Receipt: navigation and effort checks（本地材料：`evidence/native-back-2026-10-03.json`）.
