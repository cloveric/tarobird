# Windows acceptance (Electron installer)

Current status (2026-10-30): **pending Windows runtime acceptance, explicitly
deferred by the owner because no Windows computer or VM is available**. Preserve
the prepared checks below; compilation, extraction and simulated harness tests
do not satisfy them. Resume when a disposable Windows environment is available,
without treating the deferral as approval to publish an unverified Windows build.

`client/scripts/windows-acceptance.mjs` exercises the real Windows behaviour
of a built installer: install, upgrade from the Tauri App, first launch,
migration, notifications, login item, Host, Electron update and uninstall.
It needs **no network service, update feed, GitHub login or user credential**.

It installs and uninstalls for the current Windows user, so it only runs on a
**disposable** machine:
- a fresh VM snapshot;
- a GitHub-hosted runner;
- a throwaway local user.

It refuses to start if any TaroBot install, App data, login item or running
`tarocub-client.exe` exists. It also refuses when it **cannot tell**, for
example when a registry key, data folder or the process list cannot be read.
Never point it at someone's working PC.

## Run

```bat
set TAROBOT_WINDOWS_ACCEPTANCE=disposable
node client\scripts\windows-acceptance.mjs --confirm-disposable-windows ^
  --installer  out\TaroBot_1.2.3_x64-setup.exe ^
  --report     C:\acceptance.noindex\run-1 ^
  --legacy-installer  old\TaroBot_1.0.98_x64-setup.exe ^
  --next-installer    out-next\TaroBot_1.2.4_x64-setup.exe ^
  --native-tests      client\src-desktop-updater
```

- **Required:** Node 24 or newer, and a **production** Electron installer.
  Build it on Windows with the same entry CI uses (production by default):
  `npm run desktop:windows --prefix client -- --out <abs\x.noindex\out> --cache <abs\x.noindex\cache> --targetDir <abs\x.noindex\target> --sourceCommit <sha>`.
  Without `--signed-updates` this needs no signing key or update credential.
  - A development package (`"production":false`, such as the lab's
    `windows-entry-a3`) is not accepted. Its main process refuses a launch
    without `--tarobot-development=<.noindex dir>`, and this suite does not
    bypass that guard. Its first-launch checks would fail.
  - For `--next-installer`, build a second time from a scratch copy with a
    higher `client/package.json` version.
- **Optional inputs.** Each one enables one path. When an input is missing,
  its checks are reported as **skip**, never as pass.
  - `--legacy-installer`: a released **Tauri** TaroBot installer. Enables the
    upgrade path the old updater uses (`/P /UPDATE`), WebView2 data creation,
    the exporter run, carrying over a `Run\TaroBot` login item exactly as
    auto-launch 0.6.0 wrote it, and Credential Manager continuity.
  - `--next-installer`: a second Electron build with a higher version.
    Enables the Electron → Electron update.
  - `--native-tests`: needs Rust and cargo. Runs the Windows-only tests
    `windows_runtime` (staged helper, static CRT, `/P /UPDATE /R` handoff),
    `windows_control_job` (ControlJob retires the CLI and spares its detached
    child, with a negative control), and `windows_source_guard` (old-App
    mutex and forwarding window).
- `--scope install,upgrade,update,native,paired`: the scopes the verdict
  covers. The default is all five. Each scope lists required checks in
  `SCOPES` in the script.
- **Outcome** (exit code 0 only for `pass`):
  - `fail`: any check failed, in or out of scope.
  - `incomplete`: a required check of a judged scope did not run. The report
    lists every such check under "Not executed".
  - `pass`: every required check of the judged scopes ran and passed.
  - So a run with only `--installer` is `incomplete` unless you pass
    `--scope install`.
  - `paired` needs a Host and Credential Manager entries that existed before
    the upgrade, which a fresh machine has only after interactive pairing.
- **Output:** `windows-acceptance.json` and `windows-acceptance.md` in
  `--report`, which must lie under a `.noindex` directory.

## What each phase checks

| phase | checks |
|---|---|
| preflight | Windows; confirmation flag and env var; uninstall, location and Run keys read through .NET, where "absent" and "unreadable" are told apart; data folders `stat`ed; process list from CIM. Anything unreadable is a refusal. |
| native | the three Windows Rust test suites, built for `x86_64-pc-windows-msvc` with `+crt-static` as in release (`RUSTFLAGS` is not inherited, since it would override the target flags) and run one at a time (`--test-threads=1`: the source-guard tests share fixed mutex names). Each test binary must report at least one passed test, and no test may report `skipped:`. |
| legacy | Tauri layout (`<install>\host`); seeded login item read back; the old App creates `EBWebView` |
| install | installer exit code; uninstall key (name, binary, version); App, helper, updater, core, exporter, addon and `resources\host` runtime files; `tarocub` deep link; Start Menu shortcut target; notification receipt written by `--register-notification-shortcut`; `Get-StartApps` lists AppID `com.tarobot.client`; **the old `<install>\host` folder is gone**; login item kept |
| first-launch | the App is still running; `electron-profile\tarobot-desktop-profile-v1.json` is `fresh` for a new install, or `imported` with a UUID `exportId` after a Tauri upgrade; for an import, `desktop-migration\receipts\<exportId>.json` names the same export, target `electron` and more than 0 records (main writes it only after the renderer committed the import); Host and credentials (scope `paired`) |
| update | same install checks at the new version; profile marker unchanged (same mode and `exportId`) after relaunch |
| uninstall | uninstaller exit code; program, uninstall key and deep link removed; user data kept (a fresh start needs consent). Login item: after a Tauri upgrade, this installation's `Run\TaroBot` (`<exe> `) is removed (scope `upgrade`). On a fresh run, the suite first writes a `Run\TaroBot` for another directory; it must survive the uninstall, and then the suite deletes that value itself. |

