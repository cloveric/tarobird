# Windows desktop local host — 1.0.63

The Windows x64 desktop package now includes the standalone Hub and Bot worker
runtime. The welcome screen offers both **Use this computer as host** and
**Connect to an existing host**, using the same flow as macOS. Returning from
unfinished remote pairing preserves its device identity and allows local setup.

## What changed

- Bundled Node 24.14.0 and Windows x64 SQLite N-API addon, with archive hashes
  verified during packaging. Every bundled native addon is checked for AMD64 PE
  format. No Mac binaries or Feishu runtime are substituted into this package.
- Local Hub start, status, stop, resume, device enrollment, LAN/Tailscale HTTPS
  invites and existing VPS relay configuration use the shared runtime.
- A per-host Windows named pipe replaces Unix-only socket paths. Windows control
  requests require an account-local 256-bit secret; unknown callers cannot stop
  the Hub. Long and Unicode state paths do not become pipe names.
- Bot discovery honors Windows `Path`/`PATHEXT`, including npm `.cmd` launchers.
  Node-backed npm engines run directly with bundled Node, preserving private App
  pipes. Other launchers use escaped cross-spawn arguments with hidden consoles.
- Worker shutdown uses parent IPC before escalation, allowing engines and data
  stores to close on Windows. Installation/uninstallation stops only the owned
  Hub and waits for its process to exit before replacing locked runtime files.
  Updates retain the enabled flag, devices, conversations and Bot configuration.
- File Center can reveal files in Windows Explorer. Kimi shared-skill folders
  use directory junctions without requiring Windows Developer Mode.

## Account and engine prerequisites

As on Mac, install and sign into the desired engine on the computer **running**
the Bot. TaroBot includes its own host runtime; it does not include paid model
accounts or make an engine's unsupported upstream feature available. Connecting
to example-mac uses example-mac's engines and accounts. Local Windows hosting uses the
Windows user's engines. Optional ASR/search integrations retain their own setup.

The installer targets Windows 10/11 x64. ARM64 Windows can use the x64 installer
under OS emulation; a native ARM64 host package has not been validated and is
not advertised by the build workflow.

## Build and verification

`npm run desktop:windows --prefix client` builds the frontend, packages the
Windows host and builds NSIS. On Mac it uses cargo-xwin; on Windows it uses MSVC.
The previous rule to omit host resources no longer applies. macOS packaging
continues to select the Apple Silicon runtime.

`scripts/verify-desktop-host.mjs` runs with the packaged Node on the target OS.
It uses an isolated temporary state directory and a synthetic engine, checks
argument round trips and inherited private pipes, enrolls a device, authenticates
HTTP/WebSocket, creates a supervised Bot, restarts the Hub with the same identity
and reads back a real Gateway-delivered fixture reply. It does not claim a live
provider/account acceptance pass.

## Release evidence

[Download Windows 1.0.63](https://github.com/cloveric/tarobot/releases/tag/v0.1.415-windows-test.2).

- Full source regression: **2940 passed, 1 skipped** (macOS). The final Windows
  process-tree termination adjustment then passed its **15** focused checks.
- **35 Chromium + 35 WebKit** native-transport UI checks, including Windows local
  setup and return from pending remote enrollment; **28 Rust tests** on macOS.
- Isolated host smoke passed on macOS: CLI argument round trip, inherited private
  pipes, actual authenticated HTTP/WebSocket, supervised fixture-engine reply,
  stop/resume and identity retention. This uses a synthetic CLI, not a provider.
- Windows x64 release binary compiled with cargo-xwin/MSVC libraries. The final
  NSIS installer was extracted: **4819 host files** exactly match the prepared
  runtime. Desktop EXE, Node EXE and SQLite addon are AMD64 PE; Node/SQLite import
  standard Windows system libraries. No Mac Node binary is bundled.
- Installer: `TaroBot-1.0.63-windows-x64-setup.exe`, **94,858,846 bytes**.
  SHA-256: `2f85d0c87fe813d15a2c9ee4f7f2d9e0a22375f739c199da9e12c369c7699a05`.
- [Windows native CI run](https://github.com/cloveric/tarobot/actions/runs/38357102528)
  **did not start**: GitHub rejected it because recent account payments failed or
  the spending limit needs increasing. Zero job steps ran. Target-OS host smoke,
  NSIS install/upgrade/uninstall, camera/microphone/notifications and real model
  login therefore remain unverified on Windows. Cross compilation is not a
  substitute for these checks.

The Windows installer is unsigned and published as a test release. It preserves
existing account-local state; users can continue connecting to example-mac/VPS or
add this Windows computer as a separate local host. DeepSeek credentials/persona
files are refreshed into its private home at startup on Windows, avoiding the
file-symlink privilege requirement; shared profiles remain directory junctions.
