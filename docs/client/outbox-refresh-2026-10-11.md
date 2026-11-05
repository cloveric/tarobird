# Outbox refresh and reading position, 2026-10-11

This follow-up addresses three reproduced client issues left by the earlier
[send-continuity work](message-send-continuity-2026-10-11.md). It preserves the
existing durable FIFO/idempotent retry contract and does not add an engine
session or an application encryption layer.

## Reproduction and changes

1. Streaming cache revisions arriving faster than an outbox read could keep
   invalidating every result. A controlled test pulses the real connection's
   cache revision every 15 ms and delays actual IndexedDB outbox reads by 90 ms.
   Pending feedback must appear while pulses continue. Ordinary refreshes now
   coalesce behind the in-flight read and publish completed snapshots. Only a
   committed local queue mutation replaces a pending request; a separate local
   queue revision and request token reject late pre-mutation results.
2. A passive view sharing IndexedDB has no sender-local ACK receipt. If another
   window removes its visible pending item before its history read catches up,
   that view could show neither representation. A missing item is now retained
   as **Syncing send status**, with neither a success claim nor Retry controls.
   The observer captures its own local cache revision R and synchronously
   requests fresh views at R+1. Only canonical history already visible, or a
   successful read that started after R, may retire the bridge. An old held read
   resolving or a new read failing is not sufficient. External discard and
   accepted sends are distinguished by the resulting history, not by absence
   alone. Newer queue orders supersede old bridges.
3. Pending rows live outside the virtual history. App followed message height
   and viewport height, neither of which necessarily changes when queued rows
   grow. The existing ResizeObserver now also observes the pending-row
   container. It follows actual height changes while respecting explicit
   history reading, message targets, touch holds and hidden phone conversations.

Astra additionally identified a switch-away ordering gap: a single last raw
queue snapshot loses the previous conversation's pending observation before a
remote removal is noticed. A focused test reproduces this independently of the
already-covered case where the missing receipt exists before hiding. Raw observations now use the same connection/conversation isolation as
receipts. Rendering can immediately reuse that observation when returning, even
if the new queue read is held or fails. Both switch-away and held-return cases
failed before their respective corrections; the intermediate results are
retained. Receipt cleanup cannot rediscover the old missing item because the
accepted absent snapshot has already replaced its raw observation.

## Evidence scope

- Real App, temporary Hub and IndexedDB: desktop/phone long-conversation queue
  scrolling and two actual pages sharing the same browser context/database.
  The passive page receives real Hub events but sends no application message,
  and the test verifies that it received zero message ACKs and that the Hub has
  exactly one user message.
- Production hooks and actual IndexedDB with controlled timing: stream pulses,
  missing receipt, old/new history reads, failed history retry, external discard,
  switching away and back, and a reused ID with a newer durable order.
- The first phone fixture started in the phone inbox rather than selecting its
  chat; that setup failure is retained but is not counted as a product bug.
  After adding ordinary conversation selection, the old product also failed
  the intended pending-row viewport assertion.

This does not add cross-window notification of every local-only write. Pure
local removal/reset in another window still needs an existing refresh/reconnect
trigger to be observed. Once the missing item is observed, its handoff is
covered. Multi-device Hub synchronization is separate from shared-IDB windows.

Before the review follow-up below, Chromium passed 88 related cases. WebKit passed 87
and failed one existing host-workspace case on a `/health` access-control
diagnostic during `page.reload()`. The original assertion was not relaxed and
the failed trace is retained. All 11 newly added cases passed in both engines.
The unchanged host-workspace flow then passed three consecutive repetitions.
Root and client builds passed; exact source hashes are recorded in
`evidence/outbox-refresh-20261011/tested-source.json`.

The trace places the diagnostic 3.4 ms after reload began, before the next
document loaded. A separate same-origin HTML page with only a caught `fetch`
loop and no TaroCub code reproduced the same diagnostic 20 times in 35 reloads.
It recorded no `window.error` or `unhandledrejection` events. This isolates a
WebKit reload diagnostic in this test environment; it does not turn the failed
strict run into an all-green run or claim native reload acceptance. Reproducer
and results: `evidence/outbox-refresh-20261011/webkit-reload-diagnostic.mjs`
and `webkit-reload-diagnostic.json`. No production exception suppression or
test filtering was introduced.

## Opus and Astra follow-up

The initial large Opus request reached its 900-second limit without returning
a review. A smaller actual `claude-opus-5-5` request subsequently completed;
the CLI requested `--effort xhigh`, and the result's model usage confirms the
model. It is a read-only supplied-source review, not reviewer-run tests or an
independent inspection of App's scroll code. The result and dispositions are
in `evidence/outbox-refresh-20261011/{opus-focused.json,review-disposition.json}`.

Both concrete findings failed newly added tests before their fixes:

- A hidden visited chat could retain every background send receipt, then show
  a large batch of sent placeholders on return while history was slow. The
  global system-share sender can use a hidden host's connection, so this does
  not require two visible App instances. Receipts now bridge only currently
  visible, previously observed or locally queued feedback. A committed local
  enqueue notification records minimal IDs for the visible chat, so an ACK
  that beats the first queue read remains eligible after hiding the chat.
