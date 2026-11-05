# Windows installation runtime fixes (1.0.76 / CLI 0.1.426)

Installation and fresh-start acceptance are the product's responsibility. Do not
ask the owner to run Node commands, delete AppData, or clear caches to establish
whether a newly installed host can initialize. Preserve existing host data.

## Reproduced first-start failure

The released 1.0.75 Windows package fails `desktop-host start` in an isolated
Wine 11.18 prefix on the external disk. Its own Hub log reports
`EPERM: operation not permitted, fsync`. `HubAuth.create` writes its first identity
through `JsonStore.write`, which reopened the temporary file read-only before
syncing. Windows [FlushFileBuffers requires GENERIC_WRITE access](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

Regular files now reopen with `r+`, which preserves the bytes and grants the
required access. This includes settings, collaboration, service manifests,
kanban backups, the shared bus registry and optional adapter env writes. Directory
sync handling is unchanged; real file flush failures still propagate and retain
the previous state. Corrupt-config copies are set to private writable mode
before syncing so POSIX recovery still accepts a read-only original. The
Linux-only relay updater is outside this Windows defect and remains unchanged.

The A/B execution used the released Windows Node 24.14.0 and a Windows Rust probe
matching the App's Tokio hidden-window launch, piped stdin/stdout/stderr and
closed `null` input. Replacing only the eight initial fixed compiled modules in
the same package changed start from exit 1 to exit 0. Start/status/resume reported
the same running host identity; stop/resume reported stopped. This is execution
of actual Windows binaries under Wine, **not native Windows OS acceptance**.

Empty-state status/resume succeeded with both packages. Therefore this reproduced
first-start defect does **not** prove the cause of the owner's earlier
`resume/status: exit 1, unknown` screenshot. Do not describe that report as solved.

## Missing runtime in the service launcher

The released `host/bin/tarobot-host-launcher.exe` imports `VCRUNTIME140.dll`, but
the installer does not provide that DLL or install the VC++ redistributable.
The desktop EXE, bundled Node, SQLite, canvas addon and installer helpers do not
share this dependency. The launcher affects scheduled/headless service startup;
it is not called by the App's resume/status operation.

`build-host-launcher.mjs` now scopes `-C target-feature=+crt-static` to this final
executable using `cargo rustc` / `cargo xwin rustc`. The built launcher's PE import
table contains only KERNEL32, the system sync API set, and ntdll. No global Rust
flags, system runtimes, security settings or user services are changed.

The standalone prepack verifier checks normal and delayed PE imports. The new
`scripts/verify-windows-runtime.mjs EXTRACTED_INSTALLER_DIRECTORY` checks every
EXE/DLL/native addon in the final installer. The Windows workflow runs this gate
after extraction. Missing, linked, malformed, console and unbundled-runtime
launcher cases have regression coverage. UCRT API sets built into supported
Windows versions remain allowed. The new gate rejects the old final installer
specifically for its launcher dependency.

## Acceptance and release boundary

The headless CLI uses the same fixed state writers and launcher. App 1.0.76 and
CLI 0.1.426 are paired; protocol v1 and Hub schema 15 are unchanged. No engine
adapter protocol or authorization behavior changes. All five engine setting
contracts remain in the existing regression suites.

`windows-state-sync` enforces Windows' handle-access contract with real file
operations on every test OS. It covers identity replacement, failed-flush
preservation, corrupt-config backup/recovery, read-only POSIX originals, persona
backups, effort/permissions and concurrent-instance registry preservation. The
adapter env suite applies the same contract to every env-write case.

The GitHub native Windows job [38883213092](https://github.com/cloveric/tarobot/actions/runs/38883213092)
never started: GitHub reported failed account payments or a spending limit. No
native Windows tests passed in that run. Wine cannot establish WebView2 GUI,
Defender/WDAC, real Task Scheduler or physical-machine installer acceptance.
Keep this release a candidate and do not promote the default updater on that
basis. The owner is not asked to debug these remaining acceptance boundaries.

Verification artifacts and disposable state are under the external
`taro-tmp/tarobot-windows-runtime-20261016` laboratory. The upgrade and desktop
verification scripts accept `TAROBOT_ACCEPTANCE_TMPDIR` for a short external
temporary path. Production Mac host state and optional transport fleets are
untouched.

Completed verification:

- Full standalone pre-complete gate: 301 files, 3,978 passed and one skipped.
  An earlier run overlapping heavy compilation/legacy tests timed out in one
  Gateway session test; the unchanged case passed alone and the full gate then
  passed with those concurrent workloads finished. No timeout was raised to hide
  the result.
- Legacy adapter build and suite: 57 files, 1,230 passed, including env writes
  under the Windows flush-access model.
- Client production build and Windows x64/MSVC compilation/NSIS packaging passed.
  Final extraction matched 4,897 host files, and all 344 compiled host modules
  matched the independently installed CLI archive. All 13 final PE files passed
  the runtime import gate. Final desktop HTML/entry JS/CSS matched the compressed
  assets embedded in the extracted EXE; this is separate from Hub web assets.
- Final extracted Windows Node/package under Wine: actual Tokio hidden-window
  start/status/resume/stop/resume all exited zero. The packaged-host end-to-end
  script passed argument and private-pipe roundtrips, authenticated pairing, Bot
  creation, a synthetic engine reply and host identity/name restoration. The
  synthetic engine result is not a real-provider response.
- Standalone production install outside the checkout, dependency-tree inspection,
  archive extraction/reinstallation and Hub startup passed. No Feishu SDK is in
  that package. Upgrade from CLI 0.1.425 to 0.1.426 retained host/controller
  identity, private network and workspace, and started the upgraded host. This
  upgrade check ran on macOS and did not install a persistent OS service.
- Actual Codex provider through the extracted CLI package on macOS passed text
  and two simulated-client synchronization, byte-identical file return, local
  ASR, question-card submit/resume and streaming stop/resume with retained
  context. No optional transport calls occurred. Claude, Antigravity, Kimi and
  DeepSeek real-provider acceptance was not repeated for this storage-only fix;
  their settings/adapter regressions ran in the complete suites above. No
  physical phone or Windows WebView UI was exercised by this protocol test.
