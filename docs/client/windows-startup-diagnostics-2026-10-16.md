# Windows 1.0.75 startup investigation

The reported 1.0.75 screenshot contains the new startup-failure UI and two failed
operations (`resume` and `status`, exit 1, reason `unknown`). This confirms that
the new UI reached the machine; it does **not** establish that residual state was
cleared, that the host modules loaded, or that the failure is an identity problem.
No Windows execution evidence identifying the underlying failure is available.

## Confirmed diagnostic defect and repair

The entrypoint printed only `error.message`. A real Node native-addon loading
failure has an `ERR_DLOPEN_FAILED` code that is absent from its message; the native
classifier looked for that code in stderr and could return `unknown` instead.

The entrypoint now emits a dependency-free, code-only diagnostic marker before
the existing stderr message. It records whether the desktop module import or
command execution failed, a fixed allowlist of error codes (including nested
causes), and a fixed allowlist of error classes. The native classifier and client
both validate these fields; raw messages, paths, configuration and stack traces
still do not enter the UI or its copied report. Older hosts without a marker
retain the previous classification fallback. Successful JSON responses and
gateway exit/cleanup behavior are unchanged.

The startup message now describes the local runtime failing to respond. This
failure alone does not prove a credential or device-identity problem. Unknown
local identity still fails closed; no authentication bypass, automatic deletion,
service restart or state migration was introduced.

## Independent review and verification

An actual `claude-opus-5-5` review at `xhigh` confirmed the diagnostic gap but did
not establish the Windows root cause. Dependency loading is a candidate, especially
if the state really is empty. Package architecture and static PE imports were
checked; they do not establish that Windows will allow a native module to load.
No unsupported dependency replacement or security-policy workaround was adopted.

Regression coverage:

- Real Node subprocesses execute the entrypoint through missing-module failure,
  translated error text, command failure, and successful JSON output.
- A deliberately invalid `.node` fixture triggers Node's real
  `ERR_DLOPEN_FAILED`; the test verifies that the marker retains the code while
  the actual message lacks it. This is not a fabricated coded stderr fixture.
- Rust classification checks preserve the code and reject private fields.
- Browser tests verify copied diagnostics, retry, unchanged saved identities and
  drafts, and rejection of unrecognized fields.

Local validation: full pre-complete gate passed (3,946 passed, one skipped),
client production build passed, three startup browser tests passed, and two
standalone Rust diagnostic tests passed. All of these ran on macOS.

These checks verify the diagnostic repair, **not Windows startup acceptance**.
The developer owns installed-runtime and fresh-state verification; do not ask
the owner to execute import/status commands or repeat manual cleanup. The
[subsequent runtime investigation](windows-runtime-fixes-2026-10-16.md) records
isolated Windows-binary execution, two confirmed defects, and the unresolved
native Windows acceptance boundary. Repeated reinstall is not proof of a repair.

## CLI and release boundary

The marker belongs to the shared host entrypoint's `desktop-host` command; it
does not add a second host implementation or change the public headless CLI
commands. A release containing this host-code change requires a matching CLI
artifact under the normal parity gate. This investigation has not published a
new installer, changed an update feed, or claimed the user's startup issue fixed.

## Earlier 1.0.74 diagnostic candidate

The reported Windows installation was uninstalled and reinstalled. The App then
showed `无法确认本机控制身份` with a distant retry button on a mostly blank page.
Uninstalling does not prove that credentials, WebView data or host state were
removed. The exact failing operation on that Windows machine is not yet known.

### Confirmed problems and changes

- `prepareLocalController` discarded both native resume and status errors; the
  Rust wrapper also discarded the child exit code and stderr category. Retain
  the failed step, stable error code, numeric exit/OS code and allowlisted error
  category. Never expose raw stderr, private paths, arguments or credentials.
- The fatal startup page placed unrelated direct children into a full-screen
  centering grid. Use an eagerly loaded recovery card with retry, copyable
  diagnostics and an expandable text fallback when clipboard access fails.
- Do not run the periodic native resume watcher after initialization failed.
  The recovery card's explicit retry reloads startup; it never resets data.
- Keep unknown native identity failures closed. Existing native-confirmed local
  identity and remote-host recovery behavior remain covered by regression tests.
- Repair the HMR test's temporary source-copy imports so its shared protocol
  imports work outside the checkout and on the external test volume.

### Verification and limits

- Standalone build and full tests: 3,942 passed, one skipped.
- Browser startup, native transport, network cache and HMR: 69 distinct tests
  passed after repairing the HMR fixture. Includes residual pairing/drafts,
  native-failure isolation, explicit retry, code-only diagnostics and clipboard
  failure. This uses mocked native IPC and is **not Windows native acceptance**.
- Rust diagnostic formatter tests pass, including Windows numeric process
  failure codes, missing modules, database errors and sensitive stderr removal.
- The Windows 1.0.73 extracted installer contained the expected Windows x64
  executable, Node runtime and SQLite addon. That is structural evidence only.
- Windows 1.0.74 is a **diagnostic candidate**. It does not establish or claim to
  fix the underlying startup fault on the reported machine. Obtain its copied
  diagnostics or the packaged `desktop-host status` error before choosing a
  runtime, permission or state repair. Do not delete or re-pair to hide the fault.

### Release scope

App version 1.0.74; unchanged host/CLI core 0.1.425, protocol v1 and schema 15.
This change concerns the desktop native launcher and client startup presentation.
No host API, capability, CLI command, engine adapter or authorization rule changes;
the standalone CLI and mobile installer are not republished in this Windows-only
diagnostic release. It must not replace the default release or signed updater
feed until the Windows issue is resolved and verified on the affected platform.
