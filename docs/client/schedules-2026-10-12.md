# Scheduled tasks in the App

The desktop and phone + menus now offer **New scheduled task**. Pick the Bot,
name, instructions, result conversation, frequency and timezone. Daily, weekdays,
weekly, one-time and five-field Cron plans share the existing scheduler. A new
dedicated result conversation is the default unless opening from an eligible
active conversation. Advanced context settings default to a fresh session on
each run; persona and engine-managed memory remain Bot-owned. A scheduled engine
turn uses its result conversation's resumed workspace, including for a fresh
session. Explicit workspace overrides keep their existing precedence.

Manage tasks under **Workspace → Scheduled tasks** on desktop or **Me → Scheduled
tasks** on phone. Select a Bot, edit, pause/enable, inspect the next/last run, open
the result conversation or confirm deletion. Editing keeps the existing paused
state. Deletion removes the schedule, not messages or its conversation. Refresh
loads edits made on other devices. The Bot host must be running and connected;
closing a client does not cancel the stored job. This is not an OS wake service.

## Ownership and compatibility

- `client/src/ScheduledTasks.tsx` owns the form/list and stable request IDs.
  It uses the shared modal and mobile sheet, with bounded desktop dragging.
- `src/client-protocol/schedules.ts` validates settings and mutations.
- Lists preserve legacy one-time jobs without an execution timestamp. These rows
  show a repair warning and no next execution; editing starts with an empty date,
  while pause/removal remain available. Reading never rewrites or silently drops
  the record. New and updated settings still require a nonempty valid future time.
- Hub's authenticated `/api/bots/:id/schedules` GET/POST requires owner role,
  authorized Bot and result-conversation membership. Archived destinations cannot
  receive new/enabled tasks; existing ones can still be paused or removed.
- `src/gateway/schedules.ts` uses the worker's **existing** CronStore/CronScheduler
  and the common time/timezone validator. No client timer or extra scheduler is
  introduced. Bot model/effort, files, questions, session dispatch and result
  delivery still follow the shared executor.
- Before an engine task starts inside the conversation queue, the executor
  applies a pending App session selection and resolves that conversation's
  workspace. Engine execution and file delivery use the same resolved root.
  An unavailable selected session fails before any model call; notification-only
  reminders do not consume a session selection.
- Historical `channel: lark` and `lark:gw_...` keys remain for compatibility with
  existing App jobs. They do not load the Feishu adapter or call its transport.
  Feishu/Telegram jobs are not exposed by this App management API. Existing
  direct reminders retain `deliveryMode: notify`; their detail explains that
  they do not call a model. Newly created App tasks explicitly use `agent` mode.
- Durable per-request receipts prevent a lost reply from duplicating a task.
  Ambiguous interrupted writes require checking the list, not blind replay.
  The result-conversation creation uses its existing idempotent action ID.
- Edits, toggles and removals compare revisions under CronStore's write lock.
  Conflicts fail visibly, including edits racing with removal. Revisions advance
  even when two updates occur within a millisecond. Existing callers can omit
  the revision and retain their previous behavior.

## Verification

- Standalone pre-complete: 203 files, 2735 passed, 1 skipped. After adding the
  removal-race guard, the focused CronStore/Gateway suite passed all 22 cases.
  Root and client builds pass, including translations and the standalone graph.
- Real HTTP Hub/Gateway/CronScheduler fixture verifies owner/member isolation,
  wrong-Bot rejection, timezone/Cron validation, persistent writes, replay after
  an expired one-time date, cross-device revision conflicts, pause/remove and an
  actual timed callback publishing its result into the result conversation.
  **The engine is a test double.** No real model/session was created for this test.
- The 2026-10-13 source regressions exercise persisted external workspace bindings
  across App/Feishu profiles and fresh/reused sessions. A real Hub/Gateway fixture
  verifies selection before the first scheduled engine call, actual uploaded file
  bytes from the selected workspace, and rejection of an unavailable selection.
  Native engine calls remain test doubles.
- A persisted missing-time job is reproduced through the real Hub/Gateway HTTP
  path alongside a healthy task. Regression coverage verifies the warning,
  unchanged bytes on read, invalid enable/write rejection, repair and removal.
- Chromium: all seven scheduling/creation tests pass. WebKit: all six existing
  creation cases plus the scheduling case pass. Scheduling covers a lost response
  and explicit retry, exactly one job and conversation, phone pause, desktop edit,
  phone refresh, single-run timezone conversion, deletion and offline feedback.
  The scheduling fixture blocks service workers so its network-failure injection
  reliably intercepts requests in both engines.
- Native macOS App 1.0.15, separate preview identifier and disposable Hub:
  created a recurring task from +, waited for a real minute-boundary scheduler
  callback, observed the result in the native chat, paused it, edited its name
  and confirmed that it stayed paused. The engine was a test double here too.
- Android APK build/signature/version checks pass; its 119 bundled asset files
  match the client build. No Android device is attached, so physical-device
  acceptance is still unverified.
- Independently installed production package and re-extracted npm archive both
  start the Hub and serve assets with no Feishu SDK, credentials or CLI on PATH.
  macOS/Android bundles are checked separately before upload.

Versions: host 0.1.388, macOS 1.0.15, Android 0.1.388-test.1 (2026101203).
macOS remains ad-hoc signed, without Apple notarization. Android uses the existing
prerelease test key. Real installed Apps, user data and running Bot services were
not replaced or restarted. Real-engine scheduling and physical Android use are
not newly verified by this change.
