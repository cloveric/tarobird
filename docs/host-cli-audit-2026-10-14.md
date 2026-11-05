# Independent CLI audit — 2026-10-14

Scope: the headless host CLI, service ownership, start/stop, pairing, private-network
routes, backup, runtime update/rollback and packaging. The starting revision was
`adc4ab1722953a723ca94b9e57f15f412e4bd9bb` (CLI 0.1.420).

Two independent code reviews were performed: Codex and an actual local Claude
`claude-opus-5-5[1m]` session with `--effort xhigh`, read-only tools and no external
MCP servers. The first Opus report was produced before sharing Codex's findings.
A second Opus pass reviewed the resulting fixes. Model review is supporting
evidence; the tests and isolated lifecycle checks below are separate evidence.

The second pass found an orphan-registration cleanup regression, Windows
pre-stop failure intent handling, old-runtime extra-environment incompatibility,
invalid-environment diagnostics, an online directory-removal race and misleading
failure text. These were corrected with further regression tests. Explicit
Windows force termination is scoped to a confirmed owned task. The suggestion
to send an unguarded stop to an older Windows foreground child was not adopted:
a separate PID observation cannot bind that later command to the same Hub.
That older runtime reports unconfirmed shutdown rather than risking another
process; upgrade it for target-bound control support.

## Confirmed findings and changes

| Area | Trigger and previous behavior | Correction |
| --- | --- | --- |
| Service installation ownership | A new foreground host could acquire the directory after a PID check but before OS service registration. A previous-boot PID could also be mistaken for live ownership. | Hold the real epoch-aware Hub instance lock through registration; preserve a genuinely live owner. |
| Foreground interrupt | SIGINT sent to only the POSIX wrapper left its child Hub running. | Stop the exact child through PID/public-key-bound control, wait for actual exit, and gracefully support older POSIX children. Never send an unguarded stop to a replacement Hub. |
| Windows safe shutdown | An old helper saw the desktop flag change and issued ordinary stop before the drain guard, then could terminate its Job. | Disarm the service and task trigger first; keep the legacy flag until the guarded Hub exits. New helper flags control startup/restart only. No ordinary stop during guarded wait. |
| Update recovery size | Large workspaces or node_modules could exceed inventory limits or fill the disk during downtime. | Recovery v2 excludes whole workspaces, records its scope, previews size/free space and checks again offline. Workspaces stay in place. Full backup remains separate. |
| Retention | Frozen versions and recovery copies accumulated with no operator cleanup. | Explicit `update prune` defaults to preview and protects selected/previous versions, required recovery points and receipt references. |
| Schema and runtime | A newer unfrozen CLI could migrate state during maintenance, or stop a host before discovering the selected runtime cannot open it. | Read-only target compatibility checks before restart/reconfiguration; migrations go through explicit update selection. Legacy maintenance requires an existing, explicitly selected state directory. |
| Backup | Opening HubStore for backup could migrate the source DB and append an audit row. | Read-only SQLite export preserves the source schema and main DB bytes; the backup manifest is the completion receipt. SQLite may create its own WAL/SHM sidecars. |
| Service environment | Background Codex/Claude/Kimi/DeepSeek lost custom homes or proxy settings that worked in a terminal. | Preserve an explicit private whitelist, compatible with old service manifests; doctor reports differing names without credential values. Antigravity retains the shared executable/PATH handling. |
| Update preflight | A Finder metadata file in `bots/` could be treated as a Bot lock; unfinished output produced an opaque failure. | Skip non-Bot entries, expose unfinished Bot/message/conversation IDs, and allow active work to finish before the offline check. |
| Uninstall and recovery UX | Uninstall could stop an ordinary foreground Hub without an installed service; enrollment failure disguised a successful startup; missing reset identity produced ENOENT. | Bound uninstall to installed ownership, report host/controller readiness separately, and give the enrollment recovery instruction. Preserve login-start intent after an offline update. |
| Network pairing | Pairing over another interface silently replaced a configured shared direct route. | Preserve the existing shared route; replacing it uses the explicit signed network-routes operation. Host/Bot and independent phone membership rules are unchanged. |
| Runtime and paths | Inspector Node could reject a valid frozen Node/package pair; aliases could redispatch; relative Bot workspace paths depended on service cwd. | Check Node at staging, compare physical runtime files, resolve workspace paths before submitting to the Hub. Service receipts have their own version rather than the global state schema. |

The CLI supports the same Codex, Claude, Antigravity, Kimi and DeepSeek adapters;
this audit did not add provider capabilities or replace the shared engine/core.
No Telegram/Lark fleet, production host identity or real phone pairing was changed.

## Evidence and release boundary

Verification: the complete pre-complete gate passed **259 test files, 3,388
checks, with 1 skipped check**. The Windows helper passed 5 Rust
tests and cross-linked successfully. Clean, extracted-archive and global installs
outside the checkout each started the Hub and served the packaged client without
the Feishu SDK. Diagnostics were also exercised with an invalid configuration
home, preserving readable output without exposing its value.

An isolated real macOS launchd host passed 0.1.420 → 0.1.421 → rollback →
reapply with identical host public key, network ID and workspace bytes. A stopped
but login-enabled service retained that intent without starting after update.
An incompatible legacy rollback with a saved custom engine home was refused
while the same Hub PID remained running. Uninstall without a service left an
ordinary host running. A SIGINT sent only to the foreground wrapper stopped both
wrapper and Hub. Test services were uninstalled and their hosts stopped.

The final CLI archive is `tarobot-0.1.421.tgz` (24,531,718 bytes):
`6ca2bd81b68ae18f222c3e5200294d205ce61d6678a4d435479ab3e12933b3d5`.
The bundled Windows helper SHA-256 is
`1750f5aabb2ac6fd6fca53eaa690cffdebe1fc4c7a440128283e96b04bf990bb`.

The patch uses protocol 2, supports Hub schemas 1–14 and writes schema 14.
App source remains 1.0.68; this CLI patch does not claim new desktop/mobile
installers were built or installed. Windows compilation and service doubles are
not Windows native acceptance. Linux service doubles are not a systemd login
session test. Physical-phone notification/network delivery is outside this audit.

See [CLI operations](host-cli.md) and [update/recovery contract](host-cli-update.md)
for the commands and the explicit limits of recovery snapshots.
