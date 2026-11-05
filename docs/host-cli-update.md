# Headless host runtime updates

`src/host-cli/update.ts` updates the executable selected for one existing host.
It never creates a second Hub identity, transfers Bots to another host, changes
network membership, or automatically restores an older database. The desktop
and CLI must pass the same canonical host state directory to this module.

```sh
tarobot update stage --from /path/to/trusted-standalone-package
tarobot update status
tarobot update apply <revision-id-from-stage> --dry-run
tarobot update apply <revision-id-from-stage> --yes --wait 300
tarobot update rollback --yes
```

Staging can run while the host is serving clients. Applying and rollback wait for
task completion before stopping; the offline checks still run after that wait.
Applying an already selected revision is rejected during preflight, including
`--dry-run`, before draining or stopping the host. The locked activation retains
the same check to catch a concurrent selection change.

If selection fails, recovery verifies that the frozen runtime pointer and digest
are unchanged. A previously running, identified host can be restarted; a host
that was offline stays offline. For an offline host whose managed service was
already enabled, recovery restores its login-autostart setting without starting
it. Unknown or changed selections are left for explicit operator recovery, and
an enable failure is reported instead of claiming that autostart was restored.

## Package contract

The input is an explicitly selected, trusted local standalone package directory,
with its production dependencies already installed for the target OS, CPU and
Node runtime. Staging does not download a URL, install dependencies, run npm
lifecycle scripts, or publish to a registry. Staging runs the selected package's
`--help` and an in-memory SQLite dependency check with bounded output and time.
This is executable software, not a sandbox for examining untrusted packages.

The package must contain its standalone compilation graph, every compiled graph
module, the relay bundle, built client assets, `npm-shrinkwrap.json`, and installed
dependencies. `package.json` explicitly declares database compatibility:

```json
"tarobotHostUpdate": {
  "format": 1,
  "minHubSchema": 1,
  "maxHubSchema": 19
}
```

This example matches CLI 0.1.442 (schema 19). Older packages can have lower
schema ceilings (0.1.431: 17; 0.1.430: 16). Inspect the actual package receipt, not just its version
string. Do not edit a receipt to make an incompatible binary appear compatible.

These values describe schema versions the executable can open. They must change
with database compatibility changes; a higher application version does not prove
that its predecessor can open migrated data. An old package without this receipt
cannot be used as an automatic rollback target.

The unreleased group-discussion change raises the source contract to schema 20;
the historical example above is not its release manifest. Publish App and CLI
from the same revision and preserve the no-downgrade check.

## State and interruption handling

Staged packages live beside the state directory in `<state-directory>.runtime`,
under a version and content-hash directory. The current Node executable is copied
alongside each package, hashed and recorded with its OS and CPU architecture;
the SQLite probe runs under that exact copied executable. Selecting a revision
selects both Node and the package entrypoint, and the launcher must dispatch both
together. This avoids mixing an updated package with a replaced App-bundled Node.
Updating Node itself requires explicitly preparing a compatible Node installation
and staging from that runtime. Staging checks Node's loader dependencies: macOS only accepts
system libraries, Linux inspects ELF dependencies, and Windows inspects PE imports.
Nodes linked to Homebrew libraries, external OpenSSL/ICU or a distribution's
`libnode` are rejected; use the App's bundled Node or an official Node build.
Every launch verifies the frozen Node, entrypoint, native `.node` modules and
Windows supervisor helper. Health identity uses the full runtime tree hash, so
two builds carrying the same version string cannot be confused. Runtime files
and metadata are private
to the OS user. Staging copies selected runtime members, bounds the package size,
rejects links escaping the package, and checks all copied bytes again after the
probe. Applying rechecks the staged file inventory before changing the pointer.
The original package and application bundle are never overwritten.

The CLI is responsible for asking the running Hub to drain and for stopping its
OS supervisor before activation. A timeout must leave the old service in control;
it is not permission to interrupt a task. Activation additionally acquires the
Hub lock and every retained Bot's lock, rejects a running or unresponsive host,
rejects incomplete restores and unfinished Bot output, and checks database
compatibility using a read-only connection. Unstarted user deliveries remain
queued for the selected runtime.

Drain first pauses new Hub message dispatch and future cron triggers. Existing
messages, approvals, questions, queued worker turns and Bus continuations can
finish. An idle peer stays alive while another Bot may still delegate to it;
workers exit only after the fleet is idle and the Hub commits that drain.
Drain IDs prevent one CLI wait from cancelling another CLI's operation. A timed
out or cancelled wait restores only the admission pause it initiated, and never
kills a task. Already-persisted but undispatched messages stay queued.
The Hub grants a 30-second drain lease, renewed by the owning CLI every 5 seconds.
If the CLI is killed or its SSH session disappears, the server expires that lease,
resumes admission, restarts drained workers and delivers queued messages. Renewal
requires the matching drain ID and cannot resurrect an expired lease.
Before any OS termination, the manager disables persisted automatic-start intent
and asks the Hub to commit a `drained-stop` for the exact drain ID, process ID and
host public key. The Hub checks its live lease and idle barrier atomically, then
enters terminal shutdown. A lost lease is a refusal, never permission to stop a
newly busy or replacement process. Terminal shutdown cannot be cancelled by a
lease timeout while background maintenance finishes. Each cleanup phase is
attempted even if an earlier flush failed; the instance lock is released only
after workers, listeners and SQLite are confirmed closed.

