# macOS DMG replacement and running Host reconciliation

## Confirmed problem

Replacing the App from a DMG updates files on disk; it does not run the in-App
updater's lifecycle handshake or replace an already running Node process.
`desktopHost(start/resume)` previously reused any running Host. When that older
process lacked the native desktop challenge/enrollment endpoints, the pairing
step failed. `prepareLocalController` classified every pairing exception as
`credentials`, including missing endpoints and transport failures.

The reported MacBook was already recovered by its local operator. This change
never operates on that machine or resets its identity, pairing, or database.

## Behavior and ownership

- macOS ordinary `desktop-host resume` and `start`, for an initialized host, now
  inspect the running process version and control capabilities before pairing.
  The decision uses the live response, not just the installed package version.
- An older App-managed runtime is handed off through the existing
  `desktopUpdateSession` lifecycle. The same desktop-start file mutex serializes
  concurrent windows, manual stops and installer operations.
- Automatic handoff requires desktop hosting enabled, the bundled Node and
  entrypoint selected, no configured OS service, no reported independent runtime
  identity/supervisor, both unchanged immediately before stopping, and the
  running public key matching the existing identity file.
- Only runtimes with drain, renew, cancel and guarded-stop capabilities qualify.
  A short (1 second) drain attempt returns `runtime_waiting` when work remains or
  another operation owns drain. The owned timed-out lease is canceled so task
  acceptance resumes; another owner's lease is never canceled.
- Recovery uses the existing focus/online/visibility and 60-second watcher.
  Tasks, questions and approvals are never force-stopped. Existing authenticated
  connections remain usable while waiting. A pending connection completes native
  proof again after recovery and then clears its connection pause.
- Once idle, stop is bound to the captured PID, public key and drain lease. The
  old PID must exit before start. Existing restart, identity-hash and SQLite
  retention checks run before success is reported. The new running version and
  native proof capabilities must match the installed runtime requirements.
- `desktop-runtime-recovery.json` atomically records an attempted handoff before
  stop (installed host version and identity-file SHA-256, no key material).
  Failure does not repeatedly restart the same old process on every timer.
  Successful verification clears the record. If the backend is already stopped,
  normal enabled-host startup can still recover it; this is not a drain retry.
- Equal/newer versions are not downgraded. Unknown/prerelease versions do not
  establish an automatic upgrade direction. Incompatible independent runtimes
  require an explicit operator update; a runtime without safe drain support
  requires a restart after its tasks finish. If native proof is supported, that
  older host remains usable while the user finishes work and arranges the restart.
- A disabled/client-only installation stays disabled. No new identity, directory
  migration, permissive authentication fallback or new pairing is introduced.

## Diagnostics

Shared client status distinguishes `runtime_update_required`,
`runtime_restart_required`, `runtime_waiting`, and `runtime_recovery_failed`.
Native stderr classification preserves missing endpoint and rejected-proof
reasons using allowlisted codes only; raw stderr, local paths and credentials
remain outside the renderer. Keychain unavailability and unknown control failures
no longer claim credential corruption. Identity mismatch still takes priority.
An earlier waiting notice clears when the replacement is live.

## Code and CLI impact

- `src/client-protocol/desktop-runtime.ts`: pure version/capability policy shared
  with the renderer's waiting-state handling.
- `src/hub/desktop.ts`, `desktop-update.ts`: ordinary macOS launch hooks into the
  existing guarded installer lifecycle; no separate process manager.
- `src/host-cli/lifecycle.ts`: stable busy/owned error codes, with existing CLI
  messages and owned-lease cleanup preserved.
- `client/src/local-controller*.ts`, `startup-diagnostics.ts`,
  `client/src-tauri/src/desktop_host_error.rs`: scoped diagnostics and recovery.

The local `desktop-host` CLI shares this implementation. Independently selected
headless CLI runtimes and OS-supervised services continue to use their existing
explicit update/lifecycle commands; the App cannot silently replace them. No new
CLI command is needed. Automatic ordinary-launch reconciliation is macOS-only;
other platforms share the improved error classification but do not gain an
untested automatic upgrade lifecycle here.

## Verification and boundaries

Source baseline: `0cbbc391af233bdd26cce4c214a43108ae68453b`.
The external project volume remained inaccessible, so this is a targeted source
patch, not a completed release. No installed App or running owner Host was
replaced/restarted as part of verification.

Codex local checks:

- Baseline reproduction: original pairing catch returns `credentials` for the
  old-runtime endpoint failure.
- 35 policy/controller cases passed using Node 24's TypeScript transformation
  and Node test runner (the two assertion-based Vitest files were executed with
  their `it` import mapped to Node). Native requests were injected fixtures.
- 19 lifecycle checks passed with real production file mutex/JSON checkpoint/
  SQLite snapshot implementations and fixture process-control responses. Cases
  included concurrent windows, failed stop/acknowledgment, independent runtimes,
  changed ownership, identity bytes, row retention and failed replacement proof.
- 5 checks exercised the changed `desktopHost` entrypoint with disposable state
  initialized by the production setup routine and fixture process control:
  ordinary replacement, busy then idle, backend cold start, explicit stop and
  already-current runtime. No real second Hub was launched.
- 4 checks executed the changed drain helper, including owned-lease cleanup,
  another owner, failed cancellation and idle readiness.
- 3 standalone Rust diagnostic tests passed, including new version/proof error
  classification and privacy-safe output.
- Changed TypeScript syntax and all 17 local-controller message translations were
  checked. These are not substitutes for TypeScript type checking or the full
  translation scan.

Added/extended repository regressions: `desktop-runtime-policy`,
`desktop-runtime-controller`, `desktop-runtime-drain`, `desktop-update` and
`local-controller-recovery`. The full Vitest invocation has NOT run in this
restricted source snapshot. Root/client builds, complete translation checks,
Chromium/WebKit and a packaged DMG upgrade with native Keychain remain pending.
GitHub Actions are additionally blocked by the known private-repository billing
limit. Do not report these checks as passed or the installed App as fixed.

No Opus/subagent review was requested for this repair; none is claimed.

## Existing installation recovery

An already recovered installation needs no data migration or new pairing.
For an affected old installation, first let tasks and pending questions finish,
then use its existing local Host stop/start controls to load the bundled Host.
Verify the actual running version and desktop native proof, retaining the same
identity and database. Merely closing and reopening the App can leave the old
background process alive. Do not delete state or initialize another Host.

Before shipping, run the full regressions above and reproduce a real DMG
replacement while the old App-managed Host is running: both idle and busy,
including pending approval, explicit stop, retained identity/history, and a
subsequent cold start. Independently selected or supervised runtimes must remain
unchanged.
