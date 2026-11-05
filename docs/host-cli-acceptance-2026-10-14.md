# Headless CLI implementation and acceptance — 2026-10-14

Host package: `0.1.420`. This is a separate headless-host release. It does not
claim that a new Android APK, Windows desktop installer or Mac DMG was installed
or published by this work.

## Product contract

- Desktop and CLI use one canonical host directory, identity, Bot set and database.
- Hosts retain ownership of their Bots. Signed network membership does not copy
  their state to another host. A phone keeps its independent network membership.
- A/B/C tests exercise exported proposal/admission files through real CLI commands
  and authenticated local Hub endpoints. C leaves with its Bot; the phone remains
  authorized on A/B and must pair again to use C. Peer exchange inside this test is
  injected, so it is not evidence of a public VPS or physical-phone round trip.
- Codex, Claude, Antigravity, Kimi and DeepSeek use their existing adapters. Engine
  detection is separate from login, subscription and a successful model request.
- User services begin at user login/session availability. They do not keep a
  sleeping computer reachable or enable system-wide pre-login operation.

## Review and fixes

The primary implementation was reviewed with the actual installed Claude CLI,
model `claude-opus-5-5[1m]`, effort `xhigh`: design, implementation discussion,
read-only code audit, and a closing design discussion. The code audit reported
findings, not test execution. Runtime acceptance below was performed separately.

| Area | Resulting behavior |
| --- | --- |
| OS ownership | launchd `disabled/enabled` and `true/false` both parse correctly; Hub reports and verifies its supervisor label. |
| Service refresh | Package version cannot overwrite the service manifest's format version. |
| Frozen updates | Node and JavaScript are selected together; original identity, database and network remain in place. |
| Recovery | A failed preparation can restart only the verified, unchanged frozen runtime; no automatic database rollback. |
| Damaged versions | Status reports each bad revision independently; a valid compatible revision remains selectable. |
| DeepSeek state | Profile/credential links are preserved without following them; special files are skipped and recorded. |
| Old desktop identities | A Hub-bound, single-use native signature proves possession of the Keychain identity before migration. Phone scope is not promoted. |
| Drain | Server-side lease, ownership-aware renewal/cancel and expiry recovery prevent permanent pauses after CLI/SSH loss. |
| Stop admission | An authenticated stop binds the drained lease, PID and host public key. The service disables its persistent start intent before requesting the terminal transition; expired or mismatched leases cannot trigger an OS stop. |
| Shutdown failures | A failed flush does not skip listener, worker or control-socket cleanup. The instance lock is released only after resource closure is confirmed. Once stopping begins, lease expiry cannot resume queued work. |
| Signals | POSIX terminal interrupts are not duplicated; Windows uses authenticated local control and waits for child exit. |
| Supervisor environment | Launch-only supervisor state is removed before spawning Bots or engines. |
| Linux user manager | Loss of the user bus still permits verified local shutdown, with explicit degraded status. |
| Stale process identity | Boot UUID or kernel process creation identity distinguishes reused PIDs; uncertain legacy owners fail conservatively. |
| File mutex recovery | Independent Bakery tickets and release markers replace whole-directory stale-lock renames; a slow live owner is not displaced based on age. Local filesystems only. |
| Group-network exports | Destination reservation and durable stage receipts prevent overwritten or lost admission data. |
| Desktop installers | Updating a desktop App leaves an independently managed headless service running. |

## Checks and package acceptance

- Full standalone pre-complete gate: **256 test files, 3,327 passed, one skipped**.
  It ran with `VITEST_MAX_WORKERS=2` on this Mac. The prior high-concurrency run
  exceeded several existing short test deadlines; the final run did not weaken
  those deadlines. The added stop contract required updating an old Tailscale
  mock; all five Tailscale tests passed. The final uninstall race check also
  passed the 61-test service suite.
- Final standalone build: **324 modules**, with strict App-host TypeScript and
  no legacy transport/Feishu SDK in the dependency graph. Client production build
  passed. This is not a claim that the separate, optional legacy build passes
  without its adapter dependencies installed.
- Desktop native proof: Rust unit tests and `cargo check` passed. Windows x64
  supervisor: five Rust tests and a real `cargo-xwin` cross-build passed.
- The `.tgz` was extracted outside the checkout and installed with production
  dependencies. A separate isolated global-prefix installation passed
  `tarobot --version`. Both installations actually started the Hub, served the
  packaged client and shut down. The full production dependency tree had no
  problems and contained no Feishu SDK. This run used official Node 24.14.0;
  it did not separately validate every version permitted by the Node engine range.

## Actual macOS service acceptance

A disposable launchd host with zero Bots retained its public key and signed
network membership through **update → rollback → update**, using normal guarded
stop behavior. The two compatible `0.1.420` revisions differed by a test-only
documentation marker; the final revision used the unmodified release package.
This validates runtime selection and data retention, not an upgrade from every
historical release. The older fixture predating the stop guard was first stopped
with an explicit force operation; it had no Bots or tasks.

The final package also passed LAN pairing-link generation, discovery of all five
engine executables from the service, normal stop, restart and service uninstall.
The final status confirmed no running Hub and no configured service. Earlier
isolated service checks covered supervisor crash restart and abandoned drain
lease recovery. No model request was issued by these lifecycle tests.

Release artifact: `tarobot-0.1.420.tgz`, 24,547,551 bytes.
SHA-256: `2c5b44c08b10b5856ae6fe39c1efe03e6bd7af8c31258fe000c04e127834fca5`.
Host/CLI version is `0.1.420`; client protocol is v1; supported Hub schema range
is 1–14. App source version remains `1.0.68`; this release does not replace its
previously published installers. The Windows helper is included in the archive.

## Platform limits

The Windows x64 GUI supervisor is cross-compiled and its Job Object lifecycle is
tested through unit fixtures. Real Windows Task Scheduler, logout, interruption
and descendant cleanup still require a Windows session. Linux unit content is
checked against systemd's parser; an actual systemd user session is not available
on this Mac. Neither is called native acceptance.

No production host, existing Bot conversation or paired phone was reset. The
native service tests use a disposable host with no model calls. The installed
production App was not replaced or restarted.
