# Automatic database backup retention

Settings → Data & backups and `tarobot backups status/configure` now manage one
owner-scoped host policy. The default is one UTC calendar day, including existing
hosts without an explicit policy. Owners can choose 0–3650 days. Zero disables
new automatic snapshots and clears existing owned automatic snapshots.

These snapshots contain the Hub database: chats, device authorizations, Bot
records, network state and other database tables. They do not contain attachment
blobs, Bot workspaces, engine sign-ins or the host's identity key file. Full
backups remain a separate operation. The retention setting neither deletes live
chats nor touches manual backups, legacy exports, symlinks or upgrade recovery
copies. Future-dated automatic snapshots survive ordinary retention to tolerate
clock rollback; explicit zero clears all valid named automatic files.

The maintenance loop checks the policy revision each minute, so a same-day
change takes effect without restarting the host. New snapshots are published
and checked before expired snapshots are removed, except when explicitly
disabled. Settings writes and automatic pruning share a lock. Writes validate
owner authorization again after lock acquisition and use revisions plus bounded
idempotency receipts. An unreadable policy stops backup pruning rather than
falling back to a destructive default. No database schema migration is needed.

The App shows the host scope, current snapshot count, storage size and latest
date. Unsaved input is preserved while navigating settings; closing asks about
the draft. Offline, member, old-host, invalid-input, conflicting-save and uncertain
save states have explicit recovery. A failed read-back never causes an automatic
second write. The CLI uses the same authenticated endpoints and reports receipts.
This host database feature is independent of Codex, Claude, Kimi, DeepSeek and
Antigravity engine capabilities.

Validation:

- 70 focused backup, maintenance, full-restore and CLI-entry tests passed.
- The complete engineering suite passed 6,176 tests in 453 files, with 5 existing
  skips. Host and client builds passed. The first native gate needed the ignored
  bundled-host resource in this new worktree; after preparing that resource,
  the native gate resumed and all 77 native tests passed.
- Four new settings browser tests passed in Chromium and WebKit, including
  1360/390 px layouts, Chinese/English, light/dark themes, reload, numeric input,
  unsaved drafts, concurrent changes, lost responses and owner restrictions.
  Both existing settings-lifecycle tests passed in Chromium. Final button styling
  and storage display were rechecked in both WebKit widths and visually inspected.
- A real isolated Hub process created its daily snapshot and pruned an expired
  one with the new default. Changing the policy to zero through the CLI took
  effect in the next maintenance cycle (about 60 seconds), without a restart.
  Its synthetic chat and manual backup remained intact. No production data was
  modified by this probe.

Local package mapping: App 1.0.102, Host/CLI 0.1.449, protocol 1, supported Hub
schemas 1–21. Source checks, package validation, local activation and installed
native UI acceptance have separate receipts; this document does not assert a
public release or completed native installation.
