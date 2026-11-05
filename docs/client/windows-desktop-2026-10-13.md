# Windows desktop companion 1.0.61

Historical checkpoint. The full local-host implementation is documented in
[Windows desktop 1.0.63](windows-full-host-2026-10-13.md).

Windows 10/11 x64 now has an unsigned NSIS test installer. It connects to an
existing TaroBot host on a Mac, computer or VPS, using the same conversations,
folders, themes, attachments and approvals as the other clients. It does **not**
run a local Hub or Bot engine on Windows in this release.

Download: [Windows test release](https://github.com/cloveric/tarobot/releases/tag/v0.1.415-windows-test.1).

## Connect

1. Run `TaroBot-1.0.61-windows-x64-setup.exe`. It installs for the current user;
   the installer downloads Microsoft's WebView2 bootstrapper if needed.
2. On the existing host, open **设置 → 设备与安全 → 添加新设备**. Import its
   connection QR image in the Windows client, or enter the host address and
   independently supplied identity public key.
3. Approve the Windows pairing code from the already trusted device. The host
   must stay on and be reachable from Windows (LAN, Tailscale or configured VPS).

This is an unsigned prerelease. Installation/upgrade/uninstall, Windows
Credential Manager, WebView2 startup, actual pairing/chat, tray, notifications
and file dialogs have not yet been accepted on a Windows computer. Cross
compilation and browser tests are not Windows runtime acceptance.

## Build

Install the root and client locked npm dependencies. On Windows, install the
Tauri prerequisites (MSVC build tools and Rust), then run from the repo root:

```sh
npm run desktop:windows --prefix client
```

The command builds an x64 NSIS installer. `-- --arch arm64` selects the ARM64
target; no ARM64 artifact was produced or verified in this checkpoint. The
**Windows desktop installer** GitHub Actions workflow runs this command on a
Windows runner and uploads the installer and SHA-256 file. It can be dispatched
manually; hosting-account billing currently prevents GitHub jobs from starting.

On macOS, install LLVM, NSIS and `cargo-xwin`, add LLVM's `bin` to PATH, and add
the `x86_64-pc-windows-msvc` Rust target. The same command selects `cargo-xwin`
automatically. `CARGO_TARGET_DIR` and `XWIN_CACHE_DIR` can point to external
build/SDK caches. This follows [Tauri's cross-compilation instructions](https://v2.tauri.app/distribute/windows-installer/).

Do not run `desktop:prepare` for this companion: that script assembles the
Apple Silicon host. `tauri.windows.conf.json` replaces bundle resources with
an empty list and selects current-user NSIS installation. The Rust Windows
`desktop_host` handler reports unavailable on status/resume and rejects local
host operations; the pairing and device-invite UI reflect that boundary.

## Evidence

- Full x64 MSVC-target Tauri release binary linked using Microsoft's SDK/CRT
  through `cargo-xwin`; the production NSIS hooks compiled into the installer.
- NSIS extraction and archive integrity pass. The extracted app is an AMD64
  Windows GUI PE, version `1.0.61.0`; all six embedded icon variants match the
  selected source ICO. It contains no bundled Mac/Node host resources.
- The extracted EXE matches the release executable except Tauri's
  three-byte bundle type patch (`UNK` to `NSS`); the installed-byte digest is
  retained in the verification receipt.
- Installer: 27,495,156 bytes. SHA-256:
  `55f203873ce623a7729bc4f23670062366ecbd5250916e6846d4249dc85ff1e1`.
- Chromium and WebKit each pass 29 native-transport contract journeys, including
  Windows first-run pairing and refusal to contact an unverified host. The
  Windows-first-run test failed against the prior local-host-only entry.
- The 27 native Rust regressions run and pass on macOS. The client production
  build and translation/type checks pass. Windows execution remains untested.
- The repository completion hook passes the standalone build and all 230 test
  files: 2,935 tests pass and one is skipped.

This release includes the preceding desktop **移至分组** entry repair. It does
not replace the installed Mac app or publish a new Android/Mac installer.
