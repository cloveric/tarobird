# Run feedback without false inactivity warnings

## Problem and behavior

An active background card displayed “已 2m 21s 未收到新进展，正在等待引擎返回。”
even though the task could still be working. The client showed this line whenever
`run.updatedAt` was at least 60 seconds old. That timestamp records the most recent
reported event/state, not a continuous measurement of the engine's work.

- Ordinary, child and background cards retain their reported phase/current action
  and elapsed time. A quiet interval adds no warning or extra card height.
- The process reader shows **最后更新** because the recorded time includes both
  engine events and host-side state changes. The full local date and time is
  always visible and labeled **主机记录**, including on touch screens. Connected active runs also show a
  relative time in the selected language. Two fixed lines keep minute/hour/day
  changes from wrapping and pushing the journal down.
- A neutral explanation in the reader states that some tasks return results only
  when finished and that reporting gaps do not **necessarily** imply stalled work. It is absent
  for terminal, disconnected, failed-message, approval, question and stopping states.
- Explicit failure, interruption, connection loss, unavailable journals and
  unanswered questions keep their existing indicators. Time passing alone neither
  generates a progress event nor changes a task's execution state.

The detail view reuses the card clock and authenticated server-time adjustment.
The clock does not change the recorded timestamp or journal revision. No new
polling or background timer is introduced, and freshness text lives inside the
reader's scrollable body rather than expanding the chat or ADHD pane.

## Sync review and limits

`core/run-record.ts` updates event time/revision when it receives engine events.
`core/scoped-run-presentation.ts` coalesces child progress before publication;
`gateway/run-writer.ts` retains pending journal revisions and flushes terminal
evidence. The open process reader catches up with delayed journal writes without
requiring another engine event, and coalesces refreshes behind an in-flight read.

The regression matrix exercises normalized events through the real Gateway, Hub
and built shared client for Codex, Claude, Kimi, DeepSeek and Antigravity. It covers
live progress, disconnect/reconnect, failures, terminal receipts and an already
open reader. This does not establish that every line of a real CLI console is
exposed by its adapter, or identify whether the reported screenshot had missing
events. No user task was rerun, stopped or rebound to obtain evidence.

## Validation

### Initial refinement

The new quiet-background regression first failed on the original warning.

- 108 focused tests passed across `run-presentation`, `run-presentation-ui`,
  `scoped-run-presentation`, `gateway-run-writer` and `client-stream`.
- Chromium and WebKit each passed 31 scenarios: 20 background/reader checks,
  10 five-engine desktop/phone journeys and one ADHD background-reader journey.
  The two quiet-background scenarios were rerun in both browsers after adding
  English and terminal-timestamp assertions; all four reruns passed.
- Tests cover the original two-minute gap, advancing time without changing the
  event timestamp, a new public update, compact card geometry, retained drafts
  and focus, live/terminal reader refresh, failures and disconnect/reconnect.
- Standalone host and client production builds passed, including TypeScript
  and translation checks. Desktop card and phone process-reader screenshots
  were inspected. Browser validation is not native Mac/Android acceptance.

### Opus follow-up

Claude Opus 5.5 at `xhigh` independently reviewed the initial implementation and
then discussed the follow-up layout. Its proposal to add the explanation only
after 60 seconds was withdrawn: the process reader disables scroll anchoring, so
inserting a row above the journal could move the text being read. The explanation
continues to depend on execution state, not a timer threshold. There is no new
button, disclosure, modal, focus target, interval or fixed timeout claim.

The reader now uses the same derived display phase as the card. A local pending
stop immediately reads as stopping, and a failed message reads as interrupted.
This affects only presentation; journal freshness, polling, terminal catch-up,
queue state and model execution still use the original host data.

The background fixture now advances its timestamp only on an explicit simulated
progress/phase update. Changing locale, connection or view no longer fabricates
fresh progress. New browser checks directly cover the rendered timestamp and
state logic, rather than counting adjacent unit tests as coverage of these paths:

- 320 px Chinese/English: 59.999/60-second, minute/hour/day transitions, unchanged
  event timestamp, stable row geometry, and visible exact time after completion.
- Positive and negative authenticated host-clock offsets; locale changes preserve
  the event time and offline/terminal states have no moving relative clock.
- Approval, questions, stopping, interruption, errors and connection loss retain
  their status; an unacknowledged local stop is consistent in card and reader.
- Time passing and fresh events preserve phone process scroll, search drafts and
  focus. No elapsed-time transition inserts or removes explanation text.
- ADHD uses two scripted Bots and six conversations, opens the process reader,
  restores focus to its trigger, and preserves the other Bot's draft and composer
  geometry. This remains browser acceptance, not live-model or native-App proof.

Source and built-client SHA-256 evidence is retained with the local test artifacts
so the integration runs can be tied to the renderer build under test.

Final independent Opus review found no blocker. Its large-text concern was
reproduced at 200% text size and repaired: the heading can shrink with ellipsis,
the exact timestamp can wrap without losing content, and relative time stays
beside its label. This is browser text scaling, not native Android textZoom
acceptance. The scroll test now awaits the delayed process response before
checking geometry and focus, and timestamp persistence includes closing/reopening
the reader. The other Bot in the ADHD case exercises draft preservation, not a
second simultaneously streaming model.

Opus also proposed subtracting the clock offset from the displayed event time.
After jointly checking the time domains it withdrew that finding and fix: the
relative calculation and stored timestamp already use the same host clock;
offset alone does not establish which device clock is correct. The UI labels the
host record explicitly and preserves its raw timestamp through locale changes,
offset changes and reopening. A local clock correction must not rewrite history.

Follow-up validation: the new timestamp regression failed against the previous
renderer first. The final source passes 108 adjacent unit regressions, 26
background/reader scenarios in each of Chromium and WebKit, plus 11 integration
scenarios in each browser (five engines on desktop/phone and the two-Bot ADHD
journey): **74 browser checks**. Standalone host and client builds pass. The
320 px Chinese/English, phone compaction detail and ADHD process screenshots were
visually inspected. The five-engine matrix uses normalized scripted events with
the real Hub/Gateway/client; it does not exercise actual CLI engines or replace
native installed-Mac/Android acceptance.

CLI impact: not applicable. This changes shared-client presentation only; host
commands, event schemas, queues, model execution and headless operation are
unchanged. No native installer is produced by this source change.
