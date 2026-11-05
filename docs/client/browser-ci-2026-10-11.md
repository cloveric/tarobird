# Browser acceptance: current controls, recovery and long-message layout

## Latest verification

The [complete matrix on 122169a](https://github.com/cloveric/tarobot/actions/runs/38120836530)
finished with **576 Chromium cases passed and 41 skipped**, and **539 macOS
WebKit cases passed, one failed and 41 skipped**. The remaining WebKit case failed
at its initial READY assertion: its recorded UI shows “备用对话” selected while
“发送连续性” and READY are present in the sidebar. Both seeded conversations
can share the same creation millisecond. The fixture now explicitly selects
its intended conversation before checking readiness; the actual delayed-history
and sent-feedback assertions retain their original limits. Verification of this
fixture change is recorded separately from that failed complete run.
The [focused continuity follow-up on 9e7a215](https://github.com/cloveric/tarobot/actions/runs/38122013999)
ended before any runner or step started because of hosting-account restrictions.
It did not execute browser tests. The fixture fix remains unverified in-browser;
the prior complete run's failed gate is unchanged.

The [complete matrix on d4e4b0f](https://github.com/cloveric/tarobot/actions/runs/38116973387)
finished with Chromium **572 passed, three failed, 41 skipped**, and macOS
WebKit **536 passed, three failed, 41 skipped**. It predates the fixes below;
no complete-matrix pass is claimed from the subsequent focused checks.

- **Large CJK paragraphs:** Bot prose used `text-wrap: pretty`, which asks
  WebKit to optimize line breaks across the entire paragraph. The snapshot
  fixture contains six 60,000-character paragraphs. During reload this could
  stall even an unrelated IndexedDB probe for nearly five seconds. Ordinary
  wrapping removes the stall while retaining the entire text. Both snapshot
  cases passed on each engine in the
  [focused run on dddfffa](https://github.com/cloveric/tarobot/actions/runs/38117266412),
  with the original five-second outbox assertion unchanged. WebKit documents
  [the performance tradeoff for enormous paragraphs](https://webkit.org/blog/16547/better-typography-with-text-wrap-pretty/).
- **File center:** the English acceptance path still searched the home screen
  for a control now inside Workspace. The corrected route passed in both
  engines in the [file-center/language run](https://github.com/cloveric/tarobot/actions/runs/38117709606).
  The two-device conflict, save and language assertions remain in place.
- **Manual retry:** a one-shot injected cache failure could recover during an
  unrelated revision before the test clicked Retry. The fixture now keeps the
  fault active until that actual click. Both engines passed the message-refresh
  cases in the [recovery run](https://github.com/cloveric/tarobot/actions/runs/38117582366).
- **Reading position:** a held Worker reply can refer to a virtual row that is
  no longer mounted. The fixture now scrolls until a real delayed row is
  mounted, then places it above the reading anchor. The existing anchor,
  current-row growth and iOS touch-deferral checks all passed: three Chromium
  and three WebKit cases in the
  [focused run on 96928cb](https://github.com/cloveric/tarobot/actions/runs/38117836993).

The **5,000-line performance investigation** also found test overhead. A CPU profile
showed Playwright's automatic DOM snapshots traversing the entire growing
document on the UI thread. That test now disables automatic traces while
retaining complete-content assertions, input timing and raw frame/long-task
metrics. Without tracing or CPU profiling, the
[measurement on 8d167c1](https://github.com/cloveric/tarobot/actions/runs/38117659171)
recorded input **6 ms**, frame P95 **16.8 ms**, and longest task **99 ms**.
Frame P95 meets the unchanged 35 ms limit, but the task exceeds the unchanged
80 ms limit. Diagnostic profiling is opt-in and can itself affect timings;
profiled runs are not uninstrumented performance acceptance.

The later [browser timeline](https://github.com/cloveric/tarobot/actions/runs/38118194063)
identified a separate application defect: finalization discarded the streamed
answer's `md_*` element ID. React unmounted its parsed content, displayed raw
Markdown, and then laid out the whole answer again. In that diagnostic run,
layout objects dropped from 9,862 to 241 before the final re-layout of 11,541
objects; the final style and layout work alone cost approximately 87 ms.

Gateway finalization now preserves the matching streamed answer ID when its
text is a prefix of the final answer. The App retains unchanged parsed chunks
and DOM nodes while appending the final suffix. Unrelated narration does not
qualify, and Feishu's terminal IDs remain unchanged. A focused regression
failed before the fix and passed afterward; 102 renderer/translation tests
passed. The browser performance journey also asserts that the original
streamed paragraph remains connected after finalization.

[The focused run on 3a319c7](https://github.com/cloveric/tarobot/actions/runs/38118471213)
passed **11 Chromium and 10 macOS WebKit cases** across performance, transport
streaming, reading position and Markdown. Its unprofiled Chromium performance
receipt recorded input **27 ms**, frame P95 **16.8 ms**, and longest task
**71 ms**, satisfying the unchanged 500/35/80 ms limits. All 5,000 lines,
10 tables and 10 equations remained present. This is a hosted browser result,
not a native-container or physical-phone performance receipt.

The [follow-up on 76cff05](https://github.com/cloveric/tarobot/actions/runs/38118655598)
additionally compared every rendered line against the exact ordered 5,000-line
source after the timed interval. It passed with input **31 ms**, frame P95
**16.8 ms**, longest task **67 ms**, and all table/formula checks intact.
The [complete follow-up matrix](https://github.com/cloveric/tarobot/actions/runs/38118627000)
on `bc23389` (the same application source, before the extra per-line assertion)
finished with Chromium **574 passed, one failed, 41 skipped**, and macOS WebKit
**538 passed, one failed, 41 skipped**. Chromium's remaining failure was the
5,000-job dashboard opening assertion; WebKit's was healthy Markdown recovery
while two over-limit source placeholders were mounted. Both retain their
original five-second assertions. This is not a complete-matrix pass.

The raw Markdown fallback inherited expensive typographic shaping from the
application body. It now uses inexpensive shaping while keeping every source
character; parsed Markdown retains normal typography. In the
[focused follow-up on cfd0e3b](https://github.com/cloveric/tarobot/actions/runs/38119305714),
WebKit passed all **23 cases**, including healthy recovery in **1,300 ms** with
both 1,048,577-character fallback strings retained. Chromium passed **23 cases**
and failed one: the initial `WARM` message in the injected timeout recovery
fixture did not parse within five seconds, before its intended fault injection.
That startup failure remains open; it is not attributed to the CSS change
without further evidence. The same run's unprofiled 5,000-line Chromium journey
passed with input **24 ms**, frame P95 **16.8 ms** and longest task **61 ms**,
including exact ordered line, table, equation and retained-node checks.

Root pre-completion verification after these changes passed **241 test files,
3,844 tests and one skipped test**, including the build. Native App, physical
phone, release-package and complete browser-matrix gates remain separate.

The subsequent [load-recovery investigation](connection-load-recovery-2026-10-11.md)
reproduced healthy connection loss after a stalled UI heartbeat in both engines
and fixed it without changing ordinary timeout limits. The original Markdown
warm-up failure came from shortening every parse timer in the timeout fixture;
acceleration now applies only to the deliberately held request. A separate
native Base64 decoder improves large local Gateway replies while retaining the
shared strict validation. The latest root build/suite passed **3,845 tests and
one skipped test**. [Follow-up run 38120503976](https://github.com/cloveric/tarobot/actions/runs/38120503976)
passed all **eight Chromium and seven WebKit cases**, including both large
dashboards, concurrent phone stop, route failover, snapshot recovery and the
5,000-line rendering budget. The complete browser matrix is still a separate
open gate; these focused passes do not replace it.

## Earlier runs and investigation

The complete hosted browser run on `ff6db45` did not pass. Chromium recorded
600 passed, 15 failed and one skipped; Linux WebKit recorded 506 passed,
33 failed and 41 skipped. Those failures remain part of the acceptance record.

Several failures came from tests using controls that the simplified UI had
already moved: group recipients now open through the reply-Bot selector;
conversation reset/clear uses an application confirmation dialog. Reset checks
now require the command to reach the durable Hub history before checking that
the pending queue is empty. Pairing and local-reset fixtures wait for their own
screen to mount before choosing a navigation path. Attachment-limit checks
identify the size limit rather than also matching the draft-persistence hint.
The route identity assertion follows the current localized label.

The Linux WebKit recorder fixture failed before recording: its native
`MediaRecorder` superclass was unavailable. WebKit CI now runs on macOS, keeping
the real encoder and playback assertions. Chromium remains on Linux. This does
not replace iOS microphone, permission, interruption or background acceptance.

[The focused run on 8df8ea5](https://github.com/cloveric/tarobot/actions/runs/38115786895)
covered 15 test files. Chromium recorded 107 passed, one failed and seven
skipped; macOS WebKit recorded 108 passed and seven skipped. The remaining
failure is the initial 301-event catch-up in `message-refresh`: Chromium did
not display `STREAM_START` within 20 seconds. The trace's sidebar had only
reached `HISTORY_126`. The assertion and timeout were not relaxed. Added replay
timings distinguish cache writes from repeated history reads on subsequent runs.

The instrumented isolated run reproduced the Chromium timeout after 76 events;
it had already requested 76 complete-history reads. WebKit completed but read
47,558 history records across 308 calls. `HubConnection` now coalesces UI
invalidation while replaying stored events, publishing committed prefixes and
the final partial batch at `sync.complete`. Disconnect/error state transitions
also publish any committed prefix. Each event's cache write and cursor remain
atomic; live events after synchronization still invalidate immediately. The
regression retains the 20-second limit and also bounds history-read calls.
Verification of this change is tracked separately from the earlier focused run.

[The focused run on 2082e6a](https://github.com/cloveric/tarobot/actions/runs/38116588083)
passed all 52 Chromium cases, including the previously failing 301-event replay.
Its initial catch-up used 14 history reads; the complete streaming/recovery
journey used 20 reads and 4,191 history records. The initial event-cache work
totaled 8,838 ms, within the unchanged 20-second setup assertion.

macOS WebKit passed 51 cases and failed one. Its initial catch-up also used
14 history reads; the complete streaming/recovery journey used 19 reads and
4,100 history records. The remaining failure is the existing large-snapshot
reload case: its outbox retained one entry at the five-second assertion. This
case also failed in the earlier complete matrix; its later layout fix is
recorded above. The
full browser matrix and native/physical-device gates are still open.

Manual local checks with an isolated Hub displayed all 301 messages in both the
production build and Vite preview. The Vite UI reached the final marker 385 ms
after confirming pairing. The `/config` English action also updated the actual
test instance configuration to `en`. These local observations do not establish
the cause of the slower hosted run or clear the full browser regression gate.

The workflow accepts an optional list of browser test filenames for focused
diagnosis. Leaving it empty still runs the full matrix. A focused run is not a
substitute for that matrix, native App acceptance or physical-phone testing.