- If another window had discarded a failed entry, clicking Retry could do
  nothing because the atomic retry returned false. That outcome now refreshes
  local views and reconciles the stale error without resurrecting the entry.

Astra then found an interaction in the first proposed correction: an empty
shared-queue read could retire the only local ID before a delayed hidden ACK.
A further focused test failed before the correction. Missing IDs now retain a
revision watermark until either their ACK arrives or a successful newer
history read confirms the state. Old or failed reads cannot retire them;
one absence requests only one refresh. Astra's final read-only review found
no further specific issue. The 32-case focused regression passed, including
the old hidden/fast-ACK cases and the new cross-window ordering.

The review's two protocol assumptions were checked separately: forwarding's
conversation ID is the target; and the receive chain commits message events
before ACK removal, with the earlier failure guard preserving pending data
after a failed event write. This follow-up supersedes the r30 source checkpoint.

## Asynchronous Markdown and reading position

The first wider review-follow-up run passed 91 Chromium cases and failed one
desktop pending-row reading assertion; WebKit passed all 92. Trace inspection
placed the 29-pixel scroll change **before** the Send click. The test had captured
its baseline before newly mounted Markdown and virtual measurements settled.
It now waits for all mounted rows, including overscan, and stable measured
geometry before that baseline, retains the same sub-pixel scrollTop assertion,
and also asserts the same message's visual position.

That timing correction did not dismiss the underlying rendering issue. A new
controlled test delays delivery from the actual parser Worker while scrolling
backward. On the previous production code, the first message intersecting the
viewport moved 32 pixels on desktop and -51 pixels in the phone layout when
the delayed output arrived. The corrected-anchor failures and traces are kept
in `evidence/outbox-refresh-20261011-r31/reading-before-corrected.log` and the
two `reading-before-*.zip` files. An earlier version selected the second,
fully visible row; its failure is not the primary reproduction because growth
within the first visible row may legitimately move later rows.

The virtualizer now compensates remeasured rows entirely above the viewport
even when the user was scrolling backward. Its predicate accounts for the
intro preceding the virtual list, preserves first-measure semantics and skips
hidden/zero-height views. It returns a decision to the existing library rather
than writing scrollTop itself, retaining the iOS touch/inertia deferral. Pending
plain prose also shares the final paragraph's width and wrapping. Growth below
the reading position within a visible message does not shift that message.

The focused Chromium and WebKit runs each passed all three profiles: desktop,
phone width and an iPhone-UA/touch-capable context. Each covers delayed output,
growth inside the visible row and shrinking an offscreen row. The iOS profile
also checks that no programmatic scroll writes occur while its synthetic touch
is held, and that compensation resumes after touchend. This does not test a
physical gesture or device inertia. Astra reviewed the coordinate and lifecycle
logic, including the hidden-view guard and repeated parser-ready checks.
The dependency's existing missing `touchcancel` reset is recorded as a phone
acceptance boundary, not claimed fixed. Details: `reading-review.json`.

After these corrections, the final relevant Chromium and WebKit runs each
passed **100 cases** (18 spec files), including all 15 outbox-refresh and three
reading profiles. Root and client builds passed. Final commands, exit codes,
logs and source hashes are in `evidence/outbox-refresh-20261011-r31/`; the
earlier failed runs remain separately recorded. No model sessions were created
by these browser regressions; their Hub and messages are isolated fixtures.

The Mac was rechecked during this turn and remained locked. Browser tests and
any newly built development package do not close ordinary native UI, RSS/cold
start, real phone, push, signing or the other original product acceptance gates.

The earlier verified r30 development package（本地材料：`evidence/macos-r30-2026-10-11.json`）
contains the initial queue-refresh changes and preceding storage/history/send-
continuity work. It predates the Opus/Astra and Markdown follow-ups above.
Both optimized architectures, strict ad-hoc seals, DMG integrity, full read-only
mounted-bundle comparison and the exclusive Downloads copy passed. All 303
frontend files match the copied iOS/Android resources. Input source hashes were
unchanged during the build. It is not installed, notarized, published or a
mobile SDK build; the Hub must use the matching source.

The final r31 package receipt（本地材料：`evidence/macos-r31-2026-10-11.json`） supersedes
that checkpoint and includes every correction above. The optimized universal
executable, strict ad-hoc signatures on the standalone and read-only mounted
App, DMG integrity, full mounted-bundle comparison and delivery copy all passed.
The delivered file is
`/Users/example/Downloads/TaroCub_1.0.0_universal-development_20261011-r31.dmg`
(17,066,774 bytes, SHA-256
`b6a62a944a2cd445f20f306c4b706c73eabcf7f4f2b701be7765759dd70c646f`).
All 303 frontend files match both copied mobile shells, and source fingerprints
still match the tested revision after packaging. The package was not installed
or published; no mobile SDK build or additional native runtime acceptance is
claimed. Final summary: `evidence/outbox-refresh-20261011-r31/verification-summary.json`.
