# Pairing and scanner interface refresh

## What changed

The scanner previously rendered a bare video before it had a stream. Android
WebView could show its oversized native play placeholder. Idle, camera loading,
image decoding and live capture now have separate states. The video stays hidden
until playback starts; a compact scan glyph and plain instructions occupy the
idle view. Image import uses a normal, accessible action instead of the browser's
file-input chrome. Permission, missing-camera and busy-camera errors explain the
next available action.

The scanner owns its MediaStream before loading the decoder. Closing during an
unresolved permission prompt stops any subsequently returned tracks. Switching
to image import cancels camera work; stale image/camera results cannot populate
a closed scanner. Existing QR schema validation and both image decoding passes
remain intact.

Desktop welcome now has a wider reading measure, a clear host action, quieter
remote connection choice, and consistent typography. Phone pairing uses an
unboxed layout, large touch targets and a bottom sheet. Manual settings remain
available on demand. Pairing rules previously spread across general, preference,
brand and host styles now live in `pairing.css` and `pairing-scanner.css`.
The device keys, approval requirements, routes and session data are unchanged.

## Verification

- Captured current desktop, phone and scanner views before editing; inspected
  final Chinese/light and English/dark layouts in the in-app browser.
- Chromium and WebKit: first-run layout at desktop width, 320/390 px phones,
  image import for all eight QR masks, invalid QR rejection, multiple relay
  payloads, permission-denial recovery and late-camera cleanup.
- Chromium: a synthetic canvas camera exercised actual video playback, QR
  decoding and ended MediaStream tracks. This is not a physical camera test.
  Canvas-camera capture is explicitly skipped in WebKit; its image and lifecycle
  checks still run. WebKit camera stubs must be installed on the MediaDevices
  prototype because its property access may return a fresh wrapper.
- Existing two-device Hub pairing and native-IPC trust regressions passed on
  both engines. Scanning alone still cannot authorize a new device.
- A separately identified Tauri App, `com.tarobot.pairing-design-preview`,
  verified the welcome screen, remote connection, scanner idle state, closing
  and restored focus, plus access to manual fields in a real macOS WebView.
  No host was created and no user identities or Bot services were modified.
- Root standalone build and client translation/type/production builds passed.
- Android release APK built and signed using the existing test key. Its 111
  bundled frontend assets match the final client build byte for byte.

## Limits and release

Physical Android/iOS camera permission, live camera frames and image selection
remain to be checked on devices. The native Mac check above covers UI navigation,
not a new physical-camera pairing or model session. Existing unrelated mobile
quoted-attachment viewport failure is documented in `composer-ime-2026-10-11.md`.

Pre-release 0.1.379-test.1 contains macOS App 1.0.6 and Android version code
2026101107. macOS is Apple Silicon, ad-hoc signed and not notarized. Updating the
client does not require resetting pairing/chat history or restarting Bot services.
