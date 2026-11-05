# Move a pending message to the front

Every movable queue item now has an accent-colored up-to-line button in its
header, before the source-message arrow. Phone, desktop and ADHD use the same
action. The first queued item is disabled; the phone button has a 44 px target
and does not add another row of actions.

The action resolves the current queue head by message ID and reuses the drag
destination validator, placement animation, revision and request-ID receipt
path. It sends one `move` before the first queued message. Other messages retain
their relative order. Already-dispatched work is excluded; command/permission
barriers, disconnected or busy state, and uncertain receipts prevent a new
move. A stale revision is rejected and refreshed, without silently retrying
against a different queue. Message content, references and drafts are unchanged.

CLI parity already exists through the same authenticated API:
`tarobot queue list CONVERSATION --bot BOT`, then
`tarobot queue move CONVERSATION --bot BOT --message MESSAGE --before FIRST_QUEUED_MESSAGE --revision REVISION`.
No new protocol, endpoint or dispatch scheduler was introduced.

## Validation

- Four new browser cases in `prompt-queue.spec.ts`, run in Chromium and WebKit:
  phone/desktop/ADHD promotion, one POST, relative order, retained message/reference
  and draft data, reload persistence, first-item disabled state, 320 px layout,
  command barrier and concurrent revision rejection.
- Three existing drag cases per browser cover reorder persistence, control
  barriers, uncertain receipts and recovery; existing drag/up/down paths remain.
- Hub queue, headless CLI queue and client request suites: 65/65.
- Client type/translation/build and standalone Host build pass.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/queue-move-front-20261031/`.
Browser/isolated Hub checks do not establish physical-phone acceptance.
No release or installed App update is included.

## Move to end

A down-to-line icon beside Move to front sends the selected pending message to
the queue end in one revision-checked move (`beforeId: null`). It uses the same
drop validator, animation and durable request receipt as the existing controls.
The final item is disabled; command barriers, permissions, busy/offline state
and uncertain requests retain the existing guards. It never interrupts the
current task or changes message content, references or unsaved edits.

The icon appears on phone, desktop and ADHD. Below 361 CSS px, the sequence
number and timestamp form a compact two-line group so the four header icons
keep their 44 px targets without wrapping the sequence number.

No Host protocol or new CLI command is needed: `tarobot queue move CONVERSATION
--bot BOT --message MESSAGE --last --revision REVISION` already uses the same
authenticated move action.

Validation: the existing browser journeys now cover moves in both directions,
last-item disabled state, exactly one POST per move, preserved data/drafts,
reload persistence, narrow header geometry, control barriers and concurrent
revision rejection. Five cases pass in each of Chromium and WebKit; client
translation/type/build passes. Evidence:
`/Volumes/gdrive/taro-tmp.noindex/queue-move-last-20261031/`. Isolated Hub/browser
validation does not claim physical phone acceptance. No release or install.
