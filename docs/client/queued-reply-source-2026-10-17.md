# Queued prompts and reply ownership

## Confirmed symptom

When a task is running, newer user messages are persisted in the conversation
while they wait in the Hub queue. A response or question-timeout notice from
the running task can consequently appear immediately after a newer prompt.
The client previously rendered `replyTo` only for user quotes and forwards,
so the Bot response appeared to answer the nearest queued prompt.

Read-only inspection of the reported conversation confirmed that the notification
task's response retained the notification prompt's ID. The later question had
not been dispatched. The later cancellation and priority change also had explicit
queue mutation receipts. This evidence establishes a missing ownership indicator;
it does not establish that the worker executed the wrong queued task.

## Change

- Desktop and phone render a compact “回复：…” source above Bot replies,
  including ordinary text, run cards, questions, expiry notices and attachments.
  The source comes only from the persisted `replyTo` ID in the same conversation.
- Clicking the source uses the existing locate-message behavior. Cached replay
  and reload preserve the association. Removed or unavailable originals disable
  navigation and show that the source is unavailable instead of using another
  nearby prompt.
- Forwarded messages retain their forwarding source. Bound background reports
  retain their existing source control, without adding a duplicate one.
- The source uses existing theme colors and a single clipped excerpt; phone
  controls retain a 44 px touch target. It does not render or download another
  copy of the quoted attachments.

Queue order, dispatch, question answers and stored message timestamps are unchanged.
CLI impact: presentation only; CLI and cross-Bot sends already retain the same
message IDs and queue semantics. No new command or protocol field is required.

### Phone spacing follow-up (2026-10-26)

In the light-surface and monochrome phone themes, bottom-aligning the source
label inside its touch target left a 27 px blank band below the author/time row.
Center the label and remove that row's extra bottom margin when a source is
present. The visible gap is 13 px; the full 44 px target remains outside both
the author row and reply content. Desktop and the other palettes are unchanged.
The existing touch-target regression checks the visible gap as well as edge
hit-testing, Android/iOS attributes, narrow widths and light/dark modes.
Its added gap assertion reproduced the old 27 px spacing before rebuilding.
The revised client passed four Chromium journeys (touch geometry plus phone and
desktop reply ownership/navigation) and two WebKit touch journeys, along with
the client translation/type/bundle build. These are browser fixtures, not
physical-device or installed-App acceptance.

## Verification

An isolated Hub reproduction creates three real queued prompts, dispatches only
the first, and publishes its reply and expiry notice after the later two prompts.
The pre-fix desktop test failed because neither reply had a source control.

The regression checks phone (390 px) and desktop (1360 px), exact source IDs,
click-to-locate, two prompts remaining in order in the queue panel, reload,
personal deletion of the source and layout in three palettes with light/dark
themes. Existing quote, per-prompt status, background-card and queue checks are
run alongside it. Test artifacts are kept on the external disk under
`/Volumes/gdrive/taro-tmp/tarobot-queued-reply-20261017/`.

Results: 74 focused queue/status tests passed; 25 browser tests passed (11 source,
quote and status journeys plus 14 queue, background-card and scrolling journeys).
Standalone host and client builds passed, including UI translation and TypeScript
checks. The client build retains its existing mixed static/dynamic import warning.

This is browser integration evidence using an isolated real Hub, not native
Android or installed desktop acceptance. Installed 1.0.85 binaries are unchanged;
the renderer fix needs a subsequent App build and release.

### Long fitted-receipt source overflow (2026-10-27)

A long “回复：…” source above a submitted-answer receipt could enlarge the
horizontal scrolling area in ordinary desktop chat as well as ADHD. The isolated
real-Hub test reproduced this in WebKit: source width 2210.14px inside a 720px
message body, with scrollWidth 2278px versus clientWidth 1087px. The same initial
Chromium journey passed; this is why checking Chromium alone missed the defect.

`bot-reply-source.css` now prevents the no-wrap excerpt from contributing to the
fitted grid column's intrinsic width (`contain: inline-size`), and uses the
resolved message-column width. Existing single-line ellipsis, nonshrinking label
and arrow, disabled-source handling, title preview and phone touch height remain.
This does not hide overflow on the entire message viewport or truncate original
content. Clicking still locates the exact persisted source.

`queued-reply-source` exercises long Chinese text and unbroken English strings,
a submitted-answer receipt, ordinary desktop, three-column ADHD and 390px phone,
both themes, true overflow dimensions, arrow bounds, source navigation and
unchanged original blocks. Its suite is also included in the maintained WebKit
config. Queue ownership/replay/deleted-source, 320/390px touch targets and legacy
streamed-card stability remain separate existing regression contracts.

App presentation only; no Host/CLI, queue, history, schema or execution changes.
Synthetic browser evidence does not establish native Mac/iPhone acceptance.

Validation: Client translation/TypeScript/Vite build passed. Twelve focused
Chromium/WebKit browser cases passed. Baseline Chromium passed while the new
WebKit long-source case failed before the CSS repair. Evidence is under
`reply-source-overflow-20261027`; no installed App update is included.
