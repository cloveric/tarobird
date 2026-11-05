# Claude scoped process records

Subagent and background steps retain their explicit `id`, kind, label, parent
scope and parent tool-call ID. The process reader keeps the original event
sequence rather than constructing a speculative parallel task tree. Scope
metadata remains attached when searching, paging, copying a step or exporting
JSON. Collapsed steps show the scope kind and label; their expanded detail holds
the scope and parent IDs. Only the public events supplied by the CLI are recorded.

Background reports use `card.extra.scopedRun`. New clients display their process
details without a conversation-level stop button. Their message envelope stays
`complete` while their separate run phase tracks progress, so neither new nor
old clients activate the conversation composer, queue hint or stop button.
Notifications inspect both summary kinds and wait for the actual terminal phase.
An isolated foreground child without background-task metadata is labeled as a
subagent process. Older clients display the existing readable card. Foreground status and stop behavior remain unchanged;
failed-action counts appear inside details, not on the reply card.

## Protocol and rollback

| Combination | Behavior |
| --- | --- |
| New worker and new Hub | `runs.scopes.v1` enables `run.scope.write`; `run.write` still accepts only strict v1 entries. |
| New worker and old Hub | Scoped entries are omitted from writes; the primary journal and final answer continue. Live standalone process cards are skipped; the existing final report fallback remains. |
| Old client and new Hub | Requests without `scopes=1` read the original primary journal only. Background reports remain static cards. |
| New client and old Hub | Existing primary details and replies remain readable. Previously stored scoped cards show an unconfirmed last state without a spinner or stop control. |
| Hub rollback | The old Hub ignores `run_journal_scoped`; original `run_journal` payloads contain no scope fields that would fail its strict parser. A new worker retires unsupported scoped outbox RPCs before replay so they cannot disconnect an old Hub. |

The new table is created in the normal transactional Hub initialization. This is
an additive extension to schema 15, with no change to existing tables or the
schema-version gate. Each row stores a strict v1 payload and a separate
`scope_json` column. The two journals share the existing 2000-entry/8 MiB limit,
message ownership checks, recall cleanup and 30-day retention. Database backups
include both tables. Replies and terminal summaries survive detail expiration.
An old Hub cannot delete optional table rows itself. Its deleted-message
tombstones still deny access; the next scopes-aware startup or maintenance pass
removes those rows. Schema-15 upgrade tests remove the optional table, reopen
through normal initialization, and verify legacy writing, the composite primary
key and expiry index.

The two Gateway writers have separate failure and retry state. A rejected scoped
RPC cannot block the primary writer, and final reply publication does not await
the optional scoped flush. Both writers register pending batches before the
transport drains on shutdown. Terminal cards carry a separate
`extra.scopedJournal` synchronization marker; it never extends the strict v1
summary. A pending marker has a neutral syncing notice. When the queue settles,
one metadata-only update clears the marker on the same terminal run revision;
a confirmed failure also sets `detailsUnavailable`. This preserves the current
body and status and never manufactures another reply. Slow success is not failure.
Callbacks for a different run, a newer revision or an active run are ignored.

An open detail panel polls for at most 10 seconds after a recent terminal event.
A completion acknowledgement triggers a final read even when persistence took
longer than that window. A stalled queue retains the syncing notice, and manual
refresh remains available. Opening historical terminal details performs one read
without starting another polling burst. Export captures available entries with
capture timestamps and a `detailsPending` flag, preserving structured scope fields.

Restart recovery recognizes both summary keys and preserves `scopedRun` so a
recovered background report never gains the older conversation stop control.
Forwarding removes both summary kinds and synchronization metadata and keeps
the readable snapshot. `nativeRun()` retains foreground-only semantics;
`anyRun()` is an explicit opt-in for rendering, journal reads, recovery and
notification classification. Session control must not use it.

## CLI and validation

The headless CLI runs the same Hub, Gateway, storage, authorization and recovery
code as the desktop host; no desktop window is required to collect scoped
records. This adds no separate host-management operation or CLI command.
The CLI update/recovery preflight also checks active scoped phases even though
background message envelopes are complete. The event badges, process reader
and JSON export are client presentation.