Before stopping, `--dry-run` reports the selected runtime, estimated recovery
size/free space and unfinished message IDs. Ordinary active tasks may finish
during drain; unresolved Bot output is rejected again after stopping, with Bot,
conversation and message IDs. Capacity and ownership are also checked again
under the offline locks.

While those locks are held, activation makes an offline recovery copy of host
identity, network membership, Bot configuration, sessions, SQLite database/WAL
files and attachments outside workspaces. **Bot workspaces are excluded in their
entirety and remain unchanged in place**; large projects and `node_modules` are
not traversed or duplicated during an update. Use a separate full backup when
you need workspace protection. Other state symlinks, including DeepSeek's
`dsh-home` profile/credential links, are preserved without following external
targets. Logs, process locks, sockets, FIFOs, device nodes and old backups are
excluded. The `tarobot-update-recovery` manifest is now version 2 with explicit
`scope: host-state-without-workspaces` and `skipped` records. Existing version 1
snapshots retain their original scope. Neither format is input to `hub restore`
or automatically restored. External engine credentials/session stores are not
part of this copy.

An atomic pointer selects the new executable; a transaction records the old and
new paths, pre-update schema and recovery location. Interrupted preparations are
visible in update status. A selected runtime is reported as selected until the
caller verifies the actual runtime tree hash and the same host public key, then records
the healthy acknowledgement. The launcher follows the pointer using the original
state directory. Failure to start must not cause silent data restoration or
automatic task resubmission.

A damaged current runtime does not prevent selecting a verified healthy revision
or rolling back to a compatible frozen revision. The transaction preserves the
old pointer plus `beforeError` for diagnosis. `update status` reports damaged
revisions and transaction records individually, alongside healthy revisions,
instead of failing the entire inventory. The replacement itself is always fully
verified before changing the pointer.

Rollback only targets a previous **frozen revision** and performs the same
stopped-host and backup checks. The first transition from an App or source tree
has no frozen previous revision; an external path may already have been replaced
by an App update, even when its version string is unchanged. Such rollback is
refused with `host_update_previous_runtime_not_frozen`. Keep the old installer;
to establish a rollback baseline, stage and select its compatible standalone
package before staging the next version. Later managed upgrades preserve both
the old Node and package together and can use the normal rollback command.
If the previous
executable cannot open the current schema, it fails without changing the pointer
or database. Restoring older state would discard work after that backup and must
remain a separate, explicit recovery operation.

Runtime capabilities are checked before stopping as well as under the activation
locks. A service with saved custom engine homes/proxies requires
`tarobotHostCapabilities: ["service-extra-environment-v1"]` in the target package.
Rolling that service back to 0.1.420 is refused before downtime: the old manager
cannot render or preserve those additional settings. They are never silently
discarded to make a rollback appear successful. Services without extra settings
retain normal compatible rollback to 0.1.420.

For an installed Windows service, both apply and rollback also validate the
target package's x64 GUI host launcher before stopping, and again under the
activation locks. A missing or invalid launcher leaves the running service and
selected runtime unchanged; use a complete standalone package for the target.

For manual recovery after a schema migration: inspect `tarobot update status`
and identify the exact transaction, original state directory and recovery copy.
Stop the OS supervisor and all host workers, preserve the current state directory
as a separate backup, and verify every file against the recovery manifest before
restoring anything. Restore the recorded recovery members to the **same original
paths**, preserving private permissions and symlinks; **do not replace the whole
state directory with a version 2 snapshot**, because its excluded workspaces
must stay in place. SQLite database/WAL files must remain one consistent set
(do not mix a restored database with newer WAL/SHM sidecars). Select a runtime declared
compatible with that restored schema, then verify the original host identity and
its peers before resuming work. Never start the preserved state copy as another
host: it contains the same identity. This recovery can discard messages, files,
pairings and network changes made after the backup, so it is not an automatic
fallback for a failed launch. The ordinary `tarobot restore` command accepts the
separate `tarobot backup` format, **not** this update recovery format.

## Explicit retention cleanup

Nothing is pruned automatically. Inspect an exact obsolete transaction or revision:

```sh
tarobot update prune --receipt <transaction-id>
tarobot update prune --revision <revision-id>
# Repeat the reviewed command with --yes to delete those exact paths.
```

The default is a preview. Current/previous revisions, the current transaction,
one additional usable recovery point and all revisions referenced by retained
receipts are protected. Prune obsolete receipts before their referenced versions.
Live host state and workspaces are never cleanup targets.

## Verification

`tests/host-cli-update.test.ts` uses disposable host identities, package fixtures
and actual subprocess probes. It covers preserved identity/network/workspaces,
no migration during backup, live host and retained-worker exclusion, unfinished
run rejection, queued delivery preservation, schema downgrade refusal, changed
files and compatibility metadata, unsafe links, and interrupted transactions.
These fixtures do not claim that a production host was updated or that real
phone/network delivery was exercised.
