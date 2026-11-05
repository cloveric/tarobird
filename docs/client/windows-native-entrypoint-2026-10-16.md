# Windows native host entrypoint repair

## Reproduced cause

On native Windows, the affected 1.0.76 installation still showed
`desktop_host_operation_failed`, exit 1, reason `unknown`, for both `resume` and
`status`. The bundled host worked when invoked with an ordinary drive path.
Using the same Node 24.14.0 executable with a canonical Windows verbatim main
script path (`\\?\C:\...\dist\src\index.js`) reproduced
`EISDIR: illegal operation on a directory, lstat 'C:'`.

Node failed in its main-entry `realpathSync` before importing the host entrypoint,
so the JavaScript startup diagnostic marker could not run. An empty host data
directory was not the cause of this bootstrap failure. This identifies an
additional native launch defect beyond the separate first-write and service
launcher CRT fixes recorded in [Windows runtime fixes](windows-runtime-fixes-2026-10-16.md).

## Source fix

`desktop_host_node.rs` shares one native-owned Node command constructor between
desktop IPC and the installer's host-stop helper. On Windows it passes
`--preserve-symlinks-main` before the main script path, bypassing Node's failing
main-entry realpath. It retains hidden-window process creation and removal of
`NODE_OPTIONS`/`NODE_PATH`. Other platforms retain the existing invocation.

The flag applies only to the main script. Dependency resolution, native controller
proofs, host directory selection, runtime identity checks, and device authorization
remain in their existing owners. This does not strip verbatim prefixes, resolve
paths supplied by the renderer, or require a replacement Node executable.

The affected computer was recovered with a reversible local path-normalizing
launcher and completed native WebView onboarding, host connection, application
reopening, and cold host recovery. That emergency launcher is not part of this
PR. Those GUI observations validate the local recovery, not a newly built App
containing this source fix.

## Regression and release boundary

The dependency-free Rust module can be exercised without building Tauri:

```powershell
$env:TAROBOT_TEST_NODE = 'C:\path\to\bundled\host\node.exe'
rustc --edition=2021 --test client/src-tauri/src/desktop_host_node.rs -o native-node-tests.exe
.\native-node-tests.exe
```

These tests create real canonical Windows paths containing spaces and Unicode,
then execute the selected Node with piped, closed `null` input. They cover the
desktop status/resume/start and installer-stop argument shapes, successful stdout,
and preservation of a script's failure exit code and stderr. Both tests fail
before the Windows flag with the real Node `EISDIR` and pass afterward. The
Windows installer workflow supplies the packaged Node to its native Rust tests.

Local validation on native Windows:

- Bundled Node 24.14.0: both new Rust regression tests passed, after both had
  failed with `EISDIR` before the fix. The existing two native diagnostic tests
  also passed.
- A standalone Rust probe importing the source command constructor executed the
  installed host entrypoint through canonical Windows paths against disposable
  state. Empty-state status/resume, start/status/resume, stop, and stopped resume
  all passed; the running host identity stayed the same. This verifies the
  constructor with real host code, not a rebuilt Tauri executable.
- `npm run build` passed. Focused `windows-host`, `windows-state-sync`,
  `startup-error`, and `desktop-host` suites passed: 21 tests, one skipped.
- The complete suite did not pass in this Windows environment. A bounded retry
  (`npm test -- --maxWorkers=2 --bail=1`) stopped at the unchanged Kimi ACP test's
  directory-symlink fixture with `EPERM`. No system security settings were
  changed to work around that fixture requirement.

This is a native Windows App/installer launch fix. It changes no shared host API,
headless CLI command, schema, engine adapter, or mobile behavior, so there is no
separate CLI implementation or package change. No release version, installer,
update feed, or user data is changed by this PR. A release still needs a rebuilt
Windows App and final-installer acceptance through the normal release gate.