Focused coverage lives in `tests/run-scopes.test.ts` and browser
`client/e2e/run-scopes.spec.ts`, alongside existing run recovery, writing,
Hub authorization/backup, forwarding and detail-refresh suites. Browser tests
cover desktop and phone layouts, attribution, search, paging, structured export,
read-only background cards and bounded terminal catch-up. These are synthetic
protocol/UI checks; they do not establish a live Claude CLI or native-device
acceptance result.

## Adapter ownership and capture boundaries

The adapter captures the original callback and turn when a delegated/background
call starts. A delayed native `task_started` cannot bind it to a newer prompt.
Child call IDs and background ownership use their explicit parent context;
ambiguous or unknown owners never acquire the current conversation's permissions.
A recovered background report can still be shown as unattributed, but no missing
process is invented. Only CLI-forwarded public events are read, never private
session files or hidden reasoning.

A detached nested Agent owns a separate presentation root while keeping its
parent reference. Ending its foreground parent does not finish that background
subtree. Repeated monitor reviews receive new scopes; silent reports and engine
errors still settle any existing process card. Child control requests cannot
call the parent's host tools. Background execution and later review have separate
stage records; each review updates its own final report in place.

Scoped capture reserves the main run's budget: at most 500 scoped entries and
one quarter of the run capture budget, with 200 entries/512 KiB per scope.
Captured tool receipts can still close after the limit, with truncation marked.
The adapter limits concurrent scopes to 128 and nesting depth to eight; partial
stream reconciliation keeps at most 64 blocks and 64 KiB of text per scope.
The live presentation retains at most 32 scope roots, reclaiming only terminal
roots. When all are live, an additional standalone process card is omitted;
existing roots and the final reply/file fallback continue. Attached overflow
still reaches the original foreground journal, and closed attached seeds are
released immediately. Durable published details use the normal 30-day retention.
Overflow never substitutes a different owner. Shutdown waits at most two seconds
for process/notification callbacks and does not treat that timeout as delivery.

The existing delivery ledger remains at-least-once: recovery after a partial
delivery can repeat text with the recovery notice. This change preserves that
contract; it does not claim transactional exactly-once file/text delivery.

An isolated native probe on 2026-10-15 used Claude Code 2.1.296 with
`claude-opus-5-5`, effort `xhigh`, and a temporary read-only arithmetic fixture.
The actual forwarded child frames contained public thinking, tool starts,
tool results and text. This verifies event availability in that installed CLI;
it is not an installed-App or physical-phone acceptance result.

Two subsequent isolated probes exercised the actual adapter with Claude Code
2.1.296, Opus 5.5 and effort `xhigh`: foreground and background executions both
produced the expected final arithmetic answer. The background report retained
its original owner and two scopes; both probes recorded a child tool start,
a tool receipt, and exactly one parent result. The earlier raw-frame probe also contained public thinking events.
These native CLI/adapter smoke tests are separate from synthetic protocol and
browser coverage; none establishes installed-App or physical-phone acceptance.

The implementation received an actual Opus 5.5 `xhigh` design review and an
independent static audit, followed by fixes and a separate regression review.
Regression scenarios include late/missing task identity, child permission
isolation, synchronous nested delegates inside background work, monitor review
reuse, multi-block stream/full reconciliation, failed reviews versus recovered
tool failures, old-Hub fallback, delayed journal acknowledgement and bounded
shutdown. Synthetic fixtures and native CLI probes do not replace native-phone
or installed-desktop acceptance.

Final local validation: standalone host and client production builds passed;
`tsconfig.app.json` type-check passed; 278 test files passed with 3685 tests
passing and one pre-existing skip. Chrome passed 13 scoped/detail-refresh cases
and 10 desktop/phone cases across Codex, Claude, Antigravity, Kimi and DeepSeek.
The local WebKit process stalled while creating a page, so its suite was not
completed. Installers were not rebuilt and physical devices were not accepted.
