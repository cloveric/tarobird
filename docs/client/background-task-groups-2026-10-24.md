# Compact background subagent groups

The App renders background subagent records from one originating controller as
one compact card. Each row retains its own message ID, scoped run and public
journal. This is a presentation projection, not a new aggregate message or a
second execution-state store. Only the Gateway/App presentation path changes.

## Ownership and compatibility

The controller creates a random group ID once per parent turn. A new controller
gets a new ID even when it replies to the same source message. Only bound,
background `subagent` scopes carry grouping metadata. Background review scopes
and their final user-facing summaries remain separate messages. Scope ownership,
origin/provenance checks, per-worker capacity and per-scope byte limits remain
in the existing presenter. Group rows and the dock acquire no active-run or Stop
handles.

The optional `card.extra.backgroundTaskGroup` metadata is bound to the existing
read-only `scopedRun` ID:

```json
{
  "version": 1,
  "groupId": "opaque-parent-controller-id",
  "scopeId": "opaque-child-scope-id",
  "runId": "this-card-scoped-run-id"
}
```

The Gateway strips its internal producer field regardless of capabilities, and
adds public grouping metadata only after the Hub negotiates `runs.scope-groups.v1`
(alongside the existing run and scoped-journal capabilities).
Older clients ignore the optional metadata and render the original cards. A new
App connected to an explicitly unsupported Hub also uses the original cards.
Old history without metadata is not heuristically regrouped. While offline,
valid persisted metadata can reconstruct the last known grouped state.
Unknown/malformed metadata, foreign run IDs, forwarded records, ambiguous
scope duplicates and mixed-content messages retain the complete legacy view.

Forwarding strips grouping metadata. Orphan-run recovery preserves validated
metadata from the original scoped record while marking its real interrupted
state; it does not turn a background card into a foreground run. Each member's
existing journal route, authenticated visibility and retention remain unchanged.

## App behavior

- The earliest surviving member anchors a group in the conversation. Search,
  references and notification jumps to any member map to that anchor. Virtual
  rows and open readers retain group ownership, including when the anchor shifts.
- A row shows description, phase, elapsed time and public step count. Truncated
  evidence shows a `+` on the count; no extra steps are inferred. Long names stay
  accessible through the row's accessible name and process reader.
- All terminal states collapse the card to a receipt. Success, failure,
  interruption and uncertainty are distinct. Clicking it reopens the rows; a
  later active member expands the group again. More than five rows use a
  bounded initial view and a “more” control. The initial five rows prioritize
  active tasks; expanding reveals every member in its original order.
- Row selection opens the existing process reader. Its full-report view remains
  available. An open reader survives automatic collapse and virtual scrolling;
  focus returns to the group heading if the original row is now hidden. A
  per-timeline, same-commit reader handoff also preserves an open reader if its
  member becomes a standalone report. The handoff expires on genuine unmount;
  changing chats does not restore an old modal.
- The dock derives solely from read-only group records. It appears only for an
  unfinished group whose card is outside the actual conversation scrollport,
  including a virtualized/unmounted card. Overscan does not count as visibility.
  With multiple offscreen active groups it targets the oldest and indicates how
  many others remain; its counts refer to the target group.
- Offline/stale connection state is not success. The UI freezes elapsed time at
  recorded evidence and labels the status unconfirmed.
- The existing task-management dialog remains accessible in chat actions and
  `/tasks`. The [unified task bar](task-bar-unification-2026-10-24.md) composes its
  management button beside the read-only dock. The dock explicitly counts its
  own group; native task handles are not joined to historical scope IDs. Native
  controls remain in their original dialog, and stop-impact/recovery notices
  remain visible. Cards and the dock do not acquire task-control handles.
- Multi-select message deletion temporarily shows original records, so deleting
  a displayed group cannot silently delete its unseen members. Pointer/keyboard
  context menus on a group cannot act on just its first member.

The visuals use existing surface, border, text, accent and error tokens. There
are no new animations. Desktop uses the same dock because the current side
conversation panel is not a background-task sidebar.

## Entry points and validation

The headless Host shares this producer and Hub metadata. This change is display
only: existing message/journal commands continue to expose original records, so
no separate CLI operation is needed.

