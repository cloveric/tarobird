# Desktop window restoration

## Report and confirmed defect

The user reported two occasions on a MacBook Pro when switching away from
TaroBot and returning left the desktop app impossible to open until restarted.
After the initial investigation, the user confirmed both the affected computer
and the symptom: clicking the Dock icon did not bring up a window. This matches
the reproduced reopen defect below. The affected MacBook Pro has not yet been
tested with a build containing the fix; local Mac mini verification is separate.

A concrete macOS lifecycle defect was found and reproduced independently:
closing main hides it so the host can continue running, but the app had no
`RunEvent::Reopen` callback. Dock/Finder activation delivered the system reopen
event without showing that hidden window. This is a confirmed cause of an
absent window, not evidence that every visible-window freeze has the same cause.

## Change

- Handle macOS reopen events, including when another window is visible.
- Share the same restoration path with tray, shortcut, notification and Windows
  second-instance activation: dispatch to the main thread, unhide the macOS
  application, show main, unminimize and focus. Log actual operation failures.
- Only main has close-to-hide behavior; auxiliary windows can close normally.
- Keep the existing window/document; no reload, app restart, draft reset,
  network identity change or new host process.

CLI impact: not applicable. This is desktop window lifecycle handling only.
The headless host, all engine adapters, phone membership and APIs are unchanged.
No frontend render or mobile lifecycle changes are included.

## Verification

The opt-in `window-audit` binary imports the production activation module, uses
a distinct application identifier and an incognito WebView, and never starts
a host or loads real credentials. Its runner copies sources to a disposable
directory so a prepared Windows `host/` payload is not replaced for Mac tests.

```sh
node client/scripts/window-activation-audit.mjs /tmp/tarobot-window-acceptance
```

On macOS arm64 on 2026-10-15:

- Production native `cargo check --offline --locked --bin tarocub-client`: passed
  in the isolated source copy (compile-only frontend fixture, no host bundle).
- Existing native unit tests: 34 passed.
- Root `npm run build`: passed.
- The harness first omitted the reopen callback and reproduced the hidden
  window remaining hidden after a real LaunchServices `open -a` event.
- With the shared fixed callback, 11 restoration checks passed: three cycles
  each of close/minimize/application-hide; reopen with an auxiliary window
  visible; and the shared show entry after application hide. Auxiliary close
  actually removed the auxiliary window.
- Every restored main window was visible, unminimized and focused. Its document
  token, unsent draft and increasing button-click count survived all checks.
  DOM clicks and IPC responses verify document liveness; this is not a claim
  of physical pointer interaction or a reproduction of a visible frozen UI.

Local receipts: `/tmp/tarobot-window-acceptance-20261015/result.json` and adjacent
build/runtime logs. The installed TaroBot process was not restarted or replaced.
The local installed app was 1.0.67; source was 1.0.69. No installer release or
on-device upgrade is included in this source checkpoint. Windows native window
interaction was not exercised on a real Windows computer.

API references: [Tauri Reopen event](https://docs.rs/tauri/latest/x86_64-apple-darwin/tauri/enum.RunEvent.html#variant.Reopen),
[macOS application show](https://docs.rs/tauri/latest/x86_64-apple-darwin/tauri/struct.AppHandle.html#method.show).