**Processes.** The suite ends only processes it started:
- It records which `tarocub-client.exe` processes existed before each launch.
- At the end of a phase, it ends only new processes whose executable path is
  the installed App, by PID: main processes first, then any remaining child.
- It never uses `/IM` and never touches the Host (`node.exe`).

**Host.** The installer stops the Host on purpose, so the original process is
not expected to survive. `host-running-same-state` checks that a Host with the
same `--state-dir` (`hub run --state-dir …`) runs after the first launch. The
detail says whether it is the original process (same PID and start time) or a
replacement. Survival of the original process is never claimed.

## Migration content (persistent WebView2 → exporter → Electron)

The installer suite proves that an import was committed. These audits prove
what was imported. Both reuse `electron/tests/migration-content.mjs`:
- 9 records;
- the draft;
- the 150,000-byte attachment (name, type, time, SHA-256);
- the original outbox ID `client_migration_once`;
- no duplicate after a reload.

They need Rust, the WebView2 Runtime, and a **development** Electron package:

```bat
npm run desktop:windows --prefix client -- --development --package-only --out C:\lab.noindex\pkg --cache C:\lab.noindex\cache --targetDir C:\lab.noindex\target
rem package directory = desktop-build.json → packaged.paths[0] (contains tarocub-client.exe)
set CARGO_TARGET_DIR=C:\lab.noindex\audit-target
```

- **Non-persistent (needs no change in main).** One audit process seeds an InPrivate
  WebView2 and exports. No exporter binary and no SourceGuard are involved.
  ```bat
  node client\scripts\desktop-migration-audit.mjs C:\lab.noindex\export-1
  node client\electron\tests\packaged-migration.smoke.mjs <package>\tarocub-client.exe C:\lab.noindex\export-1 C:\lab.noindex\import-1 C:\lab.noindex\state
  ```
- **Persistent, through Electron main.**
  - A seed with a unique `com.tarobot.migration.acceptance.p…` identity
    writes a real WebView2 profile.
  - Electron main is launched with
    `--tarobot-migration-acceptance=<identity>`. It starts the audit-built
    exporter from `resources\native`, and the exporter's SourceGuard checks
    that its parent is that `tarocub-client.exe`.
  - **This needs the development-only option in `electron/main.mjs`.**
    Without it, the audit stops with
    `electron_main_acceptance_reader_hook_missing`.
  - The seed's `%LOCALAPPDATA%\<identity>` folder is left behind; the path is
    named in `verification.json`.
  ```bat
  node client\scripts\desktop-persisted-migration-audit.mjs C:\lab.noindex\persisted-1 <package directory>
  ```

## Removing the Tauri `host\` folder

An update skips the old uninstaller, so the Tauri Host runtime in
`<install>\host` would stay forever. POSTINSTALL now runs
`tarobot-installer-helper.exe --remove-legacy-host-runtime`.

The flag takes no path. The helper removes exactly the `host\` folder beside
itself, and only when all of these hold:
- it is a real folder, and nothing inside it is a reparse point (symlink or
  junction);
- it holds `node.exe`, `dist\src\index.js`, and a `package.json` named
  `tarobot` or `tarocub`;
- `tarocub-client.exe` is beside it;
- `resources\host` holds a complete runtime that is not redirected;
- the Host is confirmed stopped (checked last).

Otherwise it exits with a code from 30 to 34 and keeps everything. The
installation still succeeds, and `install/legacy-host-removed` reports the
leftover.

The helper's `host_runtime` prefers `resources\host`. The installer planner
refuses packages that ship both layouts.

This is covered on macOS by unit tests (old layout, unknown, symlink, missing
new runtime, Host running) and by a Windows cross-compile check. It has not
run on Windows.

## Not covered (needs a person, or a paired environment)

- A configured Host surviving the upgrade on a fresh machine. Pairing is
  interactive. The check runs automatically when a Host was already running.
- Whether migrated content matches the source. The receipt proves an import
  was committed, but not what it contained. Content is covered by the
  separate audits under "Migration content" above.
- Toast delivery and click activation, screenshot capture, and the settings
  UI toggles.
- A real signed update download. `windows_runtime` covers the installer
  handoff with a stand-in installer.

## In CI

A GitHub-hosted Windows runner is disposable. After the installer is built:

```yaml
- name: Windows acceptance (install → upgrade → uninstall)
  shell: pwsh
  env: { TAROBOT_WINDOWS_ACCEPTANCE: disposable }
  run: |
    $installer = Get-ChildItem "$env:TAROBOT_DESKTOP_OUTPUT/*-setup.exe" | Select-Object -First 1
    node client/scripts/windows-acceptance.mjs --confirm-disposable-windows --installer $installer.FullName `
      --report "$env:RUNNER_TEMP/windows-acceptance.noindex" --native-tests client/src-desktop-updater --scope install,native
```

Upload `windows-acceptance.*` from that directory as an artifact.

Without a released Tauri installer and a second build, CI can judge only
`install,native`. Add `upgrade` together with `--legacy-installer`, and
`update` together with `--next-installer`.