Unit coverage includes grouping and separate turns, terminal counts, schema and
run binding failures, fallback, reconstructed snapshots, forwarding and recovery.
Browser acceptance uses the actual App, isolated Hub and Gateway with injected
public engine events at 390 and 1360 widths in light/dark themes. It covers row
process access, dock visibility and navigation, collapse while a reader is open,
reload, more rows, a later round, failure and interruption. These screenshots
are browser renders, not physical phone/keyboard acceptance.

Evidence and independent Opus 5.5 xhigh reviews are recorded under
`/Volumes/gdrive/taro-tmp/background-task-groups-20261024/`.

Per-member push notification delivery remains unchanged. A future notification
aggregation policy is separate from this presentation change. The existing
32-live-root and per-scope journal limits also remain unchanged; the UI does not
claim to enumerate scopes that the existing protective limits did not publish.

## Files changed

- Shared metadata/publication/recovery: `src/client-protocol/background-task-group.ts`,
  `src/client-protocol/index.ts`, `src/client-protocol/forwarding.ts`,
  `src/core/scoped-run-presentation.ts`, `src/gateway/channel.ts`,
  `src/hub/server.ts`, `src/hub/store.ts`.
- App projection, reader and navigation: `client/src/background-task-groups.ts`,
  `client/src/BackgroundTaskGroup.tsx`, `client/src/background-task-groups.css`,
  `client/src/App.tsx`, `client/src/RunPresentation.tsx`,
  `client/src/run-reader-state.ts`, `client/src/MessageContextMenu.tsx`,
  `client/src/connection.ts`, `client/src/locales/en.json`.
- Regression coverage: `tests/background-task-group.test.ts`,
  `tests/client-background-task-groups.test.ts`,
  `client/e2e/background-task-groups.spec.ts`,
  `client/e2e/background-task-groups-edges.spec.ts`,
  `client/playwright.webkit.config.ts` and the existing
  `client/e2e/fixtures/run-details-refresh.tsx` connection stub (missing
  `stopReceipt` method).
- Documentation: this page, `docs/state-model.md`, `docs/entrypoint-map.md`.

## Audit corrections

Independent Opus UI probes reproduced group context menus acting on one member,
reader unmount during a member-to-standalone transition, hidden unrelated shell
status, asymmetric anchor navigation, stale offline wording, and active members
hidden beyond the preview limit. These were repaired and the probes converted to
regressions. Archived conversations no longer offer an unmounted task dialog.
The final implementation preserves the original task-management trigger entirely.

The proposed claim that every normal Claude completion removes its member from
the group was separately checked and rejected: normal completion closes the
subagent with `scope_status`, while the user-facing report uses a distinct
`background` review scope. The defensive same-ID standalone fallback remains,
with its reader preserved. The backend review also mutation-tested metadata
stripping, report exclusion, forwarding and orphan recovery.

## Validation result

- `scripts/pre-complete-hook.sh`: passed. All 474 Vitest files passed;
  6,454 tests passed and 5 existing guarded tests were skipped. Host build,
  client typecheck/translations/build and 77 native desktop tests passed.
- Final Chromium: 17 group/reader cases; final WebKit: 11 group cases;
  existing menu/deletion/task-control regression: 11 cases. All 39 passed.
  A final phone group ARIA correction was followed by another successful client
  build and all four width/theme journeys (no visual changes).
  Earlier related scoped-run/background/task/message-action coverage also passed
  (47 cases), before the final edge corrections.
- The first full run hit one unmodified file-mutex concurrency test with an
  intermittent filesystem ENOENT. Its complete 29-case file passed separately,
  then the complete pre-completion gate passed on rerun. No mutex behavior was
  changed for this presentation task.
- Twelve screenshots cover 390px phone / 1360px desktop × light/dark × running,
  collapsed completion, offscreen dock. Delivery to the request conversation was
  confirmed. Browser acceptance does not establish native-device acceptance.
- No release, installed-App update, production-host restart or real user task
  interruption was performed.

The final independent Opus review found no blocking issue in the corrected
implementation. Its optional search-state observation was also addressed: the
new task-list menu entries are hidden while in-chat search unmounts that dialog.
The task manager's existing `/tasks` open-request lifecycle was not rewritten.
The initial release kept both triggers. The subsequent
[task-bar unification](task-bar-unification-2026-10-24.md) merges their container
without merging their counts or identities. A future combined total or per-card
native controls would still require a negotiated, reliable identity relation.

After the search-menu guard, the client build and all eight group/search browser
cases passed. This was the final source change.
