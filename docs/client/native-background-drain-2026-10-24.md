# Keep native Claude work alive during graceful Host updates

The Gateway worker used to report itself idle once its Core foreground run,
queues, approvals, transport, cron and Agent Bus were idle. Claude can finish
that foreground reply while a native subagent or shell is still running. The
Host's idle barrier therefore committed shutdown and interrupted that child.
This was reproduced with the actual Gateway worker and Claude stream adapter,
using a controlled CLI stream rather than a live model.

`CodexAdapter.hasPendingNativeWork()` is an optional synchronous lifecycle read.
`Bridge` delegates it without creating a session or sending a protocol request.
Claude reads its existing live worker state: native turns, held continuations,
unconfirmed stop fences, unfinished background tasks, active or briefly pending
result reviews, queued reviews and their waiters. Session aliases do not create
extra lifecycle owners, and retired workers do not remain blockers. The same
predicate protects idle worker reaping. Existing task expiry and bounded review
grace remain unchanged; presentation cards are not used as authority.

The native `task_started` frame can arrive after its originating foreground
reply. Until a task ID is registered, an existing explicit background-call owner
keeps drain busy for the bounded task-start grace (currently the same configured
grace as a completion review). Its own foreground terminal frame anchors that
window, so a long summary does not spend the window before it is needed. The
same ownership check anchors launches from an active background review when
that review's own result arrives; foreign, collected and replayed results do
not renew the window. A review identity on the existing owner distinguishes
sibling reviews of the same parent turn and successive monitor reviews; sharing
a parent turn/callback is insufficient. Notification replays preserve this
identity, and completion releases it. Foreground calls have no review identity.
This does not increase the configured grace duration. The
first matching tool-result acknowledgement can also anchor it, including a late
acknowledgement. The existing owner's timestamp and a one-time acknowledgement
flag carry this state; no new task registry is created. Replayed calls/results,
unrelated turns and drain reads do not renew it. Registered or collected calls
cannot acquire this launch grace. A call that never starts expires normally;
a native start delayed beyond all of this bounded evidence remains unknown.

Native terminal state is not yet publication completion. The adapter also counts
in-flight `emitEngineEvent` observer promises, releasing the count on success,
rejection or synchronous throw. Scoped card delivery reuses
`ClaudeScopedEvents`' existing in-flight set, including final cards whose scopes
are already closed. When a worker retires, its existing scope-close promise joins
the adapter-wide delivery counter before the worker leaves the session map. A
natural CLI exit therefore cannot hide a pending final card. The count settles on
success or failure, independently of the bounded process-shutdown wait. No second
task registry or persisted task state is created.

`gateway/worker.ts` includes that lifecycle in the existing `worker` drain blocker.
The same check protects both an idle restart and a previously received drain
commit. It does not stop a child, change message admission or task permissions,
or add a protocol enum that old Hubs would reject. Adapters without the optional
read retain their existing behavior.

CLI impact: headless and App-managed Hosts both supervise these Gateway workers,
so both receive the fix. No new user-facing command is needed. The standalone
CLI must be released from the same source as the bundled Host.

Regression coverage:

- `claude-native-drain`: native running tasks, terminal task awaiting review,
  late task start after a long foreground reply, nested launch ownership,
  launch during a long background review and bounded no-start/replayed result,
  sibling/foreground/monitor review isolation and repeated native notifications,
  first/duplicate launch acknowledgements, never-started expiry and unrelated
  foreground turns,
  bounded no-review grace, overlapping reviews/waiting input, held continuation,
  unconfirmed stop fence, TaskOutput consumption, retired worker, observer and
  scoped-card success/failure (including final cards during/after child close),
  and default behavior of unsupported adapters.
- `host-cli-native-drain-worker`: actual worker rejects idle/commit while its
  actual Claude adapter retains the task, its review, or the public delivery;
  exits normally only after all three settle.
- Existing Claude native input/control, scoped events, Host drain and desktop
  update suites remain required. These controlled tests are not live CLI or
  physical-device acceptance.

Upgrade boundary: this change cannot repair the workers already running inside
an older installed Host. Its supervisor automatically commits worker shutdown
when it sees the old idle response. Before initiating that old Host's drain,
independently inspect and wait for native background work and result reviews;
do not wait until `drained` before checking and do not force-stop work to install.


## Old Host preflight (2026-10-24)

The new CLI/desktop lifecycle checks known work before sending drain to a
running Host older than 0.1.454 (including an unknown version). An independent
read-only database connection looks for inputs already dispatched but not yet
acknowledged, foreground replies, and active `nativeRun` or `scopedRun` cards,
while their Bot is online and still a conversation member. For schemas predating
the dispatch fence, pending deliveries are treated conservatively as in flight.
Undispatched durable-queue inputs remain queued during drain.

Waiting includes foreground-to-background handoff: an active foreground turn
must not be allowed to create a background task while the old drain is already
waiting to stop it. The preflight shares the caller timeout and never treats
card age as completion. Timeout returns busy without initiating drain. Hosts at
0.1.454 or later keep their native-worker barrier.

This is additional protection for known work, not an atomic replacement for the
native lifecycle predicate. Disconnected/removed workers, unpublished unrelated
work, or a new dispatch between the last observation and drain admission remain
outside this observation. Stale active records can keep an old Host waiting.
Inspect the corresponding work; `restart --force` remains an explicit interruption
of all Host work, never an automatic update fallback. Tests:
`desktop-runtime-drain`, `desktop-update`.
