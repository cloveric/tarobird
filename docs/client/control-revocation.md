# Authorization after management-operation waits

This extends the [HTTP](http-revocation.md) and
[realtime](socket-revocation.md) revocation work. Initial authentication and a
401 response alone do not prove that a delayed side effect was prevented.

Nine real-HTTP regressions first reproduced late effects in Bot creation,
file-label editing, Finder dispatch, Google Docs export and managed restart.
The checks assert database/file contents and operation calls, not only status
codes. All workers, files and identities use isolated fixtures; the tests do not
create paid model sessions, open Finder or call Google services.

## Execution boundaries

| Operation | Final admission check | What remains after admission |
| --- | --- | --- |
| New Bot | Session/owner in the registration transaction, after the manager queue, engine discovery and file preparation | Registered Bot completes its launch and remains supervised |
| Retry starting an existing managed Bot | Session/owner in the database queue after preparing its files, immediately before launch | Worker starts normally |
| Managed restart | Per-caller validation before joining an active receipt; validation after receipt read and again after writing `running`, before IPC/spawn | An acknowledged restart and its durable receipt remain valid |
| File label | Session/owner after acquiring the file mutex and reading current revisions, before writing | Admitted atomic label write may finish |
| File scan | Session/owner after loading labels, before starting the shared scan | Shared scan continues until completion/cancellation |
| Reveal in Finder | Session/owner after current-root enumeration and path existence check, before dispatch | Dispatched native operation is not recalled |
| Google Docs export | Session/owner/conversation membership in the admission transaction after OAuth and the per-message file mutex | The admitted export preserves document ID/completion receipts |

Non-managed Bot restart rechecks the actor before sending the authenticated
Gateway RPC. After dispatch, the Gateway owns the admitted operation. Raw
`TransactionGuard` callbacks are used only inside an already-owned database
queue; filesystem/receipt guards enter the queue themselves. Do not recursively
call `db.serial` from a transaction guard.

## Safe retries and persistence

An authorization rejection before a managed restart's side effect restores its
previous receipt state, outside the operation-failure catcher. It propagates the
actual auth error and does not consume the retry key as `operation_failed`.
An already-active restart still deduplicates; every joining caller must pass its
own admission check. I/O failure while restoring a receipt fails closed; a
remaining interrupted receipt is not permission to replay a side effect.

Bot preparation may leave inert configuration/key/workspace files if permission
is lost before registration. They are not registered or launched. Preparation
records its exact request in `managed-bot-spec.json` (0600); a changed retry
specification is rejected rather than silently using the old prepared config.
Trusted retries of the same specification reuse it. Existing files and external
workspaces are never deleted to tidy an authorization failure. Registered Bots
retain subsequent native model/effort edits across restore.

Google create has no idempotency key. A rejected pre-admission export creates no
new receipt/document, and an unfinished update retains its saved document ID.
Once admitted, creation/update and durable bookkeeping finish even if the
requesting device is revoked. A second trusted device can retrieve the stored
result without creating another document. The original revoked device receives
no private response. The response also rechecks conversation membership.

## Evidence and limits

`tests/hub-control-revocation.test.ts` has 18 cases: device revocation, token
expiry, owner demotion, membership loss, real file-mutex waits, delayed receipt
read/write, Bot preparation/registration, queue isolation, preserved admitted
work and trusted retries. Focused validation: 9 files / 76 passed. Chromium and
WebKit each passed eight related browser cases (creation, collaboration, effort,
file center, managed restart, operations, restart guard).

Full-check output, source hashes and final counts are recorded in
the validation receipt（本地材料：`evidence/control-revocation-2026-10-03.json`）.
The frontend/native assets are unchanged. No deployment, fleet restart, real
OAuth/Finder interaction, push or native-device acceptance is claimed. Previously
admitted side effects cannot be undone by revoking a device; this is not a claim
that every role/grant-change combination or every service wait has been tested.
