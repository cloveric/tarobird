# Windows reinstall and native startup recovery

## User-facing behavior

Windows 1.0.75 offers **全新开始 / Start fresh** when an interactive installer
finds data left behind by an uninstalled copy. Yes backs up this Windows account's
TaroBot configuration, local host data and WebView profile, then starts from
first-time setup. No retains the old state; Cancel stops installation.

An existing installation is recorded **before** the upgrade UI invokes its old
uninstaller. Normal upgrades, `/UPDATE`, silent and passive installations never
offer or perform this reset. The existing uninstaller's optional “删除应用程序数据”
checkbox uses the same guarded backup helper instead of recursively deleting data.

Backups are sibling `TaroBot-backup-<unique ID>` directories in the current user's
Roaming/Local Known Folders. They are not automatically imported into the new
installation. This is an application fresh start, not secure erasure: the backups
remain private local data and orphaned Windows credential entries are retained.
New setup creates a new device identity and requires pairing again. Existing
authorization records on remote hosts are not revoked by a local reset.

Mac mini, other network members, and custom CLI state directories are not touched.
An installed CLI service, an active host process or an unreadable owner record
blocks resetting shared data. Close the App and stop/uninstall the owning CLI
service first; do not start another CLI while installing. Ordinary App upgrades
continue to preserve independently installed CLI services.

## Implementation and review

- `fresh_install.rs` runs before WebView/single-instance initialization and is
  independent of the bundled Node/module graph. It accepts no path arguments and
  resolves the same OS Known Folders as Tauri. It refuses redirected application
  roots, checks both roots before moving either, and retains both originals if a
  second move fails and rollback is possible. It never overwrites newly created
  data during rollback. An incomplete rollback aborts with a distinct message.
- `installer-hooks.nsh` records installation ownership at GUI initialization,
  asks for an explicit fresh-start choice, invokes the new executable from the
  installer staging directory, and stops installation on recovery errors.
- If the old Node stop command fails, the new App can still uninstall when native
  checks independently establish that no host/service owns the state. It never
  kills a process based solely on a PID file.
  The new installer's staged helper can also verify shutdown when the installed
  old executable lacks this fallback. A recorded Windows process creation time
  is checked to distinguish a reused PID from the original owner.
- The local-controller cache open is now within its recovery boundary. A known
  local cache failure leaves that host pending while independently paired remote
  hosts can connect. An unknown local identity remains a fatal startup failure.
- Native Windows/Android shells no longer register the browser PWA worker.
  Windows also removes an existing TaroBot root worker at document start, without
  deleting IndexedDB, credentials or drafts. Retry and reload are bounded; a page
  cache cleanup failure does not block the new renderer. Browser PWAs keep their
  offline worker. The Windows title includes the actual App version.
- Startup diagnostics classify additional control-pipe, schema, runtime and ESM
  errors without sending raw stderr or private paths to the WebView.

Opus 5.5 xhigh independently reviewed the previous startup candidate and the
native cache patch. Its confirmed cache-open and diagnostic gaps were addressed;
its reload watchdog and best-effort cache cleanup recommendations were included.
Its separate reinstall review identified the old-executable upgrade trap, process
identity reuse, installer working-directory restoration and misleading deletion
wording. The new native shutdown probe, FILETIME comparison, explicit SetOutPath,
backup confirmation and registry cleanup address these points.
The exact reported 1.0.74 `resume/status` exit-1 cause is **not established**.
An old service worker cannot explain the user's new versioned diagnostics by
itself, and a fresh install is not evidence that the original root cause is fixed.

An older uninstaller cannot be changed retrospectively. If 1.0.74's own uninstall
fails because its stop command fails, run the new installer using its keep/overlay
option first; the new preinstall check can verify an already stopped host. Then
use the new uninstaller. Existing old uninstallers also retain their old optional
recursive-delete behavior, so do not use their data-delete checkbox on a shared
CLI host.

## Verification boundary

The native backup/rollback tests use isolated temporary directories. Chromium
tests exercise worker recovery, user-data preservation, CSP, timeout/retry,
production worker registration and local/remote cache isolation. Windows code is
cross-compiled against the actual Windows target and the generated NSIS installer
is compiled. The final extracted executable's version and compressed frontend
assets are checked, separately from its bundled Hub web UI.

Verified for this candidate: the full standalone gate passed (3,942 tests, one
skipped); ten isolated native recovery tests and the native error-classifier test
passed; 37 focused browser tests passed, plus eight cache tests after adding CSP,
browser-registration and failed-cleanup coverage. The recovery module is included
under `cfg(test)` on non-Windows too; OS process-query behavior still requires
Windows. Windows x64/MSVC compilation and NSIS packaging passed.

These checks do **not** exercise a real Windows installer, WebView2 or Task
Scheduler. Native acceptance still needs uninstall/reinstall with retained data,
the fresh-start and keep choices, an ordinary upgrade, a running/installed CLI,
and a successful new pairing on the affected Windows computer.

An unrelated existing startup byte-budget regression was reproduced on the exact
released 1.0.74 frontend: 805,181 bytes against a 700,000-byte budget. The budget
was not relaxed and is not included in the passing focused startup tests.

## Release scope

App candidate: **1.0.75**. Bundled host/CLI stays **0.1.425**, protocol v1,
schema 15. Host APIs, engine adapters and the standalone CLI implementation are
unchanged. CLI parity is not a new command: this is a Windows installer recovery
operation, with explicit protection for shared headless-host ownership. No mobile
or macOS installer is republished for this Windows-only candidate. It remains a
prerelease without an automatic update feed until real Windows acceptance.
