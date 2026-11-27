# Host Terminal Packaging & Security Notes (#100)

## Runtime PTY Architecture

`HubHostTerminal` (`src/hub/host-terminal.ts`) resolves shell backends in order:

1. **`node-pty` (preferred for release packages)**: dynamically loaded when bundled with the Host runtime, providing full ConPTY support on Windows and native PTY support on macOS (`arm64` / `x64`) and Linux. Teardown terminates the full process tree via `killProcessTree`.
2. **POSIX `pty-script` fallback (macOS / Linux)**: when `node-pty` is absent (e.g. source builds) and a real, non-shim `python3` binary is available on `PATH` (or via `xcode-select -p` on macOS, avoiding Apple's CLT prompt stub), allocates a real PTY via Python's stdlib `pty.openpty()` with `TIOCSWINSZ` + `SIGWINCH` live resizing, full `ISIG`/`VINTR` (`Ctrl+C`) and `EOF` (`Ctrl+D`) line discipline, and streaming `StringDecoder("utf8")` decoding.
3. **Standard `pipe` shell fallback (Windows without `node-pty`, or POSIX without `python3`)**: spawns the configured shell (`$SHELL`, `powershell.exe -NoLogo -NoExit -Command -`, or `ComSpec`) with `windowsHide: true`, streaming `StringDecoder("utf8")` decoding, POSIX child-process `SIGINT` / EOF `stdin.end()` translation for `Ctrl+C` / `Ctrl+D`, CRLF normalization on Windows, and clean process-tree teardown via `killProcessTree`. Note that on Windows without `node-pty`, the pipe fallback lacks a PTY so `Ctrl+C` cannot be delivered cleanly.

## Packaging `node-pty` & Frontend Terminal Renderer

When bundling native/frontend packages into release builds:

- **`node-pty` on macOS (`arm64` & `x64`)**:
  - Ship architecture-matched `pty.node` and `spawn-helper` binaries inside the unpacked app resources (`asarUnpack`).
  - Ensure `spawn-helper` retains executable permissions (`0755`) and is codesigned with the Hardened Runtime entitlement before notarizing the `.dmg` / `.app`.
- **`node-pty` on Windows (`x64` / `arm64`)**:
  - Ship the ConPTY native binaries (`conpty.node`, `conpty_console_list.node`, and `OpenConsole.exe` when applicable) unpacked from `app.asar`, signed with the Authenticode certificate alongside the desktop binary.
- **Frontend renderer**:
  - The built-in renderer (`client/src/terminal-ansi.ts`) parses 16-color, 256-color, and 24-bit truecolor ANSI SGR, erase-in-line, backspaces, and carriage-return overwrites with zero extra npm dependencies. Release builds may optionally adopt `@xterm/xterm` when full interactive TUI emulation (e.g. `vim`, `htop`) is packaged.

## Security & Audit Model

- **Off by default**: `terminal-policy:v1` defaults to `{ revision: 0, enabled: false, grants: [] }`.
- **Local desktop controller only**: only devices enrolled as local desktop controllers (`localDesktopControllersInTransaction`) see management controls (`canManage: true`) or may mutate policy; remote paired owner devices receive `403 local_controller_required`.
- **Dedicated signed domain & idempotency**: policy mutations require a one-use owner-signed `terminal-grant` device-action proof covering `tarobot/terminal-policy/v1`, revision compare-and-swap, unique `deviceId` grants, and `requestId` idempotency. Newly added invalid/mismatched device keys fail closed with `409 terminal_device_changed`.
- **Per-device revocation, sweep & idle ceiling**: revoking a grant or device immediately wakes and rejects in-flight output long-polls (`403 terminal_not_authorized` / `401 device_revoked`) and terminates owned shells concurrently. External CLI SQLite revocations and device key changes are enforced by `HubHostTerminal.sweep()` on the Hub sweep interval without killing running shells on 15-minute HTTP session expiry. Running shells idle without I/O past the configurable idle ceiling (default 2 hours; `TAROBOT_TERMINAL_IDLE_TIMEOUT_MS`, clamped to 1 minute–24 hours) are reaped by `sweep()` with audit reason `idle_timeout`.
- **Workspace fail-closed**: shells resolve the conversation's dispatcher ticket workspace or managed/external Bot workspace (`files.root`), reject archived conversations (`409 conversation_archived`), and fail closed (`409 terminal_workspace_unavailable`) instead of falling back to the Hub private `stateDir`.
- **Desktop UI affordance**: the terminal entry and panel are hidden on mobile/tablet platforms and narrow viewports as a client UI affordance; Host authorization accepts any granted device (see `docs/security-boundaries.md#host-terminal`).
- **Audit trail & graceful shutdown**: `terminal.policy`, `terminal.opened`, and `terminal.closed` (covering tab close, natural process exit, permission/device revocation, idle timeout, and Hub shutdown) are persisted in `audit_log`; `HubServer.close()` awaits `hostTerminal.dispose()` before flushing audits and closing SQLite.
