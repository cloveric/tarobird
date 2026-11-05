# Desktop host onboarding — 2026-10-11

## Problem and user flow

The previous DMG contained only a client. After clearing all data, both it and the
Android APK asked to connect to an already running Hub. A browser preview with an
existing development Hub did not validate first installation.

The Apple Silicon desktop package now includes the standalone Hub, Gateway,
production dependencies, native addons and a verified upstream Node runtime.
Opening a fresh app offers **Use this computer as a host** or **Connect to an
existing host**. The first choice starts the local Hub and enrolls the desktop
through native IPC. No terminal command, Node installation, Feishu account or
Feishu CLI is involved. Opening a client alone does not create a host.

In **Settings → Devices & security → Add device**, enable LAN pairing and scan
the generated QR in the phone app. Submit the phone pairing request, confirm its
eight-digit code on the trusted desktop, and connect on the phone. Provider CLIs
still need to be installed and signed in on the host before their Bots can work.

## Implementation and trust

- `client/src/DesktopWelcome.tsx` owns role selection and local enrollment.
- `client/src-tauri/src/desktop_host.rs` exposes only a fixed action list and uses
  native-owned resource/data paths; the renderer cannot select an executable,
  shell, environment or state directory.
- `src/hub/desktop.ts` owns local service startup, explicit enrollment, resumption
  and LAN configuration. State stays in the app's host directory. Existing
  Bot/session/workspace/memory semantics and independent legacy services remain
  unchanged.
- `src/hub/desktop-tls.ts` creates a per-host private CA and a server certificate
  for current private IPv4 interfaces. The QR contains public CA material and the
  Hub identity, never a CA private key, login token or device private key.
- Native desktop, Android and iOS transports scope this CA to the selected
  origin and Hub identity. They still validate hostname, validity, signed Hub
  identity proof and the actual peer certificate. System trust is unchanged;
  a QR for one route does not trust unrelated routes.
- HTTP and WebSocket both carry the route's CA through the native bridge. A
  regression test covers the initially missed mobile WebSocket argument.
- Reopening the same LAN invite reuses a valid certificate and running service.
  A network change rolls configuration back if restart fails. On next startup,
  stale local interface addresses are refreshed; without LAN, local loopback
  startup remains available. A changed phone route still needs a refreshed QR.
- `scripts/prepare-desktop-host.mjs` verifies the official Node archive checksum,
  builds the standalone dependency graph, installs production dependencies and
  checks SQLite/host imports with a restricted PATH. Desktop build and signed
  release scripts both prepare these resources. Builds reject incompatible
  CPU targets instead of labeling an ARM-only host bundle universal.

Compatibility names `com.tarocub.client`, `tarocub://`, native plugin names and
existing persistence keys remain unchanged. Visible new onboarding uses TaroBot.
Old phone builds must be upgraded to understand the QR certificate field.

## Evidence

- A separately identified macOS Tauri app, starting with empty application data,
  rendered the role chooser, created a bundled local Hub from its real native
  command, enrolled its Keychain device and displayed a connected workbench.
- In that native app, a newly created Codex Bot using `gpt-6-astra` / `low`
  received a no-tools probe and returned **桌面首次安装成功**. This exercised
  native UI → bundled Hub → Gateway → installed real CLI → native UI.
- The native pairing wizard generated a private-LAN HTTPS QR. The production
  CA/peer-verification implementations were exercised in Rust real-TLS tests,
  the JVM native-transport audit and the macOS Foundation iOS-source audit.
  Explicit CA succeeds; wrong hostname and unscoped system trust still fail.
- Focused root tests cover actual subprocess startup, local enrollment, repeated
  start, stop/resume, TLS proof and restart after a stale Wi-Fi address. Client
  browser tests cover the first-run chooser, QR approval, native failures,
  settings flow and both mobile bridge contracts.
- The final packaged App runtime also starts and enrolls a device with an empty
  temporary HOME and PATH restricted to system tools, using only its bundled
  Node/dependencies. Its stop/resume behavior and standalone dependency boundary
  were checked from the actual `.app/Contents/Resources/host` tree.
- The release Android variant compiles and its unit tests pass. The signed APK
  installs on the API 36 ARM emulator. These do not establish its full UI flow:
  the current computer-use tool could not attach to the emulator window.

## Release limits

This remains a private prerelease, not general availability.

- Desktop host package: **macOS Apple Silicon only**. The previous universal
  client-only DMG does not provide this first-run experience. Windows/Intel host
  bundling and iOS installation are not delivered in this release.
- The Mac package is ad-hoc signed and not Apple-notarized; Gatekeeper may require
  the standard per-app **Open Anyway** action. No global security setting changes.
- Physical Android scanning, camera/microphone permissions, background recovery
  and notification delivery still need device testing. Simulator installation,
  JVM audits, browser tests and iOS source checks are distinct evidence.
- LAN QR pairing requires reachable local networking. Cellular/away-from-home
  use needs an explicitly configured HTTPS/Tailscale/VPS route; no relay is
  automatically provisioned by the new button. Internet-route acceptance is not
  claimed here. Host sleep or shutdown stops availability.
- Enabling/changing LAN listeners briefly restarts the Hub; the UI tells users
  to finish active tasks first. Reopening an unchanged invite does not restart it.
- This does not add application-layer end-to-end encryption or alter message
  persistence. Runtime state and temporary native acceptance data are not in
  the repository or release assets.
