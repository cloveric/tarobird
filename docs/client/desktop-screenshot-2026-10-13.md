# Desktop screenshot draft attachment

The desktop attachment button offers Upload file and Screenshot. Region capture
hides the main window until the native selector exits, then adds a PNG to the
existing draft attachment tray. It never sends a message automatically and does
not touch the clipboard. Cancel and errors retain existing text and files.
Phones keep camera/photos/files; ordinary browsers keep the file picker.

Destination changes invalidate outstanding captures, including A → B → A,
host visibility changes, opening search and unmount. An upload/blocked identity
also prevents a late image from modifying the draft. A process-wide native guard
prevents overlapping selectors even when the UI is remounted.

## Native implementations

- macOS: CoreGraphics permission request on the main thread, then the built-in
  interactive `/usr/sbin/screencapture`. Its output lives in an exclusive 0700
  random temporary directory removed on success, cancellation and error.
- Windows: a topmost Win32 region selector on its own worker/message loop. The
  desktop snapshot precedes the overlay, selection works in physical pixels
  across negative virtual-display origins, and Escape/right-click, activation
  loss, display changes or the two-minute timeout cancel. GDI resources and
  thread DPI context are restored. Windows Snipping Tool's modern callback
  protocol requires an MSIX package identity and is not used by our NSIS build.
- Only the focused, visible `main` WebView may invoke capture. No caller-supplied
  executable or path is accepted. IPC carries bounded PNG bytes (base64), not a
  temporary file path. Captures are limited to 32 million pixels / 32 MiB PNG.
  Protected video/system surfaces may not be capturable by the OS.

## Evidence and remaining acceptance

- 28 Chromium/WebKit checks passed across `desktop-screenshot` and
  `attachment-composer`: menu keyboard use and placement, byte-preserving PNG
  draft file, thumbnail, caption retention, cancellation, error recovery,
  repeated capture, English, destination changes, and existing attachment sends.
  Screenshot IPC is mocked in the new browser fixture; upload/message tests use
  an isolated real Hub. These do not prove an OS selector.
- Three Rust tests pass for size limits, exclusive capture lifecycle and region
  geometry (reverse drags, edges, empty clicks).
- macOS native code builds; Windows x64 `cargo xwin check --locked` passes.
- The isolated native Mac app was launched and its real capture IPC exercised.
  The OS denied screen-recording access; the window remained usable and returned
  `screenshot_permission_denied`. No permission was changed to bypass this gate.
- **Still required:** grant permission and validate Mac region capture, Esc,
  window restoration, resulting pixels and clipboard preservation. Windows
  real-device capture/cancel, mixed-DPI multi-monitor and RDP acceptance remain
  pending. No new installer was produced in this change.

For manual native acceptance, build the opt-in binary with
`cargo build --features native-transport-audit --bin screenshot-audit --locked`
inside `client/src-tauri`. Its config and UI are under `audit/screenshot/` and
`audit/screenshot-ui/`. On macOS run it in an app bundle with a separate identity
(`com.tarocub.screenshot-audit`) so permission testing cannot change production
TaroBot's permissions. It connects to no Hub, retains no screenshot on disk, and uploads
nothing. The result view counts successful captures and cancellations and shows
pixel dimensions. Test capture → cancel → capture, all drag directions, secondary
monitors, and leaving the selector; existing screenshots should survive cancel.
