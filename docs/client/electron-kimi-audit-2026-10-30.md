# Electron migration: Kimi audit and independently reviewed fixes

The independent Kimi review covered migration commit `5c2ff906fa01cb1fa0dc174052387d83883e4a30`
against pre-migration baseline `0255848`. Codex and actual Claude Opus 5.5
checked its findings against that frozen source, reproduced the relevant paths,
and reviewed the fixes. The [machine-readable ledger](electron-kimi-audit-2026-10-30.json)
records each disposition and hashes of the preserved original reports.

The owner has explicitly paused publication and installation until a new release
request. This work changes source only. The prepared local 1.0.121 artifacts are
held and predate these fixes; they must not be published or activated as if they
contained this audit. No production Host was restarted.

## Findings and decisions

| Finding | Independent conclusion | Result |
|---|---|---|
| KIMI-MIG-001: own `__proto__` data keys disappear during migration | Reproduced in the frozen codec; a data-loss bug, not demonstrated global prototype pollution or code execution. Severity reduced to P3. | Fixed with explicit enumerable own data properties in encoding and decoding. Nested objects, arrays, escaped tags and real IndexedDB export/import/reopen preserve the bytes and keys. |
| KIMI-MIG-002: old macOS App starts during export | Confirmed with real process enumeration and an isolated synthetic old-App process. The exact mixed-WKWebView snapshot remains untested; P3. | Partially mitigated: monitor while exporting, recheck after exporter exit and before binding the stable source snapshot. Any observed old App invalidates the export. This is not whole-export exclusion. |
| KIMI-UPD-001: lost install result permits retry/relaunch | Independently reproduced with real main-process classes and mock native subprocesses. An exit is not proof that rollback completed; P2. | Pending install loss, invalid replies and explicit recovery failures latch a recovery state. No retry, relaunch, automatic renderer reload or helper/Host launch from an uncertain bundle. |
| KIMI-UPD-002: install/handoff still accepts competing work | Accepted with narrower impact, P3. Rust already serialized replacement; an accepted info call alone does not prove disk corruption. The helper-start and Windows handoff gaps were real. | Active install rejects competing operations while retaining its explicit cancellation path. Windows handoff rejects further updater work. Existing helper Host commands are gated too; established sockets remain usable. |
| KIMI-RSK-001 / OP10-02: two-renames replacement gap and power loss | The missing-App gap was independently reproduced on APFS. Power-loss durability is a separate unproven risk. | Replacement uses atomic path exchange and fails closed if exchange fails. Rollback prefers the actual previous bundle, preserving its inode. Power-loss durability remains open. |
| KIMI-RSK-002: retained exports and repeated verification | Resource/retention concern, P3; no measured user impact established by Kimi. | Kept open. No automatic deletion of recovery snapshots, and no weakening of content verification. Large-profile measurement belongs to the subsequent latency investigation. |

Kimi's proposed pre/post physical-directory fingerprint comparison was not
adopted as a consistency guarantee: the exporter's own WebKit storage process
can flush WAL/checkpoint data. A changed physical fingerprint does not identify
an application writer. Polling also cannot detect a complete start/write/exit
between observations. Real concurrent WKWebView validation remains necessary.

Opus caught a side effect in the first fence implementation: a passive Host
recovery check on window focus could request an App restart. The final wiring
distinguishes a Host command from starting a helper; a passive command refuses
the unsafe action without requesting restart. Opus independently exercised the
actual window callback and confirmed that behavior.

## Native recovery and compatibility

When rollback fails or the replacement worker ends without a known outcome,
the updater asks its private Host pause child to retain an already-stopped Host.
The CLI understands `retain-stopped`, records `appRecoveryRequired`, and does not
launch the uncertain runtime. Independently managed Hosts remain untouched.
This is a shared private Host protocol change, not a new public CLI command.
App and standalone CLI must therefore be built from the same revision at the
next authorized release.

The instruction is best effort: killing the updater before it writes the line
still leaves the previous EOF recovery behavior. Atomic exchange removes the
ordinary missing-install-path window, not every crash/power-loss scenario.
Historical Tauri recovery on filesystems without exchange support retains its
two-step fallback; Electron replacement itself has no such fallback. Unsupported
volumes fail without moving the running App and require manual installation.

The recovery UI deliberately does not offer an automatic restart when the App
files are unconfirmed. Unknown results and explicit restoration failures share
this conservative state. New helpers are blocked throughout installation, even
if a download or Host drain is still in progress. This may temporarily limit
native capabilities if a helper dies during an update.

## Coverage and evidence

Kimi examined the 241-file migration diff and related call paths: main/preload
authorization, frame and document leases, Rust identity and pinned transport,
export/import and keychain compatibility, files/notifications/permissions,
window lifecycle, Mac updater and Windows installer, signing/publication guards,
shared React adapters, Host/CLI and mobile branching. Large unchanged business
files were inspected along relevant paths, not claimed as a new line-by-line
audit of the entire repository. Its final report was compared with all 27
earlier DeepSeek proposals; duplicates and previously open risks stayed labeled.

Kimi's initial Cargo commands did not run because its environment lacked the
configured toolchain path. That is not a passing Rust check or a code defect.
Opus subsequently ran the native suites with the configured toolchain. An early
test of Root's in-progress TDD changes was also excluded from frozen-source
findings. Original reports are preserved separately from these corrections.

Executed checks for the final fixes:

| Boundary | Result |
|---|---|
| Electron main/preload/helper tests | 132 passed |
| Migration codec | 13 passed |
| Update controller and browser UI | 23 passed |
| Real IndexedDB export/import/reopen | Chromium 3 and WebKit 3 passed |
| Real isolated Electron + native helper + pinned TLS/WebSocket | 13 checks passed; no production Host or model |
| Native updater | 47 unit tests plus 17, 2 and 5 integration tests passed |
| Native updater lab: signed fixtures, replacement/rollback and isolated Host | 15 passed |
| Host update protocol/session | 26 passed |
| Full pre-completion check | Passed: Host build, 528 Vitest files / 7,154 tests (5 skipped), client build, Tauri 98 + 3 + 3 tests |

Counts overlap and are not summed as unique coverage. The atomic exchange test
observed zero missing install paths across repeated exchange/rollback cycles and
checked the restored inode. An isolated two-rename mutation made that same
observer fail, demonstrating that the test detects the original gap.

Still unverified: these changes in a newly signed installed `/Applications`
bundle; real legacy WKWebView concurrent writers; native recovery dialogs and
quit flows during real update failure; power-cut recovery. Windows physical
runtime remains explicitly deferred by the owner. Source, isolated fixtures and
earlier acceptance receipts do not substitute for those boundaries.
