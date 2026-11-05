# Unified background task entry

The composer previously rendered both the new per-group dock and the older
native-task trigger as separate rows. They could show similar numbers while
counting different work. This follow-up puts the existing locator and task
manager into one compact row, retaining the original A+C grouped-card design.

## Presentation and boundaries

- An offscreen active group's dock keeps its existing count, public status and
  locator action, with a visible "本组" prefix. The adjacent more button opens
  the existing all-native-tasks dialog. Its accessible name is unchanged.
- If active group cards are visible, no group status is repeated. The native
  manager becomes a compact entry. A static activity dot and a distinct count
  of top-level background shell commands preserve native work awareness.
- With no active group, the original native-task count/entry remains. Completed
  groups therefore cannot hide unrelated running agents or shell commands.
- The native count is also available in the manager's title and accessible
  description. Group/native counts are never summed, compared, or joined by
  task name, timestamps, position or count. Same-name tasks stay separate.
- The underlying native manager and its keyed trigger stay mounted while the
  dock appears, disappears or completes. Polling, explicit stop receipts,
  recovery fencing, dialog state and focus restoration retain their ownership.
- Unconfirmed-stop recovery and offline/stale native status stay written out.
  The native foreground-stop impact notice remains a separate full-width row.
  Each source retains its own uncertainty; a native receipt cannot finish a
  saved group, and a saved group cannot issue a native stop.
- Unsupported native APIs and multi-Bot conversations keep the read-only dock
  alone. Existing chat actions and `/tasks` still open task management.

There is no change to grouped-card rendering, automatic completion collapse,
per-task public readers, per-round grouping, scope/provenance checks, metadata,
message persistence, execution, queue order or engine protocols. The recent
single-scrollport native task-dialog repair remains intact. The default view
still limits large groups to five rows; final summaries remain separate.

The existing strict native-task schema is unchanged. A future cross-source
combined total or per-card stop control would require capability-negotiated
identity linkage. This patch deliberately supplies neither. It also does not
add a new Codex native task-control adapter.

## CLI and validation

Presentation only: existing `tarobot tasks list/stop/recover` routes and receipts
are unchanged; no new CLI command or release is needed for the source change.

Independent design and implementation/visual reviews use actual
`claude-opus-5-5` with CLI `--effort high`, isolated from production Bot settings.
Evidence is under `/Volumes/gdrive/taro-tmp/unified-task-bar-20261024/`.

Validation covers the new combined row at 390/1360 widths in light/dark themes,
real App group projection with all native tasks retained (including identical
names), exact selected stop handles, visible/offscreen placement, automatic
collapse with an open public reader, unsupported fallback, and recovery during
visibility/terminal transitions. Existing group edge, task-control, phone touch
scrolling, navigation, Claude input and queued-prompt suites are retained.

Screenshots use isolated test Hubs and injected engine events. They establish
browser behavior, not physical Android/iPhone acceptance or a production update.
No production host restart, user task interruption, release or installed-App
update is part of this change.

## Review dispositions

The independent review confirmed the composition/control boundaries and found
invalid initial dark-theme test setup. Tests now emulate the OS color scheme
and assert the resolved canvas color (the saved preference remains system).
The final screenshots replace the incorrectly named initial images.

Additional review corrections preserve both recovery and uncertainty wording,
restore the standalone native trigger unchanged, keep the dock node stable
when native tasks appear/disappear, and use a count-neutral English command
label. Tests exercise both trigger and dock DOM identity across transitions.

A saved group with a missing terminal event can still appear active; this
existing state is not overwritten from an unrelated native snapshot. The
complete native list remains available through the same management entry.
Repairing lifecycle evidence or introducing a cross-source combined count
requires a separate protocol change and is not implied by this visual fix.

## Verification receipts

- Targeted unit/API tests: 5 files, 63 passed, including group projection,
  scoped presentation and the existing gateway/CLI task-control contract.
- Browser coverage: 50 distinct Chromium cases and 32 WebKit cases, including
  the existing Claude input and durable prompt queue checks on Chromium.
  The final focused runs exercise the unified bar and the retained A+C design.
- Host build and client type/translation/production build passed. The existing
  Capacitor keyboard static/dynamic import warning remains non-blocking.
- Independent Opus 5.5 high design review, implementation/screenshot review and
  final closure review completed. Final review found no remaining blocker.
- Initial test-fixture corrections: same-name task assertions now account for
  the existing running-first ordering; dark mode is checked from actual paint;
  history-reading tests use real Home input before manipulating that viewport;
  the dock-identity test keeps normal tail-follow and inspects DOM identity
  under an inert modal rather than relying on its accessibility-tree presence.
  The corrected cases passed; these did not change production lifecycle logic.

This scoped UI follow-up did not rerun the full repository/native suite.
